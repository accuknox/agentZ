package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gosimple/slug"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type workspaceEventTrail struct {
	request        *http.Request
	organizationID string
	workspaceID    string
	actorType      gatewaydb.EventTrailActor
	actorID        string
	action         string
	result         gatewaydb.EventTrailResult
	interfaceName  gatewaydb.EventTrailInterface
	before         []gatewayapi.EventTrailField
	after          []gatewayapi.EventTrailField
}

// ListWorkspaces handles GET /api/workspace.
func (s *Service) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	rows, canCreate, canEnter, err := s.workspaceAccess(r.Context(), claims)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	workspaces := make([]gatewayapi.Workspace, 0, len(rows))
	effective, err := authorization.New(s.queries).Resolve(r.Context(), authorization.Subject{
		UserID: claims.UserID, OrganizationID: claims.OrganizationID,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve workspace capabilities: %w", err))
		return
	}
	for _, row := range rows {
		capabilities := resourceCapabilities(effective, claims.OrganizationID, row.Workspace.ID)
		workspaces = append(workspaces, workspaceView(
			row.Workspace,
			row.WorkspaceAdminCount,
			row.CanAdminister,
			capabilities,
		))
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListWorkspacesResponse{
		CanCreate:            canCreate,
		CanEnterOrganization: canEnter,
		Workspaces:           workspaces,
	})
}

