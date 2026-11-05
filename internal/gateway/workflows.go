package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	workflowstore "github.com/accuknox/agentz/internal/gateway/workflow"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
)

// GetWorkflow handles GET /api/workflow/{agentName}/{workflowName}.
func (s *Service) GetWorkflow(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)

	fields := workflowstore.ValidateLookupRequest(agtName, workflowName)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	workflow, err := workflowstore.Get(
		r.Context(),
		s.db,
		ns,
		agtName,
		workflowName,
	)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapGetError(err))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, workflow)
}

// CreateWorkflow handles POST /api/workflow/{agentName}.
func (s *Service) CreateWorkflow(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.CreateWorkflowRequest
	if err := apiutil.DecodeJSONBody(r, &req, false); err != nil {
		if apiErr, ok := errors.AsType[*apiutil.APIError](err); ok {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	req.WorkflowName = strings.TrimSpace(req.WorkflowName)
	req.Title = strings.TrimSpace(req.Title)
	req.Summary = strings.TrimSpace(req.Summary)
	if req.Inputs != nil {
		for name, input := range *req.Inputs {
			if input.Description != nil {
				trimmed := strings.TrimSpace(*input.Description)
				input.Description = &trimmed
			}
			if input.Pattern != nil {
				trimmed := strings.TrimSpace(*input.Pattern)
				input.Pattern = &trimmed
			}
			(*req.Inputs)[name] = input
		}
	}
	if req.ArbitraryJson != nil && req.ArbitraryJson.Description != nil {
		trimmed := strings.TrimSpace(*req.ArbitraryJson.Description)
		req.ArbitraryJson.Description = &trimmed
	}

	for nodeIndex := range req.Nodes {
		node := &req.Nodes[nodeIndex]
		node.Name = strings.TrimSpace(node.Name)
		node.Instructions = strings.TrimSpace(node.Instructions)
		node.Goal = strings.TrimSpace(node.Goal)
		node.DoneCriteria = strings.TrimSpace(node.DoneCriteria)

		if node.PreferredTools != nil {
			for toolIndex, toolName := range *node.PreferredTools {
				(*node.PreferredTools)[toolIndex] = strings.TrimSpace(toolName)
			}
		}
		if node.PreferredSkills != nil {
			for skillIndex, skillName := range *node.PreferredSkills {
				(*node.PreferredSkills)[skillIndex] = strings.TrimSpace(skillName)
			}
		}
	}

	for edgeIndex := range req.Edges {
		edge := &req.Edges[edgeIndex]
		edge.Source = strings.TrimSpace(edge.Source)
		edge.Target = strings.TrimSpace(edge.Target)
		edge.BranchLabel = strings.TrimSpace(edge.BranchLabel)
		edge.ConditionSummary = strings.TrimSpace(edge.ConditionSummary)
	}

	fields, err := workflowstore.ValidateCreateRequest(agtName, req)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	row, err := workflowstore.Create(r.Context(), s.workflowDB, s.k8sClient, ns, agtName, req)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapMutationError(err))
		return
	}

	apiutil.WriteJSON(
		w,
		http.StatusCreated,
		gatewayapi.Workflow{
			Lock:          row.LockState,
			AgentName:     agtName,
			WorkflowName:  req.WorkflowName,
			Title:         req.Title,
			Summary:       req.Summary,
			Inputs:        req.Inputs,
			ArbitraryJson: req.ArbitraryJson,
			Nodes:         req.Nodes,
			Edges:         req.Edges,
			CreatedAt:     row.CreatedAt,
			UpdatedAt:     row.UpdatedAt,
		},
	)
}

