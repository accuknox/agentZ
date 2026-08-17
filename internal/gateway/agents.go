package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/scoperesolver"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) resolveAgentAccess(ctx context.Context, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	access := resourceAccess{operation: operation}
	if _, ok := operation.BearerScope(); !ok {
		return access, resourceForbidden(fmt.Errorf("agent operation %q is unknown", operation))
	}
	auth, ok := requestAuthState(ctx)
	if ok && auth.apiKeyID != "" {
		access.workspaceID = auth.workspaceID
		access.namespace = auth.tenantNamespace
		access.authorized = true
		return access, nil
	}
	claims, apiErr := externalWorkspaceClaims(ctx)
	if apiErr != nil {
		return access, apiErr
	}
	if claims.WorkspaceID == "" {
		return access, resourceForbidden(errors.New("agent operations require a Workspace scope"))
	}
	access.claims = claims
	access.workspaceID = claims.WorkspaceID

	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: claims.UserID, OrganizationID: claims.OrganizationID,
	})
	if err != nil {
		return access, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("resolve Agent permissions: %w", err),
		)
	}
	access.effective = effective

	allowed, err := s.agentOperationAllowed(ctx, access, name, operation)
	if err != nil {
		return access, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("resolve Agent access: %w", err),
		)
	}
	if !allowed {
		return access, resourceForbidden(errors.New("effective Agent permission is missing"))
	}

	namespace, owner, apiErr := s.resolveResourceScope(
		ctx, claims, claims.WorkspaceID, "Agent",
	)
	if apiErr != nil {
		return access, apiErr
	}
	access.namespace = namespace
	access.owner = owner
	access.authorized = true
	return access, nil
}

func requireAgentBoundAccess(s *Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			agentName := chi.URLParam(r, "agentName")
			if agentName == "" {
				next.ServeHTTP(w, r)
				return
			}

			operation := authorization.OperationUseSharedAgent
			if strings.HasPrefix(r.URL.Path, "/api/secret/") {
				switch {
				case strings.HasSuffix(r.URL.Path, "/delete"):
					operation = authorization.OperationDeleteSharedSecret
				case r.Method == http.MethodGet || strings.HasSuffix(r.URL.Path, "/watch"):
					operation = authorization.OperationReadSharedSecret
				default:
					operation = authorization.OperationWriteSharedSecret
				}
			}

			access, apiErr := s.resolveAgentAccess(r.Context(), agentName, operation)
			if apiErr != nil {
				writeError(w, r, apiErr)
				return
			}

			auth, ok := requestAuthState(r.Context())
			if !ok {
				writeInternalError(w, r, errors.New("missing request authentication"))
				return
			}
			auth.workspaceID = access.workspaceID
			auth.tenantNamespace = access.namespace
			ctx := context.WithValue(r.Context(), authContextKey{}, auth)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (s *Service) agentOperationAllowed(ctx context.Context, access resourceAccess, name string, operation authorization.Operation) (bool, error) {
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	if operation == authorization.OperationCreateAgent {
		return access.effective.Allows(scope, operation), nil
	}
	if operation == authorization.OperationListAgents || operation == authorization.OperationWatchAgents {
		return access.effective.HasWorkspaceAccess(scope), nil
	}
	if name == "" || !access.effective.HasWorkspaceAccess(scope) {
		return false, nil
	}
	capabilities, err := s.agentCapabilityProjections(ctx, access, name)
	if err != nil {
		return false, err
	}
	capability, ok := capabilities[name]
	if !ok {
		return false, nil
	}
	switch operation {
	case authorization.OperationUpdateAgent:
		return capability.Modify, nil
	case authorization.OperationDeleteAgent:
		return capability.Delete, nil
	case authorization.OperationShareAuthoredAgent,
		authorization.OperationShareNonAuthoredAgent:
		return capability.Share, nil
	case authorization.OperationUseSharedAgent:
		return capability.Use, nil
	case authorization.OperationReadSharedSecret:
		return capability.ReadSecrets, nil
	case authorization.OperationWriteSharedSecret:
		return capability.WriteSecrets, nil
	case authorization.OperationDeleteSharedSecret:
		return capability.DeleteSecrets, nil
	default:
		return false, nil
	}
}

func (s *Service) isAgentOwner(ctx context.Context, claims gatewayClaims, name string) (bool, error) {
	row, err := s.queries.GatewayGetAgentOwner(ctx, gatewaydb.GatewayGetAgentOwnerParams{
		OrganizationID: claims.OrganizationID,
		WorkspaceID:    claims.WorkspaceID,
		AgentName:      name,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.OwnerUserID == claims.UserID, nil
}

// ListAgents handles GET /api/agent.
func (s *Service) ListAgents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListAgentsParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	agentNames := []string{}
	if params.AgentName != nil {
		agentNames = make([]string, 0, len(*params.AgentName))
		for _, name := range *params.AgentName {
			agentName, ok := validAgentName(w, r, name, "agent_name")
			if !ok {
				return
			}
			agentNames = append(agentNames, agentName)
		}
	}

	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	agentNames = usableAgentNames(agentNames, capabilities)
	if len(agentNames) == 0 {
		writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
			Agents:        []gatewayapi.Agent{},
			NextPageToken: "",
		})
		return
	}

	items, next, err := s.listAgentItems(
		r.Context(), ns, agentNames, capabilities, limit, offset,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
		Agents:        items,
		NextPageToken: next,
	})
}

// CreateAgent handles POST /api/agent.
//
//nolint:gocyclo
func (s *Service) CreateAgent(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationCreateAgent)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

	var req gatewayapi.CreateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, fields := validateCreateAgentRequest(req)
	envFields, serr := s.validateAgentSandbox(r.Context(), ns, req.Sandbox)
	fields = append(fields, envFields...)
	if serr != nil {
		writeInternalError(w, r, serr)
		return
	}
	var rawSkills []gatewayapi.ResourceReference
	if req.Skills != nil {
		rawSkills = *req.Skills
	}
	skills, skillFields, err := s.validateSkillRefs(r.Context(), ns, rawSkills)
	fields = append(fields, skillFields...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin Agent creation: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	_, err = q.GatewayLockActiveWorkspace(r.Context(), gatewaydb.GatewayLockActiveWorkspaceParams{
		ID: access.workspaceID, OrganizationID: access.claims.OrganizationID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, resourceForbidden(errors.New("agent creation requires an active Workspace")))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("lock Agent Workspace: %w", err))
		return
	}
	_, err = q.GatewayLockActiveOrganizationMember(
		r.Context(),
		gatewaydb.GatewayLockActiveOrganizationMemberParams{
			UserID: access.claims.UserID, OrganizationID: access.claims.OrganizationID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, resourceForbidden(errors.New("agent creation requires active membership")))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("lock Agent creator membership: %w", err))
		return
	}
	effective, err := authorization.New(q).Resolve(r.Context(), authorization.Subject{
		UserID: access.claims.UserID, OrganizationID: access.claims.OrganizationID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("recheck Agent creation authority: %w", err))
		return
	}
	if !effective.Allows(authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}, authorization.OperationCreateAgent) {
		writeError(w, r, resourceForbidden(errors.New("agent creation authority was revoked")))
		return
	}

	row, err := q.GatewayCreateAgent(r.Context(), gatewaydb.GatewayCreateAgentParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create agent", err))
		return
	}

	_, err = q.GatewayCreateAgentOwner(r.Context(), gatewaydb.GatewayCreateAgentOwnerParams{
		AgentName:      name,
		CreatorUserID:  access.claims.UserID,
		OwnerUserID:    access.claims.UserID,
		WorkspaceID:    access.workspaceID,
		OrganizationID: access.claims.OrganizationID,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create agent owner", err))
		return
	}

	agt := s.agentFromCreateRequest(req, ns, access.owner, name)
	agt.Spec.ResourceAudit = agentzv1alpha1.ResourceAudit{
		CreatedByUserID:      access.claims.UserID,
		LastModifiedByUserID: access.claims.UserID,
	}
	_, err = s.resolver.client.AgentzV1alpha1().Agents(ns).Create(
		r.Context(),
		agt,
		metav1.CreateOptions{},
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("create agent", err))
		return
	}
	err = createAgentEventTrail(r.Context(), q, agentEvent{
		access: access,
		name:   name,
		action: "agent.create",
		after: []gatewayapi.EventTrailField{
			{Field: gatewayapi.EventTrailFieldName, Value: name},
			{Field: gatewayapi.EventTrailFieldUserID, Value: access.claims.UserID},
		},
	})
	if err != nil {
		deleteErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Delete(
			r.Context(), name, metav1.DeleteOptions{},
		)
		if deleteErr != nil && !apierrors.IsNotFound(deleteErr) {
			err = fmt.Errorf("%w; rollback Kubernetes Agent: %v", err, deleteErr)
		}
		writeInternalError(w, r, err)
		return
	}
	if commitErr := tx.Commit(r.Context()); commitErr != nil {
		deleteErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Delete(
			r.Context(), name, metav1.DeleteOptions{},
		)
		err = fmt.Errorf("commit Agent creation: %w", commitErr)
		if deleteErr != nil && !apierrors.IsNotFound(deleteErr) {
			err = fmt.Errorf("commit Agent creation: %w; rollback Kubernetes Agent: %v", commitErr, deleteErr)
		}
		writeInternalError(w, r, err)
		return
	}

	actors, err := s.resourceActors(
		r.Context(), agt.Spec.CreatedByUserID,
		agt.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, gatewayapi.Agent{
		Name:    row.AgentName,
		Sandbox: req.Sandbox,
		Memory: gatewayapi.AgentMemoryConfig{
			Enabled: agt.Spec.Memory.Enabled,
		},
		Skills:         skills,
		CreatedAt:      row.CreatedAt,
		ModifiedAt:     row.UpdatedAt,
		LastActivity:   row.UpdatedAt,
		Status:         gatewayapi.PROGRESSING,
		CreatedBy:      actors[agt.Spec.CreatedByUserID],
		LastModifiedBy: actors[agt.Spec.LastModifiedByUserID],
	})
}