// ListWorkspaceMemberCandidates handles GET /api/workspace/member-candidate.
func (s *Service) ListWorkspaceMemberCandidates(w http.ResponseWriter, r *http.Request) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	allowed, err := s.queries.GatewayIsActiveSuperadmin(
		r.Context(),
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID:         claims.UserID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("authorize workspace member list: %w", err))
		return
	}
	if !allowed {
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"Superadmin authority is required",
			errors.New("workspace member list requires Superadmin authority"),
		))
		return
	}

	rows, err := s.queries.GatewayListWorkspaceAdminCandidates(
		r.Context(),
		gatewaydb.GatewayListWorkspaceAdminCandidatesParams{
			OrganizationID: claims.OrganizationID,
			ActorUserID:    claims.UserID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list workspace admin candidates: %w", err))
		return
	}
	members := make([]gatewayapi.WorkspaceMemberCandidate, 0, len(rows))
	for _, row := range rows {
		members = append(members, gatewayapi.WorkspaceMemberCandidate{
			Email:    openapi_types.Email(row.Email),
			MemberId: row.MemberID,
			Name:     row.Name,
			UserId:   row.UserID,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListWorkspaceMemberCandidatesResponse{
		Members: members,
	})
}

// CreateWorkspace handles POST /api/workspace.
func (s *Service) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	var req gatewayapi.CreateWorkspaceRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "name", Message: "must not be blank"},
		))
		return
	}

	workspaceUUID := uuid.NewString()
	id := "workspace-" + workspaceUUID
	workspaceSlug := slug.Make(req.Name)
	if workspaceSlug == "" {
		workspaceSlug = "workspace"
	}
	workspaceSlug += "-" + workspaceUUID[:8]
	namespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		id,
	)

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin create workspace: %w", err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := gatewaydb.New(tx)
	_, err = q.GatewayLockOrganization(r.Context(), claims.OrganizationID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create workspace", err))
		return
	}
	allowed, err := q.GatewayIsActiveSuperadmin(
		r.Context(),
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID:         claims.UserID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("authorize workspace create: %w", err))
		return
	}
	if !allowed {
		err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
			request:        r,
			organizationID: claims.OrganizationID,
			workspaceID:    id,
			actorType:      gatewaydb.EventTrailActorUser,
			actorID:        claims.UserID,
			action:         "workspace.create",
			result:         gatewaydb.EventTrailResultDenied,
			interfaceName:  gatewaydb.EventTrailInterfaceGateway,
			after: []gatewayapi.EventTrailField{
				{Field: gatewayapi.EventTrailFieldName, Value: req.Name},
			},
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeInternalError(w, r, fmt.Errorf("commit denied workspace create: %w", err))
			return
		}
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"Superadmin authority is required",
			errors.New("workspace creation requires Superadmin authority"),
		))
		return
	}
	selected := agentzv1alpha1.SelectedOrganizationResources{
		Skills:             slices.Clone(req.SelectedOrganizationResources.Skills),
		Sandboxes:          slices.Clone(req.SelectedOrganizationResources.Sandboxes),
		MCPConnections:     slices.Clone(req.SelectedOrganizationResources.McpConnections),
		InferenceProviders: slices.Clone(req.SelectedOrganizationResources.InferenceProviders),
	}
	fields, err := s.validateOrganizationResourceSelection(
		r.Context(), claims.OrganizationID, selected,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
			request: r, organizationID: claims.OrganizationID, workspaceID: id,
			actorType: gatewaydb.EventTrailActorUser, actorID: claims.UserID,
			action: "workspace.create", result: gatewaydb.EventTrailResultFailed,
			interfaceName: gatewaydb.EventTrailInterfaceGateway,
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeInternalError(w, r, fmt.Errorf("commit failed workspace create event trail: %w", err))
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"selected Organisation resources are invalid",
			errBadRequest,
			fields...,
		))
		return
	}

	err = q.GatewayCreateWorkspace(r.Context(), gatewaydb.GatewayCreateWorkspaceParams{
		ID:             id,
		OrganizationID: claims.OrganizationID,
		Name:           req.Name,
		Slug:           workspaceSlug,
		Namespace:      namespace,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create workspace", err))
		return
	}
	if err := insertWorkspaceResourceSelection(
		r.Context(), q, id, claims.OrganizationID, selected,
	); err != nil {
		writeInternalError(w, r, err)
		return
	}
	role, err := q.GatewayCreateWorkspaceAdminRole(
		r.Context(),
		gatewaydb.GatewayCreateWorkspaceAdminRoleParams{
			WorkspaceID:    id,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("create Workspace Admin role: %w", err))
		return
	}
	assigned, err := q.GatewayAssignWorkspaceAdmins(
		r.Context(),
		gatewaydb.GatewayAssignWorkspaceAdminsParams{
			RoleID:         role.RoleID,
			MemberIds:      req.AdminMemberIds,
			OrganizationID: claims.OrganizationID,
			WorkspaceID:    pgtype.Text{String: id, Valid: true},
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("assign Workspace Admins: %w", err))
		return
	}
	if assigned != int64(len(req.AdminMemberIds)) {
		_ = tx.Rollback(r.Context())
		err = createWorkspaceEventTrail(r.Context(), s.queries, workspaceEventTrail{
			request:        r,
			organizationID: claims.OrganizationID,
			workspaceID:    id,
			actorType:      gatewaydb.EventTrailActorUser,
			actorID:        claims.UserID,
			action:         "workspace.create",
			result:         gatewaydb.EventTrailResultDenied,
			interfaceName:  gatewaydb.EventTrailInterfaceGateway,
			after: []gatewayapi.EventTrailField{
				{Field: gatewayapi.EventTrailFieldName, Value: req.Name},
			},
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusUnprocessableEntity,
			"invalid_request",
			"one or more Workspace Admins are not eligible",
			errors.New("workspace admin selection changed"),
			gatewayapi.FieldError{
				Field:   "admin_member_ids",
				Message: "contains an ineligible member",
			},
		))
		return
	}
	projected, err := q.GatewayProjectMemberRoleTransports(
		r.Context(),
		gatewaydb.GatewayProjectMemberRoleTransportsParams{
			MemberIds:      req.AdminMemberIds,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("project Workspace Admin roles: %w", err))
		return
	}
	if projected != assigned {
		writeInternalError(w, r, errors.New("projected Workspace Admin count changed"))
		return
	}
	err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
		request:        r,
		organizationID: claims.OrganizationID,
		workspaceID:    id,
		actorType:      gatewaydb.EventTrailActorUser,
		actorID:        claims.UserID,
		action:         "workspace.create",
		result:         gatewaydb.EventTrailResultSucceeded,
		interfaceName:  gatewaydb.EventTrailInterfaceGateway,
		after: []gatewayapi.EventTrailField{
			{Field: gatewayapi.EventTrailFieldName, Value: req.Name},
			{Field: gatewayapi.EventTrailFieldSlug, Value: workspaceSlug},
			{Field: gatewayapi.EventTrailFieldProvisioningAttempt, Value: "1"},
			{Field: gatewayapi.EventTrailFieldState, Value: "provisioning"},
		},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit workspace create: %w", err))
		return
	}

	row, err := s.queries.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{ID: id, OrganizationID: claims.OrganizationID},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("read created workspace: %w", err))
		return
	}
	if err := s.ensureWorkspaceResource(r.Context(), row); err != nil {
		reason := fmt.Sprintf("create Workspace resource: %v", err)
		row, err = s.failWorkspaceProvisioning(
			r.Context(),
			row,
			reason,
			gatewaydb.EventTrailInterfaceGateway,
		)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	capabilities, err := s.resolveResourceCapabilities(r.Context(), claims, row.ID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, workspaceView(row, int64(len(req.AdminMemberIds)), true, capabilities))
}

