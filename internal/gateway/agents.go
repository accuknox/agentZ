package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

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
	claims, apiErr := externalWorkspaceClaims(ctx)
	if apiErr != nil {
		return access, apiErr
	}
	if claims.WorkspaceID == "" {
		return access, resourceForbidden(errors.New("Agent operations require a Workspace scope"))
	}
	access.claims = claims
	access.workspaceID = claims.WorkspaceID

	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: claims.UserID, OrganizationID: claims.TenantID,
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

	scope := authorization.Scope{
		OrganizationID: claims.TenantID,
		WorkspaceID:    claims.WorkspaceID,
	}
	allowed, err := s.agentOperationAllowed(ctx, claims, effective, scope, name, operation)
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

func (s *Service) agentOperationAllowed(ctx context.Context, claims gatewayClaims, effective authorization.Effective, scope authorization.Scope, name string, operation authorization.Operation) (bool, error) {
	if operation == authorization.OperationCreateAgent {
		return effective.Allows(scope, operation), nil
	}
	if operation == authorization.OperationListAgents || operation == authorization.OperationWatchAgents {
		return effective.HasWorkspaceAccess(scope), nil
	}
	if effective.CanAdminister(scope) {
		return true, nil
	}
	if name == "" || !effective.HasWorkspaceAccess(scope) {
		return false, nil
	}

	owner, err := s.isAgentOwner(ctx, claims, name)
	if err != nil || owner {
		return owner, err
	}

	capability, ok := agentShareCapability(operation)
	if !ok || !effective.Allows(scope, operation) {
		return false, nil
	}
	return s.agentShareCapabilityExists(ctx, claims, name, capability)
}