// UpdateAgent handles POST /api/agent/update/{agentName}.
func (s *Service) UpdateAgent(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	var req gatewayapi.UpdateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), name, authorization.OperationUpdateAgent)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

	if fields := validateUpdateAgentRequest(req); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	if req.Sandbox != nil {
		envFields, err := s.validateAgentSandbox(r.Context(), ns, *req.Sandbox)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if len(envFields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				envFields...,
			))
			return
		}
	}
	if req.Skills != nil {
		var skillFields []gatewayapi.FieldError
		_, skillFields, err := s.validateSkillRefs(r.Context(), ns, *req.Skills)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if len(skillFields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				skillFields...,
			))
			return
		}
	}
	if !updateAgentRequestHasChanges(req) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "must include at least one mutable field",
			},
		))
		return
	}

	row, err := s.queries.GatewayGetAgent(r.Context(), gatewaydb.GatewayGetAgentParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get agent", err))
		return
	}

	var before, updated *agentzv1alpha1.Agent
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, getErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Get(
			r.Context(),
			row.AgentName,
			metav1.GetOptions{},
		)
		if getErr != nil {
			return getErr
		}
		before = agt.DeepCopy()
		applyUpdateAgentRequest(agt, req)
		agt.Spec.LastModifiedByUserID = access.claims.UserID
		updated, getErr = s.resolver.client.AgentzV1alpha1().Agents(ns).Update(
			r.Context(),
			agt,
			metav1.UpdateOptions{},
		)
		return getErr
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update agent", err))
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.rollbackAgentUpdate(r.Context(), ns, before)
		writeInternalError(w, r, fmt.Errorf("begin Agent update: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	row, err = q.GatewayTouchAgent(r.Context(), gatewaydb.GatewayTouchAgentParams{
		TenantNamespace: ns,
		AgentName:       name,
		UpdatedAt:       time.Now().UTC(),
	})
	if err != nil {
		s.rollbackAgentUpdate(r.Context(), ns, before)
		writeError(w, r, mapGatewayStoreError("update agent", err))
		return
	}
	err = createAgentEventTrail(r.Context(), q, agentEvent{
		access: access,
		name:   name,
		action: "agent.modify",
		before: agentConfigurationEventTrailFields(name, before),
		after:  agentConfigurationEventTrailFields(name, updated),
	})
	if err != nil {
		s.rollbackAgentUpdate(r.Context(), ns, before)
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.rollbackAgentUpdate(r.Context(), ns, before)
		writeInternalError(w, r, fmt.Errorf("commit Agent update: %w", err))
		return
	}

	status := gatewayapi.PROGRESSING
	if view := statusFromAgent(updated); view != nil {
		status = statusFromView(view)
	}
	actors, err := s.resourceActors(
		r.Context(), updated.Spec.CreatedByUserID,
		updated.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.Agent{
		Name:    row.AgentName,
		Sandbox: resourceReferenceFromCRD(updated.Spec.SandboxRef),
		Memory: gatewayapi.AgentMemoryConfig{
			Enabled: updated.Spec.Memory.Enabled,
		},
		CreatedAt:      row.CreatedAt,
		ModifiedAt:     row.UpdatedAt,
		LastActivity:   row.UpdatedAt,
		Status:         status,
		Skills:         resourceReferencesFromCRD(updated.Spec.Skills),
		CreatedBy:      actors[updated.Spec.CreatedByUserID],
		LastModifiedBy: actors[updated.Spec.LastModifiedByUserID],
	})
}

func (s *Service) rollbackAgentUpdate(ctx context.Context, namespace string, before *agentzv1alpha1.Agent) {
	if before == nil {
		return
	}
	current, err := s.resolver.client.AgentzV1alpha1().Agents(namespace).Get(
		ctx,
		before.Name,
		metav1.GetOptions{},
	)
	if err != nil {
		slog.ErrorContext(ctx, "failed to read Agent for update rollback", "agent", before.Name, "err", err)
		return
	}
	before.ResourceVersion = current.ResourceVersion
	_, err = s.resolver.client.AgentzV1alpha1().Agents(namespace).Update(
		ctx,
		before,
		metav1.UpdateOptions{},
	)
	if err != nil {
		slog.ErrorContext(ctx, "failed to roll back Agent update", "agent", before.Name, "err", err)
	}
}