// GetWorkspace handles GET /api/workspace/{workspaceId}.
func (s *Service) GetWorkspace(w http.ResponseWriter, r *http.Request, workspaceID gatewayapi.WorkspaceIDPath) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	rows, _, _, err := s.workspaceAccess(r.Context(), claims)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	for _, row := range rows {
		if row.Workspace.ID == workspaceID {
			capabilities, err := s.resolveResourceCapabilities(r.Context(), claims, row.Workspace.ID)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, workspaceView(
				row.Workspace,
				row.WorkspaceAdminCount,
				row.CanAdminister,
				capabilities,
			))
			return
		}
	}
	writeError(w, r, workspaceNotFound(workspaceID))
}

// ResolveWorkspaceSlug handles GET /api/workspace/slug/{workspaceSlug}.
func (s *Service) ResolveWorkspaceSlug(w http.ResponseWriter, r *http.Request, workspaceSlug gatewayapi.WorkspaceSlugPath) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	resolved, err := s.queries.GatewayResolveWorkspaceSlug(
		r.Context(),
		gatewaydb.GatewayResolveWorkspaceSlugParams{
			OrganizationID: claims.OrganizationID,
			Slug:           workspaceSlug,
			UserID:         claims.UserID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, workspaceNotFound(workspaceSlug))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve workspace slug: %w", err))
		return
	}
	rows, _, _, err := s.workspaceAccess(r.Context(), claims)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	for _, row := range rows {
		if row.Workspace.ID == resolved.Workspace.ID {
			capabilities, err := s.resolveResourceCapabilities(r.Context(), claims, row.Workspace.ID)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, workspaceView(
				row.Workspace,
				row.WorkspaceAdminCount,
				row.CanAdminister,
				capabilities,
			))
			return
		}
	}
	writeError(w, r, workspaceNotFound(workspaceSlug))
}