func (s *Service) isAgentOwner(ctx context.Context, claims gatewayClaims, name string) (bool, error) {
	row, err := s.queries.GatewayGetAgentOwner(ctx, gatewaydb.GatewayGetAgentOwnerParams{
		OrganizationID: claims.TenantID,
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

func (s *Service) agentShareCapabilityExists(ctx context.Context, claims gatewayClaims, name string, capability gatewaydb.AgentShareCapability) (bool, error) {
	return s.queries.GatewayAgentShareCapabilityExists(ctx, gatewaydb.GatewayAgentShareCapabilityExistsParams{
		Capability:     capability,
		OrganizationID: claims.TenantID,
		WorkspaceID:    claims.WorkspaceID,
		AgentName:      name,
		UserID: pgtype.Text{
			String: claims.UserID,
			Valid:  true,
		},
	})
}

func agentShareCapability(operation authorization.Operation) (gatewaydb.AgentShareCapability, bool) {
	switch operation {
	case authorization.OperationUpdateAgent,
		authorization.OperationDeleteAgent,
		authorization.OperationUseSharedAgent:
		return gatewaydb.AgentShareCapabilityUseShared, true
	case authorization.OperationShareNonAuthoredAgent:
		return gatewaydb.AgentShareCapabilityShareNonAuthored, true
	case authorization.OperationReadSharedSecret:
		return gatewaydb.AgentShareCapabilityReadSharedSecret, true
	case authorization.OperationWriteSharedSecret:
		return gatewaydb.AgentShareCapabilityWriteSharedSecret, true
	case authorization.OperationDeleteSharedSecret:
		return gatewaydb.AgentShareCapabilityDeleteSharedSecret, true
	default:
		return "", false
	}
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

	agentNames, restricted, err := s.visibleAgentNames(r.Context(), access, agentNames)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if restricted && len(agentNames) == 0 {
		writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
			Agents:        []gatewayapi.Agent{},
			NextPageToken: "",
		})
		return
	}

	items, next, err := s.listAgentItems(r.Context(), ns, agentNames, limit, offset)
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
		OrganizationID: access.claims.TenantID,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create agent owner", err))
		return
	}

	agt := s.agentFromCreateRequest(req, ns, access.owner, name)
	_, err = s.resolver.client.AgentzV1alpha1().Agents(ns).Create(
		r.Context(),
		agt,
		metav1.CreateOptions{},
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("create agent", err))
		return
	}
	err = createAgentAudit(r.Context(), r, q, access, name, "agent.create",
		gatewaydb.AuditResultSucceeded,
		nil,
		[]gatewayapi.AuditField{
			{Field: gatewayapi.AuditFieldName, Value: name},
			{Field: gatewayapi.AuditFieldUserID, Value: access.claims.UserID},
		},
	)
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
	if err := tx.Commit(r.Context()); err != nil {
		deleteErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Delete(
			r.Context(), name, metav1.DeleteOptions{},
		)
		if deleteErr != nil && !apierrors.IsNotFound(deleteErr) {
			err = fmt.Errorf("commit Agent creation: %w; rollback Kubernetes Agent: %v", err, deleteErr)
		} else {
			err = fmt.Errorf("commit Agent creation: %w", err)
		}
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, gatewayapi.Agent{
		Name:    row.AgentName,
		Sandbox: req.Sandbox,
		Memory: gatewayapi.AgentMemoryConfig{
			Enabled: agt.Spec.Memory.Enabled,
		},
		Skills:       skills,
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       gatewayapi.PROGRESSING,
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

	var updated *agentzv1alpha1.Agent
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, getErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Get(
			r.Context(),
			row.AgentName,
			metav1.GetOptions{},
		)
		if getErr != nil {
			return getErr
		}
		applyUpdateAgentRequest(agt, req)
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

	status := gatewayapi.PROGRESSING
	if view := statusFromAgent(updated); view != nil {
		status = statusFromView(view)
	}
	writeJSON(w, http.StatusOK, gatewayapi.Agent{
		Name:    row.AgentName,
		Sandbox: resourceReferenceFromCRD(updated.Spec.SandboxRef),
		Memory: gatewayapi.AgentMemoryConfig{
			Enabled: updated.Spec.Memory.Enabled,
		},
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       status,
		Skills:       resourceReferencesFromCRD(updated.Spec.Skills),
	})
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
		OrganizationID: access.claims.TenantID,
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
		OrganizationID: access.claims.TenantID,
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
	err = createAgentAudit(r.Context(), r, q, access, agentName, "agent.delete",
		gatewaydb.AuditResultSucceeded,
		[]gatewayapi.AuditField{
			{Field: gatewayapi.AuditFieldName, Value: agentName},
			{Field: gatewayapi.AuditFieldUserID, Value: owner.OwnerUserID},
		},
		nil,
	)
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
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName, authorization.OperationUseSharedAgent)
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetAgentOwner(r.Context(), gatewaydb.GatewayGetAgentOwnerParams{
		OrganizationID: access.claims.TenantID,
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
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName, authorization.OperationUseSharedAgent)
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
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
	}
	owner, err := s.isAgentOwner(r.Context(), access.claims, agentName)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve Agent owner: %w", err))
		return
	}
	if !owner && !access.effective.CanAdminister(scope) {
		writeError(w, r, resourceForbidden(errors.New("Agent ownership transfer requires owner or administrator authority")))
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin Agent owner transfer: %w", err))
		return
	}
	defer tx.Rollback(r.Context())

	q := gatewaydb.New(tx)
	previous, err := q.GatewayLockAgentOwner(r.Context(), gatewaydb.GatewayLockAgentOwnerParams{
		OrganizationID: access.claims.TenantID,
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
		writeError(w, r, resourceForbidden(errors.New("Agent ownership changed before transfer")))
		return
	}

	active, err := q.GatewayIsActiveOrganizationMember(r.Context(), gatewaydb.GatewayIsActiveOrganizationMemberParams{
		UserID: req.OwnerUserId, OrganizationID: access.claims.TenantID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve new Agent owner membership: %w", err))
		return
	}
	effective, err := authorization.New(q).Resolve(r.Context(), authorization.Subject{
		UserID: req.OwnerUserId, OrganizationID: access.claims.TenantID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve new Agent owner permissions: %w", err))
		return
	}
	if !active || !effective.HasWorkspaceAccess(scope) ||
		!effective.Allows(scope, authorization.OperationCreateAgent) {
		writeError(w, r, resourceForbidden(errors.New("new owner requires active membership, independent Workspace access, and Agent Author")))
		return
	}

	row, err := q.GatewayTransferAgentOwner(r.Context(), gatewaydb.GatewayTransferAgentOwnerParams{
		UpdatedAt:   pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		WorkspaceID: access.workspaceID, AgentName: agentName,
		OrganizationID: access.claims.TenantID, OwnerUserID: req.OwnerUserId,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, agentNotFound(agentName))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("transfer Agent owner: %w", err))
		return
	}
	err = createAgentAudit(r.Context(), r, q, access, agentName, "agent.owner.transfer",
		gatewaydb.AuditResultSucceeded,
		[]gatewayapi.AuditField{
			{Field: gatewayapi.AuditFieldName, Value: agentName},
			{Field: gatewayapi.AuditFieldUserID, Value: previous.OwnerUserID},
		},
		[]gatewayapi.AuditField{
			{Field: gatewayapi.AuditFieldName, Value: agentName},
			{Field: gatewayapi.AuditFieldUserID, Value: row.OwnerUserID},
		},
	)
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
func (s *Service) ListAgentShares(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName, authorization.OperationUseSharedAgent)
	if !ok {
		return
	}

	shares, err := s.agentShares(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListAgentSharesResponse{Shares: shares})
}

// UpsertAgentShare handles POST /api/agent/{agentName}/share.
func (s *Service) UpsertAgentShare(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName, authorization.OperationUseSharedAgent)
	if !ok {
		return
	}

	var req gatewayapi.UpsertAgentShareRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	targetUser, targetTeam, fields := validateAgentShareTarget(req)
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

	allowed, err := s.canManageAgentShares(r.Context(), access, agentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !allowed {
		writeError(w, r, resourceForbidden(errors.New("Agent Share authority is missing")))
		return
	}
	if targetUser.Valid {
		eligible, err := s.recipientCanUseAgent(
			r.Context(),
			access.claims.TenantID,
			access.workspaceID,
			targetUser.String,
			req.Capabilities,
		)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if !eligible {
			writeError(w, r, resourceForbidden(errors.New("recipient is not eligible for requested Agent Share capabilities")))
			return
		}
	}
	if targetTeam.Valid {
		eligible, err := s.teamCanUseAgent(
			r.Context(),
			access.claims.TenantID,
			access.workspaceID,
			targetTeam.String,
			req.Capabilities,
		)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if !eligible {
			writeError(w, r, resourceForbidden(errors.New("Team is not eligible for requested Agent Share capabilities")))
			return
		}
	}

	row, err := s.createAgentShare(r.Context(), r, access, agentName, targetUser, targetTeam, caps)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create Agent Share", err))
		return
	}
	writeJSON(w, http.StatusOK, row)
}