// DeleteAgent handles DELETE /api/agent/{agentName}.
func (s *Service) DeleteAgent(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationDeleteAgent)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin Agent deletion: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	row, err := q.GatewayGetAgent(r.Context(), gatewaydb.GatewayGetAgentParams{
		TenantNamespace: ns,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get agent", err))
		return
	}
	owner, err := q.GatewayLockAgentOwner(r.Context(), gatewaydb.GatewayLockAgentOwnerParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentNotFound(agentName))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("lock Agent owner: %w", err))
		return
	}
	err = s.resolver.client.AgentzV1alpha1().Agents(ns).Delete(
		r.Context(),
		row.AgentName,
		metav1.DeleteOptions{
			PropagationPolicy: new(metav1.DeletePropagationBackground),
		},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		writeError(w, r, mapKubeHTTPError("delete agent", err))
		return
	}

	if err := s.deleteAgentSecretResources(r.Context(), ns, agentName); err != nil {
		writeError(w, r, mapKubeHTTPError("delete agent secrets", err))
		return
	}

	ownerRows, err := q.GatewayDeleteAgentOwner(r.Context(), gatewaydb.GatewayDeleteAgentOwnerParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("delete agent owner", err))
		return
	}
	if ownerRows != 1 {
		writeError(w, r, agentNotFound(agentName))
		return
	}

	rows, err := q.GatewayDeleteAgent(r.Context(), gatewaydb.GatewayDeleteAgentParams{
		TenantNamespace: ns,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("delete agent", err))
		return
	}
	if rows == 0 {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
			errAgentNotFound,
		))
		return
	}
	err = createAgentEventTrail(r.Context(), q, agentEvent{
		access: access,
		name:   agentName,
		action: "agent.delete",
		before: []gatewayapi.EventTrailField{
			{Field: gatewayapi.EventTrailFieldName, Value: agentName},
			{Field: gatewayapi.EventTrailFieldUserID, Value: owner.OwnerUserID},
		},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit Agent deletion: %w", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetAgentOwner handles GET /api/agent/{agentName}/owner.
func (s *Service) GetAgentOwner(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetAgentOwner(r.Context(), gatewaydb.GatewayGetAgentOwnerParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentNotFound(agentName))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get Agent owner: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, agentOwnerResponse(row))
}

// TransferAgentOwner handles PUT /api/agent/{agentName}/owner.
func (s *Service) TransferAgentOwner(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}

	var req gatewayapi.TransferAgentOwnerRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if strings.TrimSpace(req.OwnerUserId) == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "owner_user_id", Message: "required"},
		))
		return
	}

	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	owner, err := s.isAgentOwner(r.Context(), access.claims, agentName)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve Agent owner: %w", err))
		return
	}
	if !owner && !access.effective.CanAdminister(scope) {
		writeError(w, r, resourceForbidden(errors.New("agent ownership transfer requires owner or administrator authority")))
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin Agent owner transfer: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	_, err = q.GatewayLockActiveWorkspace(r.Context(), gatewaydb.GatewayLockActiveWorkspaceParams{
		ID: access.workspaceID, OrganizationID: access.claims.OrganizationID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, resourceForbidden(errors.New("agent ownership transfer requires an active Workspace")))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("lock Agent Workspace: %w", err))
		return
	}
	_, err = q.GatewayLockActiveOrganizationMember(
		r.Context(),
		gatewaydb.GatewayLockActiveOrganizationMemberParams{
			UserID: req.OwnerUserId, OrganizationID: access.claims.OrganizationID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, resourceForbidden(errors.New("new owner requires active membership")))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("lock new Agent owner membership: %w", err))
		return
	}

	effective, err := authorization.New(q).Resolve(r.Context(), authorization.Subject{
		UserID: req.OwnerUserId, OrganizationID: access.claims.OrganizationID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve new Agent owner permissions: %w", err))
		return
	}
	hasWorkspace := effective.HasWorkspaceAccess(scope)
	canCreate := effective.Allows(scope, authorization.OperationCreateAgent)
	if !hasWorkspace || !canCreate {
		writeError(w, r, resourceForbidden(errors.New("new owner requires independent Workspace access and Agent Author")))
		return
	}

	previous, err := q.GatewayLockAgentOwner(r.Context(), gatewaydb.GatewayLockAgentOwnerParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentNotFound(agentName))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get Agent owner before transfer: %w", err))
		return
	}
	if previous.OwnerUserID != access.claims.UserID && !access.effective.CanAdminister(scope) {
		writeError(w, r, resourceForbidden(errors.New("agent ownership changed before transfer")))
		return
	}

	row, err := q.GatewayTransferAgentOwner(r.Context(), gatewaydb.GatewayTransferAgentOwnerParams{
		UpdatedAt:   pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		WorkspaceID: access.workspaceID, AgentName: agentName,
		OrganizationID: access.claims.OrganizationID, OwnerUserID: req.OwnerUserId,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentNotFound(agentName))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("transfer Agent owner: %w", err))
		return
	}
	err = createAgentEventTrail(r.Context(), q, agentEvent{
		access: access,
		name:   agentName,
		action: "agent.owner.transfer",
		before: []gatewayapi.EventTrailField{
			{Field: gatewayapi.EventTrailFieldName, Value: agentName},
			{Field: gatewayapi.EventTrailFieldUserID, Value: previous.OwnerUserID},
		},
		after: []gatewayapi.EventTrailField{
			{Field: gatewayapi.EventTrailFieldName, Value: agentName},
			{Field: gatewayapi.EventTrailFieldUserID, Value: row.OwnerUserID},
		},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit Agent owner transfer: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, agentOwnerResponse(row))
}

// ListAgentShares handles GET /api/agent/{agentName}/share.
type agentShareAuthority uint8

const (
	agentShareDenied agentShareAuthority = iota
	agentShareOwn
	agentShareAll
)