// RetryWorkspace handles POST /api/workspace/{workspaceId}/retry.
func (s *Service) RetryWorkspace(w http.ResponseWriter, r *http.Request, workspaceID gatewayapi.WorkspaceIDPath) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin retry workspace: %w", err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := gatewaydb.New(tx)
	_, err = q.GatewayLockOrganization(r.Context(), claims.OrganizationID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("retry workspace", err))
		return
	}
	allowed, err := q.GatewayIsActiveSuperadmin(
		r.Context(),
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID:         claims.UserID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("authorize workspace retry: %w", err))
		return
	}
	current, getErr := q.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             workspaceID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if !allowed || getErr != nil || current.State != gatewaydb.WorkspaceStateFailed {
		err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
			request:        r,
			organizationID: claims.OrganizationID,
			workspaceID:    workspaceID,
			actorType:      gatewaydb.EventTrailActorUser,
			actorID:        claims.UserID,
			action:         "workspace.retry",
			result:         gatewaydb.EventTrailResultDenied,
			interfaceName:  gatewaydb.EventTrailInterfaceGateway,
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeInternalError(w, r, fmt.Errorf("commit denied workspace retry: %w", err))
			return
		}
		switch {
		case !allowed:
			writeError(w, r, newAPIError(
				http.StatusForbidden,
				"forbidden",
				"Superadmin authority is required",
				errors.New("workspace retry requires Superadmin authority"),
			))
		case errors.Is(getErr, pgx.ErrNoRows):
			writeError(w, r, workspaceNotFound(workspaceID))
		case getErr != nil:
			writeInternalError(w, r, fmt.Errorf("get workspace for retry: %w", getErr))
		default:
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"only failed Workspace provisioning can be retried",
				errors.New("workspace is not failed"),
			))
		}
		return
	}

	updatedAt := pgtype.Timestamptz{Time: time.Now(), Valid: true}
	changed, err := q.GatewayRetryWorkspaceProvisioning(
		r.Context(),
		gatewaydb.GatewayRetryWorkspaceProvisioningParams{
			UpdatedAt:      updatedAt,
			ID:             workspaceID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("retry workspace provisioning: %w", err))
		return
	}
	if changed != 1 {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"Workspace provisioning state changed",
			errors.New("workspace retry compare-and-set failed"),
		))
		return
	}
	err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
		request:        r,
		organizationID: claims.OrganizationID,
		workspaceID:    workspaceID,
		actorType:      gatewaydb.EventTrailActorUser,
		actorID:        claims.UserID,
		action:         "workspace.retry",
		result:         gatewaydb.EventTrailResultSucceeded,
		interfaceName:  gatewaydb.EventTrailInterfaceGateway,
		before: []gatewayapi.EventTrailField{
			{
				Field: gatewayapi.EventTrailFieldProvisioningAttempt,
				Value: strconv.FormatInt(current.ProvisioningAttempt, 10),
			},
			{Field: gatewayapi.EventTrailFieldState, Value: "failed"},
		},
		after: []gatewayapi.EventTrailField{
			{
				Field: gatewayapi.EventTrailFieldProvisioningAttempt,
				Value: strconv.FormatInt(current.ProvisioningAttempt+1, 10),
			},
			{Field: gatewayapi.EventTrailFieldState, Value: "provisioning"},
		},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit workspace retry: %w", err))
		return
	}
	current, err = s.queries.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             workspaceID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("read retried workspace: %w", err))
		return
	}
	if err := s.ensureWorkspaceResource(r.Context(), current); err != nil {
		reason := fmt.Sprintf("update Workspace resource: %v", err)
		current, err = s.failWorkspaceProvisioning(
			r.Context(),
			current,
			reason,
			gatewaydb.EventTrailInterfaceGateway,
		)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	rows, _, _, err := s.workspaceAccess(r.Context(), claims)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	for _, row := range rows {
		if row.Workspace.ID == current.ID {
			capabilities, err := s.resolveResourceCapabilities(r.Context(), claims, current.ID)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, workspaceView(
				current,
				row.WorkspaceAdminCount,
				row.CanAdminister,
				capabilities,
			))
			return
		}
	}
	writeError(w, r, workspaceNotFound(workspaceID))
}