// DeleteAgentShare handles DELETE /api/agent/{agentName}/share/{shareId}.
func (s *Service) DeleteAgentShare(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, shareID gatewayapi.AgentShareIDPath) {
	agentName, access, ok := s.resolveNamedAgent(w, r, agentName, authorization.OperationUseSharedAgent)
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
	allowed, err := s.canDeleteAgentShare(r.Context(), access, agentName, share)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !allowed {
		writeError(w, r, resourceForbidden(errors.New("Agent Share delete authority is missing")))
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
		ID: shareID, OrganizationID: access.claims.TenantID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("delete Agent Share: %w", err))
		return
	}
	if rows == 0 {
		writeError(w, r, agentShareNotFound(shareID))
		return
	}
	err = createAgentAudit(r.Context(), r, q, access, agentName, "agent.share.delete",
		gatewaydb.AuditResultSucceeded,
		agentShareAuditFields(agentName, share),
		[]gatewayapi.AuditField{{Field: gatewayapi.AuditFieldName, Value: agentName}},
	)
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
		names, restricted, err := s.visibleAgentNames(r.Context(), access, agentNames)
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if restricted && len(names) == 0 {
			return send("", []gatewayapi.Agent{})
		}
		items, _, err := s.listAgentItems(r.Context(), ns, names, 200, 0)
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

func (s *Service) visibleAgentNames(ctx context.Context, access resourceAccess, requested []string) ([]string, bool, error) {
	scope := authorization.Scope{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
	}
	if access.effective.CanAdminister(scope) {
		return requested, false, nil
	}

	names, err := s.queries.GatewayListAccessibleAgentNames(ctx, gatewaydb.GatewayListAccessibleAgentNamesParams{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
		UserID:         access.claims.UserID,
	})
	if err != nil {
		return nil, true, fmt.Errorf("list accessible Agent names: %w", err)
	}
	if len(requested) == 0 {
		return names, true, nil
	}

	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		allowed[name] = struct{}{}
	}
	filtered := requested[:0]
	for _, name := range requested {
		if _, ok := allowed[name]; ok {
			filtered = append(filtered, name)
		}
	}
	return filtered, true, nil
}