// DeleteWorkflows handles DELETE /api/workflow/{agentName}.
func (s *Service) DeleteWorkflows(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.DeleteWorkflowsRequest
	if err := apiutil.DecodeJSONBody(r, &req, false); err != nil {
		if apiErr, ok := errors.AsType[*apiutil.APIError](err); ok {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	for i := range req.WorkflowNames {
		req.WorkflowNames[i] = strings.TrimSpace(req.WorkflowNames[i])
	}

	fields := workflowstore.ValidateDeleteRequest(agtName, req.WorkflowNames)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	err = workflowstore.DeleteMany(
		r.Context(),
		s.workflowDB,
		s.k8sClient,
		ns,
		agtName,
		req.WorkflowNames,
	)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapMutationError(err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

var _ gatewayapi.ServerInterface = (*Service)(nil)

// ListWorkflowSummaries handles GET /api/workflow/{agentName}.
func (s *Service) ListWorkflowSummaries(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)

	fields := workflowstore.ValidateListRequest(agtName)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	summaries, err := workflowstore.ListSummaries(r.Context(), s.db, ns, agtName)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, summaries)
}

// SetWorkflowLock changes workflow protection only for a live browser user with agent Use access.
func (s *Service) SetWorkflowLock(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.actorType != requestActorUser || auth.claims == nil || auth.claims.BrowserSessionID == "" {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("workflow locks can only be changed by a user in the Workflows page")))
		return
	}
	expiry, err := s.queries.GatewayGetBrowserSessionExpiry(r.Context(), gatewaydb.GatewayGetBrowserSessionExpiryParams{
		ID:     auth.claims.BrowserSessionID,
		UserID: auth.claims.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !expiry.After(time.Now()) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusUnauthorized,
			"unauthorized",
			"browser session has expired",
			err,
		))
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var req gatewayapi.SetWorkflowLockRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	fields := workflowstore.ValidateLookupRequest(agentName, workflowName)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}
	tx, err := s.workflowDB.Begin(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := workflowstore.LockDefinitions(r.Context(), tx, access.namespace, agentName, []string{workflowName})
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapMutationError(err))
		return
	}
	state := rows[0].LockState
	if state.Version != req.ExpectedVersion {
		apiErr := apiutil.NewError(
			http.StatusConflict,
			"workflow_lock_conflict",
			"workflow lock changed; review its current state and try again",
			nil,
		)
		apiErr.CurrentWorkflowLock = &state
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if state.Locked == req.Locked {
		apiutil.WriteJSON(w, http.StatusOK, state)
		return
	}
	actors, err := s.resourceActors(r.Context(), access.userID)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	actor := actors[access.userID]
	now := time.Now().UTC()
	before := "unlocked"
	after := "locked"
	if !req.Locked {
		before, after = after, before
	}
	state = gatewayapi.WorkflowLock{
		Locked:    req.Locked,
		Version:   state.Version + 1,
		ChangedAt: &now,
		Actor:     &actor,
	}
	err = workflowdb.New(tx).WorkflowSetLock(r.Context(), workflowdb.WorkflowSetLockParams{
		TenantNamespace: access.namespace,
		AgentName:       agentName,
		WorkflowName:    workflowName,
		LockState:       state,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	beforeJSON, err := json.Marshal([]gatewayapi.EventTrailField{{
		Field: gatewayapi.EventTrailFieldState,
		Value: before,
	}})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	afterJSON, err := json.Marshal([]gatewayapi.EventTrailField{{
		Field: gatewayapi.EventTrailFieldState,
		Value: after,
	}})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	_, err = gatewaydb.New(tx).GatewayCreateEventTrailEvent(r.Context(), gatewaydb.GatewayCreateEventTrailEventParams{
		ID:             "event-trail-" + uuid.NewString(),
		OrganizationID: access.organizationID,
		WorkspaceID:    pgtype.Text{String: access.workspaceID, Valid: true},
		ActorType:      gatewaydb.EventTrailActorUser,
		ActorID:        pgtype.Text{String: access.userID, Valid: true},
		TargetType:     gatewaydb.EventTrailTargetWorkflow,
		TargetID:       agentName + "/" + workflowName,
		Category:       "workflow",
		Action:         "workflow." + after,
		Result:         gatewaydb.EventTrailResultSucceeded,
		Before:         beforeJSON,
		After:          afterJSON,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, state)
}