// UpdateWorkspaceLifecycle handles PATCH /api/workspace/{workspaceId}/lifecycle.
func (s *Service) UpdateWorkspaceLifecycle(w http.ResponseWriter, r *http.Request, workspaceID gatewayapi.WorkspaceIDPath) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims != nil || auth.tenantNamespace == "" {
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"Workspace lifecycle is restricted to internal controllers",
			errors.New("external caller cannot update workspace lifecycle"),
		))
		return
	}
	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	var req gatewayapi.UpdateWorkspaceLifecycleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	state := gatewaydb.WorkspaceStateReady
	reason := pgtype.Text{}
	if req.State == gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed {
		if req.FailureReason == nil || strings.TrimSpace(*req.FailureReason) == "" {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"failure_reason is required for a failed Workspace",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "failure_reason",
					Message: "is required when state is failed",
				},
			))
			return
		}
		state = gatewaydb.WorkspaceStateFailed
		reason = pgtype.Text{String: strings.TrimSpace(*req.FailureReason), Valid: true}
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin workspace lifecycle update: %w", err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := gatewaydb.New(tx)
	_, err = q.GatewayLockOrganization(r.Context(), tenant.Spec.OrganizationID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("update workspace lifecycle", err))
		return
	}
	previous, previousErr := q.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             workspaceID,
			OrganizationID: tenant.Spec.OrganizationID,
		},
	)
	changed, err := q.GatewayTransitionWorkspaceProvisioning(
		r.Context(),
		gatewaydb.GatewayTransitionWorkspaceProvisioningParams{
			State:               state,
			FailureReason:       reason,
			UpdatedAt:           pgtype.Timestamptz{Time: time.Now(), Valid: true},
			ID:                  workspaceID,
			OrganizationID:      tenant.Spec.OrganizationID,
			ProvisioningAttempt: req.ProvisioningAttempt,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("transition workspace lifecycle: %w", err))
		return
	}
	if changed == 0 {
		if errors.Is(previousErr, pgx.ErrNoRows) {
			writeError(w, r, workspaceNotFound(workspaceID))
			return
		}
		if previousErr != nil {
			writeInternalError(w, r, fmt.Errorf("get workspace lifecycle: %w", previousErr))
			return
		}
		if previous.ProvisioningAttempt == req.ProvisioningAttempt && previous.State == state {
			if err := tx.Commit(r.Context()); err != nil {
				writeInternalError(w, r, fmt.Errorf("commit idempotent workspace lifecycle: %w", err))
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
			organizationID: tenant.Spec.OrganizationID,
			workspaceID:    workspaceID,
			actorType:      gatewaydb.EventTrailActorSystem,
			action:         "workspace.lifecycle",
			result:         gatewaydb.EventTrailResultDenied,
			interfaceName:  gatewaydb.EventTrailInterfaceController,
			before: []gatewayapi.EventTrailField{
				{
					Field: gatewayapi.EventTrailFieldProvisioningAttempt,
					Value: strconv.FormatInt(req.ProvisioningAttempt, 10),
				},
				{Field: gatewayapi.EventTrailFieldState, Value: string(previous.State)},
			},
			after: []gatewayapi.EventTrailField{
				{
					Field: gatewayapi.EventTrailFieldProvisioningAttempt,
					Value: strconv.FormatInt(req.ProvisioningAttempt, 10),
				},
				{Field: gatewayapi.EventTrailFieldState, Value: string(state)},
			},
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeInternalError(w, r, fmt.Errorf("commit denied workspace lifecycle: %w", err))
			return
		}
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"Workspace provisioning attempt is stale",
			errors.New("workspace lifecycle compare-and-set failed"),
		))
		return
	}
	if previousErr != nil {
		writeInternalError(w, r, fmt.Errorf("read previous workspace lifecycle: %w", previousErr))
		return
	}
	err = createWorkspaceEventTrail(r.Context(), q, workspaceEventTrail{
		organizationID: tenant.Spec.OrganizationID,
		workspaceID:    workspaceID,
		actorType:      gatewaydb.EventTrailActorSystem,
		action:         "workspace." + string(state),
		result:         gatewaydb.EventTrailResultSucceeded,
		interfaceName:  gatewaydb.EventTrailInterfaceController,
		before: []gatewayapi.EventTrailField{
			{
				Field: gatewayapi.EventTrailFieldProvisioningAttempt,
				Value: strconv.FormatInt(req.ProvisioningAttempt, 10),
			},
			{Field: gatewayapi.EventTrailFieldState, Value: string(previous.State)},
		},
		after: []gatewayapi.EventTrailField{
			{
				Field: gatewayapi.EventTrailFieldProvisioningAttempt,
				Value: strconv.FormatInt(req.ProvisioningAttempt, 10),
			},
			{Field: gatewayapi.EventTrailFieldState, Value: string(state)},
		},
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit workspace lifecycle: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func externalWorkspaceClaims(ctx context.Context) (gatewayClaims, *apiError) {
	auth, ok := requestAuthState(ctx)
	if !ok || auth.claims == nil {
		return gatewayClaims{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		)
	}
	return *auth.claims, nil
}

func (s *Service) workspaceAccess(ctx context.Context, claims gatewayClaims) ([]gatewaydb.GatewayListAccessibleWorkspacesRow, bool, bool, error) {
	member, err := s.queries.GatewayIsActiveOrganizationMember(
		ctx,
		gatewaydb.GatewayIsActiveOrganizationMemberParams{
			UserID:         claims.UserID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		return nil, false, false, fmt.Errorf("authorize organization entry: %w", err)
	}
	superadmin, err := s.queries.GatewayIsActiveSuperadmin(
		ctx,
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID:         claims.UserID,
			OrganizationID: claims.OrganizationID,
		},
	)
	if err != nil {
		return nil, false, false, fmt.Errorf("authorize workspace creation: %w", err)
	}
	rows, err := s.queries.GatewayListAccessibleWorkspaces(
		ctx,
		gatewaydb.GatewayListAccessibleWorkspacesParams{
			OrganizationID: claims.OrganizationID,
			UserID:         claims.UserID,
		},
	)
	if err != nil {
		return nil, false, false, fmt.Errorf("list accessible workspaces: %w", err)
	}
	return rows, superadmin, member, nil
}

func workspaceView(row gatewaydb.Workspace, workspaceAdminCount int64, canAdminister bool, capabilities resourceCapabilitySet) gatewayapi.Workspace {
	view := gatewayapi.Workspace{
		CanAdminister:                 canAdminister,
		SkillCapabilities:             capabilities.skill,
		McpConnectionCapabilities:     capabilities.mcp,
		SandboxCapabilities:           capabilities.sandbox,
		InferenceProviderCapabilities: capabilities.inferenceProvider,
		InferencePoolCapabilities:     capabilities.inferencePool,
		ApiKeyCapabilities:            capabilities.apiKey,
		ObservabilityCapabilities:     capabilities.observability,
		CreatedAt:                     row.CreatedAt.Time,
		Id:                            row.ID,
		Name:                          row.Name,
		Namespace:                     row.Namespace,
		ProvisioningAttempt:           row.ProvisioningAttempt,
		Slug:                          row.Slug,
		State:                         gatewayapi.WorkspaceState(row.State),
		UpdatedAt:                     row.UpdatedAt.Time,
		WorkspaceAdminCount:           workspaceAdminCount,
	}
	if row.FailureReason.Valid {
		view.FailureReason = &row.FailureReason.String
	}
	return view
}

func (s *Service) ensureWorkspaceResource(ctx context.Context, row gatewaydb.Workspace) error {
	tenant := &agentzv1alpha1.Tenant{}
	tenantName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		row.OrganizationID,
	)
	err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: tenantName}, tenant)
	if err != nil {
		return err
	}
	key := ctrlclient.ObjectKey{Name: row.Namespace}
	var workspace agentzv1alpha1.Workspace
	err = s.k8sClient.Get(ctx, key, &workspace)
	if apierrors.IsNotFound(err) {
		selected, err := s.workspaceResourceSelection(
			ctx, row.ID, row.OrganizationID,
		)
		if err != nil {
			return err
		}
		workspace = agentzv1alpha1.Workspace{
			ObjectMeta: metav1.ObjectMeta{
				Name: row.Namespace,
				Labels: map[string]string{
					agentzv1alpha1.TenantOrganizationIDLabel: tenant.Name,
					agentzv1alpha1.WorkspaceNameLabel:        row.Namespace,
				},
				Annotations: map[string]string{
					agentzv1alpha1.WorkspaceIDAnnotation: row.ID,
				},
				OwnerReferences: []metav1.OwnerReference{*metav1.NewControllerRef(
					tenant,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
				)},
			},
			Spec: agentzv1alpha1.WorkspaceSpec{
				WorkspaceID:                   row.ID,
				OrganizationID:                row.OrganizationID,
				ProvisioningAttempt:           row.ProvisioningAttempt,
				SelectedOrganizationResources: selected,
			},
		}
		return s.k8sClient.Create(ctx, &workspace)
	}
	if err != nil {
		return err
	}
	if workspace.Spec.WorkspaceID != row.ID ||
		workspace.Spec.OrganizationID != row.OrganizationID {
		return fmt.Errorf("workspace resource identity conflicts with database state")
	}
	selected, err := s.workspaceResourceSelection(ctx, row.ID, row.OrganizationID)
	if err != nil {
		return err
	}
	if workspace.Spec.ProvisioningAttempt == row.ProvisioningAttempt &&
		workspace.Spec.SelectedOrganizationResources.Equal(selected) {
		return nil
	}
	workspace.Spec.ProvisioningAttempt = row.ProvisioningAttempt
	workspace.Spec.SelectedOrganizationResources = selected
	return s.k8sClient.Update(ctx, &workspace)
}