func (s *Service) resolveNamedAgent(w http.ResponseWriter, r *http.Request, raw string, operation authorization.Operation) (string, resourceAccess, bool) {
	name, ok := validAgentName(w, r, raw, "agentName")
	if !ok {
		return "", resourceAccess{}, false
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), name, operation)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return "", resourceAccess{}, false
	}
	return name, access, true
}

func (s *Service) recipientCanUseAgent(ctx context.Context, organizationID string, workspaceID string, userID string, caps []gatewayapi.AgentShareCapability) (bool, error) {
	active, err := s.queries.GatewayIsActiveOrganizationMember(ctx, gatewaydb.GatewayIsActiveOrganizationMemberParams{
		UserID: userID, OrganizationID: organizationID,
	})
	if err != nil || !active {
		return false, err
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: userID, OrganizationID: organizationID,
	})
	if err != nil {
		return false, fmt.Errorf("resolve Agent Share recipient access: %w", err)
	}
	scope := authorization.Scope{OrganizationID: organizationID, WorkspaceID: workspaceID}
	for _, cap := range caps {
		operation, ok := agentShareOperation(cap)
		if !ok || !effective.Allows(scope, operation) {
			return false, nil
		}
	}
	return true, nil
}

func (s *Service) teamCanUseAgent(ctx context.Context, organizationID string, workspaceID string, teamID string, caps []gatewayapi.AgentShareCapability) (bool, error) {
	userIDs, err := s.queries.GatewayListActiveTeamUserIDs(ctx, gatewaydb.GatewayListActiveTeamUserIDsParams{
		OrganizationID: organizationID,
		TeamID:         teamID,
	})
	if err != nil {
		return false, fmt.Errorf("list active Team users: %w", err)
	}
	if len(userIDs) == 0 {
		return false, nil
	}
	for _, userID := range userIDs {
		eligible, err := s.recipientCanUseAgent(ctx, organizationID, workspaceID, userID, caps)
		if err != nil || !eligible {
			return eligible, err
		}
	}
	return true, nil
}

func (s *Service) canManageAgentShares(ctx context.Context, access resourceAccess, agentName string) (bool, error) {
	scope := authorization.Scope{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
	}
	if access.effective.CanAdminister(scope) {
		return true, nil
	}
	owner, err := s.isAgentOwner(ctx, access.claims, agentName)
	if err != nil {
		return false, fmt.Errorf("resolve Agent owner: %w", err)
	}
	if owner {
		return access.effective.Allows(scope, authorization.OperationShareAuthoredAgent), nil
	}
	return s.agentOperationAllowed(ctx, access.claims, access.effective, scope, agentName, authorization.OperationShareNonAuthoredAgent)
}

func (s *Service) canDeleteAgentShare(ctx context.Context, access resourceAccess, agentName string, share gatewaydb.AgentShare) (bool, error) {
	allowed, err := s.canManageAgentShares(ctx, access, agentName)
	if err != nil || allowed {
		return allowed, err
	}
	if share.CreatedBy != access.claims.UserID {
		return false, nil
	}
	scope := authorization.Scope{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
	}
	return s.agentOperationAllowed(ctx, access.claims, access.effective, scope, agentName, authorization.OperationShareNonAuthoredAgent)
}