func (s *Service) ListAgentShares(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListAgentSharesParams) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}

	authority, err := s.resolveAgentShareAuthority(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if authority == agentShareDenied {
		writeError(w, r, resourceForbidden(errors.New("agent Share authority is missing")))
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeAgentSharePageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	shares, next, err := s.agentShares(r.Context(), agentShareQuery{
		access:    access,
		agentName: agentName,
		manageAll: authority == agentShareAll,
		cursor:    cursor,
		cursorSet: cursorSet,
		limit:     limit,
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListAgentSharesResponse{
		NextPageToken: next,
		Shares:        shares,
	})
}

// ListAgentAccessTargets handles GET /api/agent/{agentName}/access-targets.
func (s *Service) ListAgentAccessTargets(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}
	projections, err := s.agentCapabilityProjections(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	capabilities, ok := projections[agentName]
	if !ok || (!capabilities.Share && !capabilities.ManageOwnership) {
		writeError(w, r, resourceForbidden(errors.New("agent access management authority is missing")))
		return
	}
	owner, err := s.queries.GatewayGetAgentOwner(
		r.Context(),
		gatewaydb.GatewayGetAgentOwnerParams{
			OrganizationID: access.claims.OrganizationID,
			WorkspaceID:    access.workspaceID,
			AgentName:      agentName,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve Agent Share exclusions: %w", err))
		return
	}

	workspaceID := pgtype.Text{String: access.workspaceID, Valid: true}
	rows, err := s.queries.GatewayListAgentAccessTargets(
		r.Context(),
		gatewaydb.GatewayListAgentAccessTargetsParams{
			WorkspaceID:    workspaceID,
			OrganizationID: access.claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list Agent Share targets: %w", err))
		return
	}

	targetRows := make(map[string]gatewaydb.GatewayListAgentAccessTargetsRow, len(rows))
	targetActions := make(map[string][]gatewaydb.PermissionAction, len(rows))
	for _, row := range rows {
		key := row.Kind + "\x00" + row.ID
		targetRows[key] = row
		if row.Action.Valid {
			targetActions[key] = append(
				targetActions[key], row.Action.PermissionAction,
			)
		}
	}
	shareCapabilities := []gatewaydb.AgentShareCapability{
		gatewaydb.AgentShareCapabilityUseShared,
		gatewaydb.AgentShareCapabilityShareNonAuthored,
		gatewaydb.AgentShareCapabilityReadSharedSecret,
		gatewaydb.AgentShareCapabilityWriteSharedSecret,
		gatewaydb.AgentShareCapabilityDeleteSharedSecret,
	}
	targets := make([]gatewayapi.AgentAccessTarget, 0, len(targetRows))
	for key, row := range targetRows {
		var kind gatewayapi.AgentAccessTargetKind
		switch row.Kind {
		case "user":
			kind = gatewayapi.AgentAccessTargetKindUser
		case "team":
			kind = gatewayapi.AgentAccessTargetKindTeam
		default:
			writeInternalError(w, r, fmt.Errorf("unknown Agent Share target kind %q", row.Kind))
			return
		}
		capabilities := make([]gatewayapi.AgentShareCapability, 0, len(shareCapabilities))
		excludedFromSharing := kind == gatewayapi.AgentAccessTargetKindUser &&
			(row.ID == access.claims.UserID || row.ID == owner.OwnerUserID)
		for _, capability := range shareCapabilities {
			if excludedFromSharing {
				break
			}
			eligible, err := authorization.CanReceiveAgentShare(
				access.workspaceID, targetActions[key], row.Administrator,
				[]gatewaydb.AgentShareCapability{capability},
			)
			if err != nil {
				writeInternalError(w, r, fmt.Errorf("resolve Agent Share target capabilities: %w", err))
				return
			}
			if eligible {
				apiCapability, known := agentShareAPICapability(capability)
				if !known {
					writeInternalError(w, r, fmt.Errorf("unknown Agent Share capability %q", capability))
					return
				}
				capabilities = append(capabilities, apiCapability)
			}
		}
		canOwn := kind == gatewayapi.AgentAccessTargetKindUser &&
			(row.Administrator || slices.Contains(
				targetActions[key], gatewaydb.PermissionActionAuthor,
			))
		target := gatewayapi.AgentAccessTarget{
			CanOwn: canOwn, Capabilities: capabilities, Id: row.ID,
			Kind: kind, Label: row.Label,
		}
		if kind == gatewayapi.AgentAccessTargetKindUser {
			target.Email = &row.Email
		}
		if row.Image.Valid {
			target.Image = &row.Image.String
		}
		targets = append(targets, target)
	}
	slices.SortFunc(targets, func(a, b gatewayapi.AgentAccessTarget) int {
		if a.Kind < b.Kind {
			return -1
		}
		if a.Kind > b.Kind {
			return 1
		}
		if label := strings.Compare(a.Label, b.Label); label != 0 {
			return label
		}
		return strings.Compare(a.Id, b.Id)
	})
	writeJSON(w, http.StatusOK, gatewayapi.ListAgentAccessTargetsResponse{Targets: targets})
}

// UpsertAgentShare handles POST /api/agent/{agentName}/share.
func (s *Service) UpsertAgentShare(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}

	var req gatewayapi.UpsertAgentShareRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	targetUser, targetTeam, fields := validateAgentShareTarget(req, access.claims.UserID)
	caps, capFields := agentShareCapabilities(req.Capabilities)
	fields = append(fields, capFields...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	authority, err := s.resolveAgentShareAuthority(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if authority == agentShareDenied {
		writeError(w, r, resourceForbidden(errors.New("agent Share authority is missing")))
		return
	}
	if targetTeam.Valid {
		exists, err := s.queries.GatewayTeamExists(r.Context(), gatewaydb.GatewayTeamExistsParams{
			TeamID: targetTeam.String, OrganizationID: access.claims.OrganizationID,
		})
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("resolve Agent Share Team: %w", err))
			return
		}
		if !exists {
			writeError(w, r, resourceForbidden(errors.New("agent Share Team does not exist in this Organisation")))
			return
		}
	}
	eligible, err := s.recipientCanUseAgent(r.Context(), agentShareRecipient{
		organizationID: access.claims.OrganizationID,
		workspaceID:    access.workspaceID,
		user:           targetUser,
		team:           targetTeam,
		capabilities:   caps,
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !eligible {
		message := "recipient is not eligible for requested Agent Share capabilities"
		if targetTeam.Valid {
			message = "team is not eligible for requested Agent Share capabilities"
		}
		cause := errors.New(message)
		writeError(w, r, resourceForbidden(cause))
		return
	}

	row, err := s.createAgentShare(r.Context(), agentShareMutation{
		access:       access,
		agentName:    agentName,
		targetUser:   targetUser,
		targetTeam:   targetTeam,
		capabilities: caps,
	})
	if err != nil {
		if errors.Is(err, errAgentShareOwnerTarget) {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				err.Error(),
				errBadRequest,
				gatewayapi.FieldError{Field: "target_user_id", Message: err.Error()},
			))
			return
		}
		issuedByOther := errors.Is(err, errAgentShareIssuedByOther)
		authorityRevoked := errors.Is(err, errAgentShareAuthorityRevoked)
		if issuedByOther || authorityRevoked {
			writeError(w, r, resourceForbidden(err))
			return
		}
		writeError(w, r, mapGatewayStoreError("create Agent Share", err))
		return
	}
	writeJSON(w, http.StatusOK, row)
}

// DeleteAgentShare handles DELETE /api/agent/{agentName}/share/{shareId}.
func (s *Service) DeleteAgentShare(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, shareID gatewayapi.AgentShareIDPath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName)
	if !ok {
		return
	}
	shareID = strings.TrimSpace(shareID)
	if shareID == "" {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "shareId is required", errBadRequest))
		return
	}

	share, err := s.agentShareByID(r.Context(), access, agentName, shareID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentShareNotFound(shareID))
		return
	}
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	authority, err := s.resolveAgentShareAuthority(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	denied := authority == agentShareDenied
	wrongOwner := authority == agentShareOwn && share.CreatedBy != access.claims.UserID
	if denied || wrongOwner {
		writeError(w, r, resourceForbidden(errors.New("agent Share delete authority is missing")))
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin Agent Share delete: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	rows, err := q.GatewayDeleteAgentShare(r.Context(), gatewaydb.GatewayDeleteAgentShareParams{
		ID: shareID, OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("delete Agent Share: %w", err))
		return
	}
	if rows == 0 {
		writeError(w, r, agentShareNotFound(shareID))
		return
	}
	err = createAgentEventTrail(r.Context(), q, agentEvent{
		access: access,
		name:   agentName,
		action: "agent.share.delete",
		before: agentShareEventTrailFields(agentName, share),
		after:  []gatewayapi.EventTrailField{{Field: gatewayapi.EventTrailFieldName, Value: agentName}},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit Agent Share delete: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// WatchAgents handles POST /api/agent/watch.
//
//nolint:gocyclo
func (s *Service) WatchAgents(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationWatchAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

	var req gatewayapi.WatchAgentsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}

	agentNames := []string{}
	agentFilter := map[string]struct{}{}
	if req.AgentNames != nil {
		agentNames = make([]string, 0, len(*req.AgentNames))
		for _, name := range *req.AgentNames {
			agentName, ok := validAgentName(w, r, name, "agent_names")
			if !ok {
				return
			}
			agentNames = append(agentNames, agentName)
			agentFilter[agentName] = struct{}{}
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"streaming is unavailable",
			nil,
		))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := make(map[string]gatewayapi.Agent)
	send := func(event string, items []gatewayapi.Agent) bool {
		if len(items) == 0 {
			return true
		}
		raw, err := json.Marshal(gatewayapi.WatchAgentsEvent{Agents: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if event != "" {
			if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	events, cancel := s.resolver.watchAgents()
	defer cancel()

	writeChanges := func() bool {
		capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		names := append([]string(nil), agentNames...)
		names = usableAgentNames(names, capabilities)
		if len(names) == 0 {
			return send("", []gatewayapi.Agent{})
		}
		items, _, err := s.listAgentItems(
			r.Context(), ns, names, capabilities, 200, 0,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		changed := make([]gatewayapi.Agent, 0, len(items))
		for _, item := range items {
			prevItem, ok := prev[item.Name]
			unchanged := ok &&
				prevItem.Name == item.Name &&
				prevItem.Sandbox == item.Sandbox &&
				prevItem.Memory == item.Memory &&
				prevItem.LastActivity.Equal(item.LastActivity) &&
				prevItem.CreatedAt.Equal(item.CreatedAt) &&
				prevItem.ModifiedAt.Equal(item.ModifiedAt) &&
				prevItem.Status == item.Status &&
				prevItem.Capabilities == item.Capabilities &&
				prevItem.CreatedBy.Id == item.CreatedBy.Id &&
				prevItem.LastModifiedBy.Id == item.LastModifiedBy.Id &&
				slices.Equal(prevItem.Skills, item.Skills)
			if unchanged {
				continue
			}
			prev[item.Name] = item
			changed = append(changed, item)
		}
		return send("", changed)
	}

	if !writeChanges() {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == agentWatchEventDeleted {
				if evt.Agent == nil || evt.Agent.Namespace != ns {
					continue
				}
				if len(agentFilter) > 0 {
					if _, ok := agentFilter[evt.Agent.Name]; !ok {
						continue
					}
				}

				item, ok := prev[evt.Agent.Name]
				delete(prev, evt.Agent.Name)
				if ok {
					item.Status = gatewayapi.DELETED
				}
				if ok && !send("DELETE", []gatewayapi.Agent{item}) {
					return
				}
				continue
			}
			if !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) agentCapabilityProjections(ctx context.Context, access resourceAccess, agentName string) (map[string]gatewayapi.AgentCapabilities, error) {
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	rows, err := s.queries.GatewayListAgentRelationships(ctx, gatewaydb.GatewayListAgentRelationshipsParams{
		UserID:         pgtype.Text{String: access.claims.UserID, Valid: true},
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      pgtype.Text{String: agentName, Valid: agentName != ""},
	})
	if err != nil {
		return nil, fmt.Errorf("list Agent authorization relationships: %w", err)
	}
	relationships := make(map[string]authorization.Agent, len(rows))
	for _, row := range rows {
		relationship := relationships[row.AgentName]
		relationship.Name = row.AgentName
		relationship.OwnerUserID = row.OwnerUserID
		if row.Capability.Valid {
			relationship.ShareGrants = append(
				relationship.ShareGrants,
				row.Capability.AgentShareCapability,
			)
		}
		relationships[row.AgentName] = relationship
	}
	projections := make(map[string]gatewayapi.AgentCapabilities, len(relationships))
	for name, relationship := range relationships {
		capabilities, err := access.effective.AgentCapabilities(scope, relationship)
		if err != nil {
			return nil, fmt.Errorf("resolve Agent %q capabilities: %w", name, err)
		}
		projections[name] = gatewayapi.AgentCapabilities{
			Delete:          capabilities.Delete,
			DeleteSecrets:   capabilities.DeleteSecrets,
			ManageOwnership: capabilities.ManageOwnership,
			Modify:          capabilities.Modify,
			ReadSecrets:     capabilities.ReadSecrets,
			Share:           capabilities.Share,
			Use:             capabilities.Use,
			WriteSecrets:    capabilities.WriteSecrets,
		}
	}
	return projections, nil
}

func usableAgentNames(selected []string, capabilities map[string]gatewayapi.AgentCapabilities) []string {
	if len(selected) > 0 {
		return slices.DeleteFunc(selected, func(name string) bool {
			return !capabilities[name].Use
		})
	}

	names := make([]string, 0, len(capabilities))
	for name, capability := range capabilities {
		if capability.Use {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

func (s *Service) resolveNamedAgent(w http.ResponseWriter, r *http.Request, raw string) (string, resourceAccess, bool) {
	name, ok := validAgentName(w, r, raw, "agentName")
	if !ok {
		return "", resourceAccess{}, false
	}
	access, apiErr := s.resolveAgentAccess(
		r.Context(), name, authorization.OperationUseSharedAgent,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return "", resourceAccess{}, false
	}
	return name, access, true
}

type agentShareRecipient struct {
	organizationID string
	workspaceID    string
	user           pgtype.Text
	team           pgtype.Text
	capabilities   []gatewaydb.AgentShareCapability
}

func (s *Service) recipientCanUseAgent(ctx context.Context, recipient agentShareRecipient) (bool, error) {
	if recipient.user.Valid {
		active, err := s.queries.GatewayIsActiveOrganizationMember(ctx, gatewaydb.GatewayIsActiveOrganizationMemberParams{
			UserID: recipient.user.String, OrganizationID: recipient.organizationID,
		})
		if err != nil || !active {
			return false, err
		}
		effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
			UserID: recipient.user.String, OrganizationID: recipient.organizationID,
		})
		if err != nil {
			return false, fmt.Errorf("resolve Agent Share recipient access: %w", err)
		}
		scope := authorization.Scope{
			OrganizationID: recipient.organizationID,
			WorkspaceID:    recipient.workspaceID,
		}
		return effective.CanReceiveAgentShare(scope, recipient.capabilities)
	}

	granted, err := s.queries.GatewayListTeamAgentShareCapabilities(
		ctx,
		gatewaydb.GatewayListTeamAgentShareCapabilitiesParams{
			OrganizationID: recipient.organizationID,
			WorkspaceID:    pgtype.Text{String: recipient.workspaceID, Valid: true},
			TeamID:         recipient.team.String,
		},
	)
	if err != nil {
		return false, fmt.Errorf("resolve Team Agent Share capabilities: %w", err)
	}

	return authorization.CanReceiveAgentShare(recipient.workspaceID, granted, false, recipient.capabilities)
}

func (s *Service) resolveAgentShareAuthority(ctx context.Context, access resourceAccess, agentName string) (agentShareAuthority, error) {
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	if access.effective.CanAdminister(scope) {
		return agentShareAll, nil
	}
	owner, err := s.isAgentOwner(ctx, access.claims, agentName)
	if err != nil {
		return agentShareDenied, fmt.Errorf("resolve Agent owner: %w", err)
	}
	if owner {
		if access.effective.Allows(scope, authorization.OperationShareAuthoredAgent) {
			return agentShareAll, nil
		}
		return agentShareDenied, nil
	}
	allowed, err := s.agentOperationAllowed(
		ctx, access, agentName, authorization.OperationShareNonAuthoredAgent,
	)
	if err != nil || !allowed {
		return agentShareDenied, err
	}
	return agentShareOwn, nil
}

func validateAgentShareTarget(req gatewayapi.UpsertAgentShareRequest, actorUserID string) (pgtype.Text, pgtype.Text, []gatewayapi.FieldError) {
	fields := []gatewayapi.FieldError{}
	targetUser := pgtype.Text{}
	targetTeam := pgtype.Text{}
	if req.TargetUserId != nil {
		targetUser.String = strings.TrimSpace(*req.TargetUserId)
		targetUser.Valid = targetUser.String != ""
	}
	if req.TargetTeamId != nil {
		targetTeam.String = strings.TrimSpace(*req.TargetTeamId)
		targetTeam.Valid = targetTeam.String != ""
	}
	if targetUser.Valid == targetTeam.Valid {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "target",
			Message: "provide exactly one of target_user_id or target_team_id",
		})
	}
	if targetUser.Valid && targetUser.String == actorUserID {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "target_user_id",
			Message: "you cannot share an Agent with yourself",
		})
	}
	return targetUser, targetTeam, fields
}

func agentShareCapabilities(caps []gatewayapi.AgentShareCapability) ([]gatewaydb.AgentShareCapability, []gatewayapi.FieldError) {
	if len(caps) == 0 {
		return nil, []gatewayapi.FieldError{{
			Field: "capabilities", Message: "at least one capability is required",
		}}
	}

	out := make([]gatewaydb.AgentShareCapability, 0, len(caps))
	seen := map[gatewaydb.AgentShareCapability]struct{}{}
	for _, cap := range caps {
		dbCap, ok := agentShareDBCapability(cap)
		if !ok {
			return nil, []gatewayapi.FieldError{{
				Field: "capabilities", Message: "contains an unknown capability",
			}}
		}
		if _, ok := seen[dbCap]; ok {
			continue
		}
		seen[dbCap] = struct{}{}
		out = append(out, dbCap)
	}
	return out, nil
}

func agentShareDBCapability(cap gatewayapi.AgentShareCapability) (gatewaydb.AgentShareCapability, bool) {
	switch cap {
	case gatewayapi.AgentShareCapabilityUseShared:
		return gatewaydb.AgentShareCapabilityUseShared, true
	case gatewayapi.AgentShareCapabilityShareNonAuthored:
		return gatewaydb.AgentShareCapabilityShareNonAuthored, true
	case gatewayapi.AgentShareCapabilityReadSharedSecret:
		return gatewaydb.AgentShareCapabilityReadSharedSecret, true
	case gatewayapi.AgentShareCapabilityWriteSharedSecret:
		return gatewaydb.AgentShareCapabilityWriteSharedSecret, true
	case gatewayapi.AgentShareCapabilityDeleteSharedSecret:
		return gatewaydb.AgentShareCapabilityDeleteSharedSecret, true
	default:
		return "", false
	}
}

func agentShareAPICapability(cap gatewaydb.AgentShareCapability) (gatewayapi.AgentShareCapability, bool) {
	switch cap {
	case gatewaydb.AgentShareCapabilityUseShared:
		return gatewayapi.AgentShareCapabilityUseShared, true
	case gatewaydb.AgentShareCapabilityShareNonAuthored:
		return gatewayapi.AgentShareCapabilityShareNonAuthored, true
	case gatewaydb.AgentShareCapabilityReadSharedSecret:
		return gatewayapi.AgentShareCapabilityReadSharedSecret, true
	case gatewaydb.AgentShareCapabilityWriteSharedSecret:
		return gatewayapi.AgentShareCapabilityWriteSharedSecret, true
	case gatewaydb.AgentShareCapabilityDeleteSharedSecret:
		return gatewayapi.AgentShareCapabilityDeleteSharedSecret, true
	default:
		return "", false
	}
}

var (
	errAgentShareAuthorityRevoked = errors.New("agent Share authority was revoked")
	errAgentShareIssuedByOther    = errors.New("delegated sharers cannot replace shares issued by another user")
	errAgentShareOwnerTarget      = errors.New("the Agent Owner cannot receive an Agent Share")
)

type agentShareMutation struct {
	access       resourceAccess
	agentName    string
	targetUser   pgtype.Text
	targetTeam   pgtype.Text
	capabilities []gatewaydb.AgentShareCapability
}

func (s *Service) createAgentShare(ctx context.Context, request agentShareMutation) (gatewayapi.AgentShare, error) {
	access := request.access
	agentName := request.agentName
	targetUser := request.targetUser
	targetTeam := request.targetTeam
	caps := request.capabilities

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("begin Agent Share transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	q := gatewaydb.New(tx)
	_, err = q.GatewayLockActiveWorkspace(ctx, gatewaydb.GatewayLockActiveWorkspaceParams{
		ID: access.workspaceID, OrganizationID: access.claims.OrganizationID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return gatewayapi.AgentShare{}, errAgentShareAuthorityRevoked
	}
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("lock Agent Share Workspace: %w", err)
	}
	if targetTeam.Valid {
		_, err = q.GatewayLockTeam(ctx, gatewaydb.GatewayLockTeamParams{
			TeamID: targetTeam.String, OrganizationID: access.claims.OrganizationID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return gatewayapi.AgentShare{}, errAgentShareAuthorityRevoked
		}
		if err != nil {
			return gatewayapi.AgentShare{}, fmt.Errorf("lock Agent Share Team: %w", err)
		}
	}
	_, err = q.GatewayLockActiveOrganizationMember(
		ctx,
		gatewaydb.GatewayLockActiveOrganizationMemberParams{
			UserID: access.claims.UserID, OrganizationID: access.claims.OrganizationID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return gatewayapi.AgentShare{}, errAgentShareAuthorityRevoked
	}
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("lock Agent Share actor: %w", err)
	}
	owner, err := q.GatewayLockAgentOwner(ctx, gatewaydb.GatewayLockAgentOwnerParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return gatewayapi.AgentShare{}, errAgentShareAuthorityRevoked
	}
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("lock Agent Share owner: %w", err)
	}
	if targetUser.Valid && targetUser.String == owner.OwnerUserID {
		return gatewayapi.AgentShare{}, errAgentShareOwnerTarget
	}
	shares, err := q.GatewayLockAgentShares(ctx, gatewaydb.GatewayLockAgentSharesParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("lock Agent Shares: %w", err)
	}
	effective, err := authorization.New(q).Resolve(ctx, authorization.Subject{
		UserID: access.claims.UserID, OrganizationID: access.claims.OrganizationID,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("recheck Agent Share authority: %w", err)
	}
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	relationships, err := q.GatewayListAgentRelationships(
		ctx,
		gatewaydb.GatewayListAgentRelationshipsParams{
			UserID:         pgtype.Text{String: access.claims.UserID, Valid: true},
			OrganizationID: access.claims.OrganizationID,
			WorkspaceID:    access.workspaceID,
			AgentName:      pgtype.Text{String: agentName, Valid: true},
		},
	)
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("recheck Agent Share relationships: %w", err)
	}
	relationship := authorization.Agent{
		Name: agentName, OwnerUserID: owner.OwnerUserID,
	}
	for _, row := range relationships {
		if row.Capability.Valid {
			relationship.ShareGrants = append(
				relationship.ShareGrants,
				row.Capability.AgentShareCapability,
			)
		}
	}
	actorCapabilities, err := effective.AgentCapabilities(scope, relationship)
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("recheck Agent Share policy: %w", err)
	}
	if !actorCapabilities.Share || !actorCapabilities.CoversShare(caps) {
		return gatewayapi.AgentShare{}, errAgentShareAuthorityRevoked
	}
	manageAll := effective.CanAdminister(scope) || owner.OwnerUserID == access.claims.UserID
	for _, share := range shares {
		sameUser := targetUser.Valid && share.TargetUserID.Valid &&
			targetUser.String == share.TargetUserID.String
		sameTeam := targetTeam.Valid && share.TargetTeamID.Valid &&
			targetTeam.String == share.TargetTeamID.String
		if !sameUser && !sameTeam {
			continue
		}
		if !manageAll && share.CreatedBy != access.claims.UserID {
			return gatewayapi.AgentShare{}, errAgentShareIssuedByOther
		}
		if _, err := q.GatewayDeleteAgentShare(ctx, gatewaydb.GatewayDeleteAgentShareParams{
			ID: share.ID, OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
		}); err != nil {
			return gatewayapi.AgentShare{}, fmt.Errorf("replace Agent Share: %w", err)
		}
	}

	row, err := q.GatewayCreateAgentShare(ctx, gatewaydb.GatewayCreateAgentShareParams{
		ID: "agent-share-" + uuid.NewString(), CreatedBy: access.claims.UserID,
		TargetUserID: targetUser, TargetTeamID: targetTeam,
		OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
		AgentName: agentName,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("create Agent Share: %w", err)
	}
	for _, cap := range caps {
		if _, err := q.GatewayAddAgentShareGrant(ctx, gatewaydb.GatewayAddAgentShareGrantParams{
			Capability: cap, ShareID: row.ID,
			OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
		}); err != nil {
			return gatewayapi.AgentShare{}, fmt.Errorf("add Agent Share grant: %w", err)
		}
	}
	err = createAgentEventTrail(ctx, q, agentEvent{
		access: access,
		name:   agentName,
		action: "agent.share.upsert",
		after:  agentShareEventTrailFields(agentName, row),
	})
	if err != nil {
		return gatewayapi.AgentShare{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("commit Agent Share: %w", err)
	}
	return s.agentShareResponse(ctx, access, row)
}

type agentShareQuery struct {
	access    resourceAccess
	agentName string
	manageAll bool
	cursor    agentSharePageCursor
	cursorSet bool
	limit     int
}

func (s *Service) agentShares(ctx context.Context, query agentShareQuery) ([]gatewayapi.AgentShare, string, error) {
	rows, err := s.queries.GatewayListAgentShares(ctx, gatewaydb.GatewayListAgentSharesParams{
		OrganizationID: query.access.claims.OrganizationID,
		WorkspaceID:    query.access.workspaceID,
		AgentName:      query.agentName,
		ManageAll:      query.manageAll,
		UserID:         query.access.claims.UserID,
		CursorSet:      query.cursorSet,
		CursorCreatedAt: pgtype.Timestamptz{
			Time:  query.cursor.CreatedAt,
			Valid: query.cursorSet,
		},
		CursorID: query.cursor.ID,
		PageSize: int32(query.limit + 1),
	})
	if err != nil {
		return nil, "", fmt.Errorf("list Agent Shares: %w", err)
	}
	next := ""
	if len(rows) > query.limit {
		rows = rows[:query.limit]
		last := rows[len(rows)-1]
		next = encodeCursorPageToken(agentSharePageCursor{
			CreatedAt: last.CreatedAt.Time,
			ID:        last.ID,
		})
	}
	out := make([]gatewayapi.AgentShare, 0, len(rows))
	for _, row := range rows {
		item, err := s.agentShareResponse(ctx, query.access, row)
		if err != nil {
			return nil, "", err
		}
		out = append(out, item)
	}
	return out, next, nil
}

func (s *Service) agentShareByID(ctx context.Context, access resourceAccess, agentName string, shareID string) (gatewaydb.AgentShare, error) {
	row, err := s.queries.GatewayGetAgentShare(ctx, gatewaydb.GatewayGetAgentShareParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
		ID:             shareID,
	})
	if err != nil {
		return gatewaydb.AgentShare{}, fmt.Errorf("get Agent Share: %w", err)
	}
	return row, nil
}

func (s *Service) agentShareResponse(ctx context.Context, access resourceAccess, row gatewaydb.AgentShare) (gatewayapi.AgentShare, error) {
	grants, err := s.queries.GatewayListAgentShareGrants(ctx, gatewaydb.GatewayListAgentShareGrantsParams{
		ShareID: row.ID, OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("list Agent Share grants: %w", err)
	}
	caps := make([]gatewayapi.AgentShareCapability, 0, len(grants))
	for _, grant := range grants {
		cap, ok := agentShareAPICapability(grant.Capability)
		if !ok {
			return gatewayapi.AgentShare{}, fmt.Errorf("unknown Agent Share capability %q", grant.Capability)
		}
		caps = append(caps, cap)
	}
	item := gatewayapi.AgentShare{
		Id: row.ID, AgentName: row.AgentName, CreatedBy: row.CreatedBy,
		Capabilities: caps, CreatedAt: row.CreatedAt.Time,
	}
	if row.TargetUserID.Valid {
		item.TargetUserId = &row.TargetUserID.String
	}
	if row.TargetTeamID.Valid {
		item.TargetTeamId = &row.TargetTeamID.String
	}
	return item, nil
}

type agentEvent struct {
	access resourceAccess
	name   string
	action string
	before []gatewayapi.EventTrailField
	after  []gatewayapi.EventTrailField
}

func createAgentEventTrail(ctx context.Context, q gatewaydb.Querier, event agentEvent) error {
	if event.before == nil {
		event.before = []gatewayapi.EventTrailField{}
	}
	if event.after == nil {
		event.after = []gatewayapi.EventTrailField{}
	}
	beforeJSON, err := json.Marshal(event.before)
	if err != nil {
		return fmt.Errorf("encode Agent event trail before state: %w", err)
	}
	afterJSON, err := json.Marshal(event.after)
	if err != nil {
		return fmt.Errorf("encode Agent event trail after state: %w", err)
	}
	params := gatewaydb.GatewayCreateEventTrailEventParams{
		ID:             "event-trail-" + uuid.NewString(),
		OrganizationID: event.access.claims.OrganizationID,
		WorkspaceID:    pgtype.Text{String: event.access.workspaceID, Valid: event.access.workspaceID != ""},
		ActorType:      gatewaydb.EventTrailActorUser,
		ActorID:        pgtype.Text{String: event.access.claims.UserID, Valid: true},
		TargetType:     gatewaydb.EventTrailTargetAgent,
		TargetID:       event.name,
		Category:       "agent",
		Action:         event.action,
		Result:         gatewaydb.EventTrailResultSucceeded,
		Before:         beforeJSON,
		After:          afterJSON,
	}
	if _, err := q.GatewayCreateEventTrailEvent(ctx, params); err != nil {
		return fmt.Errorf("create Agent event trail event: %w", err)
	}
	return nil
}

func agentConfigurationEventTrailFields(agentName string, agent *agentzv1alpha1.Agent) []gatewayapi.EventTrailField {
	if agent == nil {
		return []gatewayapi.EventTrailField{{Field: gatewayapi.EventTrailFieldName, Value: agentName}}
	}

	skills := make([]string, 0, len(agent.Spec.Skills))
	for _, skill := range agent.Spec.Skills {
		skills = append(skills, string(skill.Scope)+"/"+skill.Name)
	}
	slices.Sort(skills)
	state := fmt.Sprintf(
		"sandbox=%s/%s; memory=%t; skills=%s",
		agent.Spec.SandboxRef.Scope,
		agent.Spec.SandboxRef.Name,
		agent.Spec.Memory.Enabled,
		strings.Join(skills, ","),
	)
	return []gatewayapi.EventTrailField{
		{Field: gatewayapi.EventTrailFieldName, Value: agentName},
		{Field: gatewayapi.EventTrailFieldState, Value: state},
	}
}

func agentShareEventTrailFields(agentName string, share gatewaydb.AgentShare) []gatewayapi.EventTrailField {
	fields := []gatewayapi.EventTrailField{{Field: gatewayapi.EventTrailFieldName, Value: agentName}}
	if share.TargetUserID.Valid {
		fields = append(fields, gatewayapi.EventTrailField{
			Field: gatewayapi.EventTrailFieldUserID, Value: share.TargetUserID.String,
		})
	}
	if share.TargetTeamID.Valid {
		fields = append(fields, gatewayapi.EventTrailField{
			Field: gatewayapi.EventTrailFieldName, Value: "team:" + share.TargetTeamID.String,
		})
	}
	return fields
}

func agentOwnerResponse(row gatewaydb.AgentOwner) gatewayapi.AgentOwner {
	return gatewayapi.AgentOwner{
		AgentName: row.AgentName, CreatorUserId: row.CreatorUserID,
		OwnerUserId: row.OwnerUserID, CreatedAt: row.CreatedAt.Time,
		UpdatedAt: row.UpdatedAt.Time,
	}
}

func agentNotFound(name string) *apiError {
	return newAPIError(
		http.StatusNotFound,
		"not_found",
		"agent not found",
		fmt.Errorf("agent %q not found", name),
	)
}

func agentShareNotFound(id string) *apiError {
	return newAPIError(
		http.StatusNotFound,
		"not_found",
		"Agent Share not found",
		fmt.Errorf("agent Share %q not found", id),
	)
}

func (s *Service) listAgentItems(ctx context.Context, ns string, agentNames []string, capabilities map[string]gatewayapi.AgentCapabilities, limit int, offset int) ([]gatewayapi.Agent, string, error) {
	var rows []gatewaydb.Agent
	var err error
	if len(agentNames) > 0 {
		rows, err = s.queries.GatewayListAgentsByName(ctx, gatewaydb.GatewayListAgentsByNameParams{
			TenantNamespace: ns,
			Column2:         agentNames,
			Limit:           int32(limit + 1),
			Offset:          int32(offset),
		})
	}
	if len(agentNames) == 0 {
		rows, err = s.queries.GatewayListAgents(ctx, gatewaydb.GatewayListAgentsParams{
			TenantNamespace: ns,
			Limit:           int32(limit + 1),
			Offset:          int32(offset),
		})
	}
	if err != nil {
		return nil, "", err
	}

	var next string
	if len(rows) > limit {
		next = encodeOffsetToken(offset + limit)
		rows = rows[:limit]
	}

	agents := make(map[string]*agentzv1alpha1.Agent, len(rows))
	userIDs := make([]string, 0, len(rows)*2)
	for _, row := range rows {
		resolved, resolveErr := s.resolver.resolveAgent(ctx, ns, row.AgentName)
		if resolveErr != nil && !errors.Is(resolveErr, errAgentNotFound) {
			return nil, "", resolveErr
		}
		if resolved == nil || resolved.Agent == nil {
			return nil, "", fmt.Errorf("resolve agent %q: %w", row.AgentName, errAgentNotFound)
		}
		agents[row.AgentName] = resolved.Agent
		userIDs = append(userIDs, resolved.Agent.Spec.CreatedByUserID,
			resolved.Agent.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(ctx, userIDs...)
	if err != nil {
		return nil, "", err
	}

	items := make([]gatewayapi.Agent, 0, len(rows))
	for _, row := range rows {
		agt := agents[row.AgentName]
		items = append(items, gatewayapi.Agent{
			Name:         row.AgentName,
			Sandbox:      resourceReferenceFromCRD(agt.Spec.SandboxRef),
			Capabilities: capabilities[row.AgentName],
			Memory: gatewayapi.AgentMemoryConfig{
				Enabled: agt.Spec.Memory.Enabled,
			},
			LastActivity:   row.UpdatedAt,
			CreatedAt:      row.CreatedAt,
			ModifiedAt:     row.UpdatedAt,
			Status:         statusFromView(statusFromAgent(agt)),
			Skills:         resourceReferencesFromCRD(agt.Spec.Skills),
			CreatedBy:      actors[agt.Spec.CreatedByUserID],
			LastModifiedBy: actors[agt.Spec.LastModifiedByUserID],
		})
	}
	return items, next, nil
}

//nolint:gocyclo
func validateCreateAgentRequest(req gatewayapi.CreateAgentRequest) (string, []gatewayapi.FieldError) {
	fields := []gatewayapi.FieldError{}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: "name", Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); name != "" && len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be a valid DNS label",
		})
	}
	if name == agentzv1alpha1.AgentNameMCPConnection {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "reserved agent name",
		})
	}

	fields = append(fields, validateOpenCodeRequest(req.Opencode)...)

	return name, fields
}

func validateAgentSandboxField(fields []gatewayapi.FieldError, ref gatewayapi.ResourceReference) []gatewayapi.FieldError {
	name := ref.Name
	if name == "" {
		return append(fields, gatewayapi.FieldError{
			Field: "sandbox", Message: "required",
		})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "sandbox", Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "sandbox", Message: "must be a valid DNS label",
		})
	}
	return fields
}

func (s *Service) validateAgentSandbox(ctx context.Context, namespace string, ref gatewayapi.ResourceReference) ([]gatewayapi.FieldError, error) {
	fields := validateAgentSandboxField(nil, ref)
	if len(fields) > 0 {
		return fields, nil
	}

	resourceNamespace, err := scoperesolver.SelectedNamespace(ctx, s.k8sClient, namespace, scoperesolver.Selection{
		Scope: agentzv1alpha1.ResourceScope(ref.Scope),
		Kind:  agentzv1alpha1.OrganizationResourceKindSandbox,
		Name:  ref.Name,
	})
	if err != nil {
		return []gatewayapi.FieldError{{
			Field:   "sandbox.scope",
			Message: "scope cannot be resolved from the active Workspace",
		}}, nil
	}

	var sandbox agentzv1alpha1.Sandbox
	key := types.NamespacedName{Namespace: resourceNamespace, Name: ref.Name}
	if err := s.k8sClient.Get(ctx, key, &sandbox); err != nil {
		if apierrors.IsNotFound(err) {
			return []gatewayapi.FieldError{{
				Field:   "sandbox",
				Message: "sandbox not found",
			}}, nil
		}
		return nil, fmt.Errorf("get sandbox %q: %w", ref.Name, err)
	}
	return nil, nil
}

func (s *Service) agentFromCreateRequest(req gatewayapi.CreateAgentRequest, namespace string, owner metav1.OwnerReference, name string) *agentzv1alpha1.Agent {
	env := []corev1.EnvVar{}
	if req.Env != nil {
		env = envVarsFromMap(*req.Env)
	}
	agt := &agentzv1alpha1.Agent{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Agent",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				labelManagedBy: "agentz-agent-gateway",
			},
			OwnerReferences: []metav1.OwnerReference{
				owner,
			},
		},
		Spec: agentzv1alpha1.AgentSpec{
			Image: s.cfg.AgentImage,
			Env:   env,
			Telemetry: agentzv1alpha1.TelemetryConfig{
				Enabled:       true,
				TraceEndpoint: s.cfg.AgentTraceEndpoint,
			},
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScope(req.Sandbox.Scope),
				Name:  req.Sandbox.Name,
			},
		},
	}
	if req.Skills != nil {
		agt.Spec.Skills = resourceReferencesToCRD(*req.Skills)
	}
	if req.Memory != nil {
		agt.Spec.Memory.Enabled = req.Memory.Enabled
	}
	applyOpencodeRequest(&agt.Spec, req.Opencode)
	return agt
}