func (s *Service) recoverWorkspaceProvisioning(ctx context.Context) error {
	rows, err := s.queries.GatewayListProvisioningWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("list provisioning workspaces: %w", err)
	}
	for _, row := range rows {
		err := s.ensureWorkspaceResource(ctx, row)
		if err == nil {
			continue
		}
		reason := fmt.Sprintf("recover Workspace resource: %v", err)
		_, failErr := s.failWorkspaceProvisioning(
			ctx,
			row,
			reason,
			gatewaydb.EventTrailInterfaceGateway,
		)
		if failErr != nil {
			return failErr
		}
	}
	return nil
}

func (s *Service) failWorkspaceProvisioning(ctx context.Context, row gatewaydb.Workspace, reason string, interfaceName gatewaydb.EventTrailInterface) (gatewaydb.Workspace, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return gatewaydb.Workspace{}, fmt.Errorf("begin fail workspace provisioning: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := gatewaydb.New(tx)
	changed, err := q.GatewayTransitionWorkspaceProvisioning(
		ctx,
		gatewaydb.GatewayTransitionWorkspaceProvisioningParams{
			State:               gatewaydb.WorkspaceStateFailed,
			FailureReason:       pgtype.Text{String: reason, Valid: true},
			UpdatedAt:           pgtype.Timestamptz{Time: time.Now(), Valid: true},
			ID:                  row.ID,
			OrganizationID:      row.OrganizationID,
			ProvisioningAttempt: row.ProvisioningAttempt,
		},
	)
	if err != nil {
		return gatewaydb.Workspace{}, fmt.Errorf("fail workspace provisioning: %w", err)
	}
	if changed == 1 {
		err = createWorkspaceEventTrail(ctx, q, workspaceEventTrail{
			organizationID: row.OrganizationID,
			workspaceID:    row.ID,
			actorType:      gatewaydb.EventTrailActorSystem,
			action:         "workspace.failed",
			result:         gatewaydb.EventTrailResultFailed,
			interfaceName:  interfaceName,
			before: []gatewayapi.EventTrailField{
				{
					Field: gatewayapi.EventTrailFieldProvisioningAttempt,
					Value: strconv.FormatInt(row.ProvisioningAttempt, 10),
				},
				{Field: gatewayapi.EventTrailFieldState, Value: "provisioning"},
			},
			after: []gatewayapi.EventTrailField{
				{
					Field: gatewayapi.EventTrailFieldProvisioningAttempt,
					Value: strconv.FormatInt(row.ProvisioningAttempt, 10),
				},
				{Field: gatewayapi.EventTrailFieldState, Value: "failed"},
			},
		})
		if err != nil {
			return gatewaydb.Workspace{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return gatewaydb.Workspace{}, fmt.Errorf("commit failed workspace provisioning: %w", err)
	}
	current, err := s.queries.GatewayGetWorkspace(
		ctx,
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             row.ID,
			OrganizationID: row.OrganizationID,
		},
	)
	if err != nil {
		return gatewaydb.Workspace{}, fmt.Errorf("read failed workspace provisioning: %w", err)
	}
	return current, nil
}

func createWorkspaceEventTrail(ctx context.Context, q gatewaydb.Querier, eventTrail workspaceEventTrail) error {
	before, err := json.Marshal(eventTrail.before)
	if err != nil {
		return fmt.Errorf("encode workspace event trail before state: %w", err)
	}
	after, err := json.Marshal(eventTrail.after)
	if err != nil {
		return fmt.Errorf("encode workspace event trail after state: %w", err)
	}
	params := gatewaydb.GatewayCreateEventTrailEventParams{
		ID:               "event-trail-" + uuid.NewString(),
		OrganizationID:   eventTrail.organizationID,
		ActorType:        eventTrail.actorType,
		TargetType:       gatewaydb.EventTrailTargetWorkspace,
		TargetID:         eventTrail.workspaceID,
		Category:         "workspace",
		Action:           eventTrail.action,
		Result:           eventTrail.result,
		Before:           before,
		After:            after,
		AutomaticCascade: false,
		Interface:        eventTrail.interfaceName,
	}
	if eventTrail.actorID != "" {
		params.ActorID = pgtype.Text{String: eventTrail.actorID, Valid: true}
	}
	if eventTrail.workspaceID != "" {
		params.WorkspaceID = pgtype.Text{String: eventTrail.workspaceID, Valid: true}
	}
	if eventTrail.request != nil {
		host, _, err := net.SplitHostPort(eventTrail.request.RemoteAddr)
		if err == nil && host != "" {
			params.IpAddress = pgtype.Text{String: host, Valid: true}
		}
		userAgent := strings.TrimSpace(eventTrail.request.UserAgent())
		if userAgent != "" {
			params.UserAgent = pgtype.Text{String: userAgent, Valid: true}
		}
	}
	_, err = q.GatewayCreateEventTrailEvent(ctx, params)
	if err != nil {
		return fmt.Errorf("create workspace event trail event: %w", err)
	}
	return nil
}

func workspaceNotFound(value string) *apiError {
	return newAPIError(
		http.StatusNotFound,
		"workspace_not_found",
		"Workspace was not found",
		fmt.Errorf("workspace %q was not found", value),
	)
}