func validateAgentShareTarget(req gatewayapi.UpsertAgentShareRequest) (pgtype.Text, pgtype.Text, []gatewayapi.FieldError) {
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

func agentShareOperation(cap gatewayapi.AgentShareCapability) (authorization.Operation, bool) {
	switch cap {
	case gatewayapi.AgentShareCapabilityUseShared:
		return authorization.OperationUseSharedAgent, true
	case gatewayapi.AgentShareCapabilityShareNonAuthored:
		return authorization.OperationShareNonAuthoredAgent, true
	case gatewayapi.AgentShareCapabilityReadSharedSecret:
		return authorization.OperationReadSharedSecret, true
	case gatewayapi.AgentShareCapabilityWriteSharedSecret:
		return authorization.OperationWriteSharedSecret, true
	case gatewayapi.AgentShareCapabilityDeleteSharedSecret:
		return authorization.OperationDeleteSharedSecret, true
	default:
		return "", false
	}
}

func (s *Service) createAgentShare(ctx context.Context, r *http.Request, access resourceAccess, agentName string, targetUser pgtype.Text, targetTeam pgtype.Text, caps []gatewaydb.AgentShareCapability) (gatewayapi.AgentShare, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("begin Agent Share transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	q := gatewaydb.New(tx)
	shares, err := q.GatewayListAgentShares(ctx, gatewaydb.GatewayListAgentSharesParams{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("list Agent Shares: %w", err)
	}
	for _, share := range shares {
		sameUser := targetUser.Valid && share.TargetUserID.Valid &&
			targetUser.String == share.TargetUserID.String
		sameTeam := targetTeam.Valid && share.TargetTeamID.Valid &&
			targetTeam.String == share.TargetTeamID.String
		if !sameUser && !sameTeam {
			continue
		}
		if _, err := q.GatewayDeleteAgentShare(ctx, gatewaydb.GatewayDeleteAgentShareParams{
			ID: share.ID, OrganizationID: access.claims.TenantID, WorkspaceID: access.workspaceID,
		}); err != nil {
			return gatewayapi.AgentShare{}, fmt.Errorf("replace Agent Share: %w", err)
		}
	}

	row, err := q.GatewayCreateAgentShare(ctx, gatewaydb.GatewayCreateAgentShareParams{
		ID: "agent-share-" + uuid.NewString(), CreatedBy: access.claims.UserID,
		TargetUserID: targetUser, TargetTeamID: targetTeam,
		OrganizationID: access.claims.TenantID, WorkspaceID: access.workspaceID,
		AgentName: agentName,
	})
	if err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("create Agent Share: %w", err)
	}
	for _, cap := range caps {
		if _, err := q.GatewayAddAgentShareGrant(ctx, gatewaydb.GatewayAddAgentShareGrantParams{
			Capability: cap, ShareID: row.ID,
			OrganizationID: access.claims.TenantID, WorkspaceID: access.workspaceID,
		}); err != nil {
			return gatewayapi.AgentShare{}, fmt.Errorf("add Agent Share grant: %w", err)
		}
	}
	if err := createAgentAudit(ctx, r, q, access, agentName, "agent.share.upsert",
		gatewaydb.AuditResultSucceeded,
		nil,
		agentShareAuditFields(agentName, row),
	); err != nil {
		return gatewayapi.AgentShare{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return gatewayapi.AgentShare{}, fmt.Errorf("commit Agent Share: %w", err)
	}
	return s.agentShareResponse(ctx, access, row)
}

func (s *Service) agentShares(ctx context.Context, access resourceAccess, agentName string) ([]gatewayapi.AgentShare, error) {
	rows, err := s.queries.GatewayListAgentShares(ctx, gatewaydb.GatewayListAgentSharesParams{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		return nil, fmt.Errorf("list Agent Shares: %w", err)
	}
	out := make([]gatewayapi.AgentShare, 0, len(rows))
	for _, row := range rows {
		item, err := s.agentShareResponse(ctx, access, row)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (s *Service) agentShareByID(ctx context.Context, access resourceAccess, agentName string, shareID string) (gatewaydb.AgentShare, error) {
	rows, err := s.queries.GatewayListAgentShares(ctx, gatewaydb.GatewayListAgentSharesParams{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		return gatewaydb.AgentShare{}, fmt.Errorf("list Agent Shares: %w", err)
	}
	for _, row := range rows {
		if row.ID == shareID {
			return row, nil
		}
	}
	return gatewaydb.AgentShare{}, pgx.ErrNoRows
}

func (s *Service) agentShareResponse(ctx context.Context, access resourceAccess, row gatewaydb.AgentShare) (gatewayapi.AgentShare, error) {
	grants, err := s.queries.GatewayListAgentShareGrants(ctx, gatewaydb.GatewayListAgentShareGrantsParams{
		ShareID: row.ID, OrganizationID: access.claims.TenantID, WorkspaceID: access.workspaceID,
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

func createAgentAudit(ctx context.Context, r *http.Request, q gatewaydb.Querier, access resourceAccess, agentName string, action string, result gatewaydb.AuditResult, before []gatewayapi.AuditField, after []gatewayapi.AuditField) error {
	if before == nil {
		before = []gatewayapi.AuditField{}
	}
	if after == nil {
		after = []gatewayapi.AuditField{}
	}
	beforeJSON, err := json.Marshal(before)
	if err != nil {
		return fmt.Errorf("encode Agent audit before state: %w", err)
	}
	afterJSON, err := json.Marshal(after)
	if err != nil {
		return fmt.Errorf("encode Agent audit after state: %w", err)
	}
	params := gatewaydb.GatewayCreateAuditEventParams{
		ID:               "audit-" + uuid.NewString(),
		OrganizationID:   access.claims.TenantID,
		WorkspaceID:      pgtype.Text{String: access.workspaceID, Valid: access.workspaceID != ""},
		ActorType:        gatewaydb.AuditActorUser,
		ActorID:          pgtype.Text{String: access.claims.UserID, Valid: true},
		TargetType:       gatewaydb.AuditTargetAgent,
		TargetID:         agentName,
		Category:         "agent",
		Action:           action,
		Result:           result,
		Before:           beforeJSON,
		After:            afterJSON,
		AutomaticCascade: false,
		Interface:        gatewaydb.AuditInterfaceGateway,
	}
	if host, _, splitErr := net.SplitHostPort(r.RemoteAddr); splitErr == nil && host != "" {
		params.IpAddress = pgtype.Text{String: host, Valid: true}
	}
	if userAgent := strings.TrimSpace(r.UserAgent()); userAgent != "" {
		params.UserAgent = pgtype.Text{String: userAgent, Valid: true}
	}
	if _, err := q.GatewayCreateAuditEvent(ctx, params); err != nil {
		return fmt.Errorf("create Agent audit event: %w", err)
	}
	return nil
}

func agentShareAuditFields(agentName string, share gatewaydb.AgentShare) []gatewayapi.AuditField {
	fields := []gatewayapi.AuditField{{Field: gatewayapi.AuditFieldName, Value: agentName}}
	if share.TargetUserID.Valid {
		fields = append(fields, gatewayapi.AuditField{
			Field: gatewayapi.AuditFieldUserID, Value: share.TargetUserID.String,
		})
	}
	if share.TargetTeamID.Valid {
		fields = append(fields, gatewayapi.AuditField{
			Field: gatewayapi.AuditFieldName, Value: "team:" + share.TargetTeamID.String,
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
		fmt.Errorf("Agent Share %q not found", id),
	)
}

func (s *Service) listAgentItems(ctx context.Context, ns string, agentNames []string, limit int, offset int) ([]gatewayapi.Agent, string, error) {
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

	items := make([]gatewayapi.Agent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodeOffsetToken(offset + limit)
			continue
		}

		status := gatewayapi.UNSPECIFIED
		sandbox := gatewayapi.ResourceReference{
			Scope: gatewayapi.ResourceScope(agentzv1alpha1.ResourceScopeOrganisation),
		}
		resolved, resolveErr := s.resolver.resolveAgent(ctx, ns, row.AgentName)
		if resolveErr != nil && !errors.Is(resolveErr, errAgentNotFound) {
			return nil, "", resolveErr
		}
		if resolved != nil && resolved.Agent != nil {
			status = statusFromView(statusFromAgent(resolved.Agent))
			sandbox = resourceReferenceFromCRD(resolved.Agent.Spec.SandboxRef)
			skills := resourceReferencesFromCRD(resolved.Agent.Spec.Skills)
			items = append(items, gatewayapi.Agent{
				Name:    row.AgentName,
				Sandbox: sandbox,
				Memory: gatewayapi.AgentMemoryConfig{
					Enabled: resolved.Agent.Spec.Memory.Enabled,
				},
				LastActivity: row.UpdatedAt,
				CreatedAt:    row.CreatedAt,
				ModifiedAt:   row.UpdatedAt,
				Status:       status,
				Skills:       skills,
			})
			continue
		}

		items = append(items, gatewayapi.Agent{
			Name:         row.AgentName,
			Sandbox:      sandbox,
			Memory:       gatewayapi.AgentMemoryConfig{},
			LastActivity: row.UpdatedAt,
			CreatedAt:    row.CreatedAt,
			ModifiedAt:   row.UpdatedAt,
			Status:       status,
			Skills:       []gatewayapi.ResourceReference{},
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

	resourceNamespace, err := scoperesolver.SelectedNamespace(
		ctx,
		s.k8sClient,
		namespace,
		agentzv1alpha1.ResourceScope(ref.Scope),
		agentzv1alpha1.OrganizationResourceKindSandbox,
		ref.Name,
	)
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