func updateAgentRequestHasChanges(req gatewayapi.UpdateAgentRequest) bool {
	if req.Env != nil {
		return true
	}
	if req.Sandbox != nil {
		return true
	}
	if req.Opencode != nil {
		return true
	}
	if req.Memory != nil {
		return true
	}
	if req.Skills != nil {
		return true
	}
	return false
}

func validateUpdateAgentRequest(req gatewayapi.UpdateAgentRequest) []gatewayapi.FieldError {
	return validateOpenCodeRequest(req.Opencode)
}

func applyUpdateAgentRequest(agt *agentzv1alpha1.Agent, req gatewayapi.UpdateAgentRequest) {
	if req.Env != nil {
		agt.Spec.Env = envVarsFromMap(*req.Env)
	}
	if req.Sandbox != nil {
		agt.Spec.SandboxRef = agentzv1alpha1.ResourceReference{
			Scope: agentzv1alpha1.ResourceScope(req.Sandbox.Scope),
			Name:  req.Sandbox.Name,
		}
	}
	if req.Skills != nil {
		agt.Spec.Skills = resourceReferencesToCRD(*req.Skills)
	}
	if req.Memory != nil {
		agt.Spec.Memory.Enabled = req.Memory.Enabled
	}
	applyOpencodeRequest(&agt.Spec, req.Opencode)
}

func resourceReferenceFromCRD(ref agentzv1alpha1.ResourceReference) gatewayapi.ResourceReference {
	return gatewayapi.ResourceReference{
		Scope: gatewayapi.ResourceScope(ref.Scope),
		Name:  ref.Name,
	}
}

func resourceReferencesFromCRD(refs []agentzv1alpha1.ResourceReference) []gatewayapi.ResourceReference {
	out := make([]gatewayapi.ResourceReference, 0, len(refs))
	for _, ref := range refs {
		out = append(out, resourceReferenceFromCRD(ref))
	}
	return out
}

func resourceReferencesToCRD(refs []gatewayapi.ResourceReference) []agentzv1alpha1.ResourceReference {
	out := make([]agentzv1alpha1.ResourceReference, 0, len(refs))
	for _, ref := range refs {
		out = append(out, agentzv1alpha1.ResourceReference{
			Scope: agentzv1alpha1.ResourceScope(ref.Scope),
			Name:  ref.Name,
		})
	}
	return out
}

func envVarsFromMap(items map[string]string) []corev1.EnvVar {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	sandbox := make([]corev1.EnvVar, 0, len(keys))
	for _, key := range keys {
		sandbox = append(sandbox, corev1.EnvVar{Name: key, Value: items[key]})
	}
	return sandbox
}

func validateOpenCodeRequest(cfg *gatewayapi.AgentOpencodeConfig) []gatewayapi.FieldError {
	if cfg == nil {
		return nil
	}

	fields := []gatewayapi.FieldError{}
	if cfg.Instruction != nil && strings.TrimSpace(*cfg.Instruction) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.instruction",
			Message: "instruction must not be empty",
		})
	}
	if cfg.Instruction != nil && len(*cfg.Instruction) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.instruction",
			Message: "instruction must be at most 4096 characters",
		})
	}
	return fields
}

func applyOpencodeRequest(spec *agentzv1alpha1.AgentSpec, cfg *gatewayapi.AgentOpencodeConfig) {
	if cfg == nil {
		return
	}

	if cfg.Instruction != nil {
		spec.Instruction = *cfg.Instruction
	}
}

func statusFromView(view *agentStatusView) gatewayapi.AgentStatus {
	switch view.Phase {
	case agentPhaseReady:
		return gatewayapi.IDLE
	case agentPhaseProgressing:
		return gatewayapi.PROGRESSING
	case agentPhaseDegraded:
		return gatewayapi.DEGRADED
	case agentPhaseNotFound:
		return gatewayapi.UNSPECIFIED
	default:
		return gatewayapi.UNSPECIFIED
	}
}
