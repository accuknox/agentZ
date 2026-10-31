package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateWorkflowSchedule handles POST /api/workflow/{agentName}/{workflowName}/schedule.
func (s *Service) CreateWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.CreateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateScheduleCreateRequest(agentName, workflowName, &req)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	fields, err = workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		ns,
		agentName,
		workflowName,
		req.Inputs,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	if req.ContextSessionId != nil {
		auth, _ := requestAuthState(r.Context())
		if auth.actorType != requestActorSystem {
			apiutil.WriteError(w, r, resourceForbidden(errors.New("tool context requires an authenticated agent")))
			return
		}
		access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		root, private, lookupErr := s.privateChatRoot(r.Context(), access, agentName, *req.ContextSessionId)
		if lookupErr != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("get conversation", lookupErr))
			return
		}
		if private && root.SessionID == *req.ContextSessionId {
			req.Delivery = &gatewayapi.WorkflowDelivery{SessionId: root.SessionID}
		}
	}
	delivery, bindingErr := s.workflowDelivery(r.Context(), agentName, req.Delivery)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("bind conversation", bindingErr))
		return
	}
	resp, err := workflow.CreateSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		req,
		delivery,
	)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("create workflow schedule", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusCreated, resp)
}

// ListAgentWorkflowSchedules handles GET /api/workflow/{agentName}/schedule.
func (s *Service) ListAgentWorkflowSchedules(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.ListAgentWorkflowSchedulesParams) {
	actor, _ := requestAuthState(r.Context())
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	fields := workflow.ValidateAgentScheduleList(agentName)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"limit must be between 1 and 200",
				errBadRequest,
			),
		)
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	sortBy := gatewayapi.WorkflowScheduleSortByQueryWorkflowScheduleSortName
	if params.SortBy != nil {
		sortBy = gatewayapi.WorkflowScheduleSortByQuery(*params.SortBy)
	}
	sortOrder := gatewayapi.SortOrderQueryAsc
	if params.SortOrder != nil {
		sortOrder = gatewayapi.SortOrderQuery(*params.SortOrder)
	}

	destinations, err := s.workflowDestinations(r.Context(), agentName)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("list workflow destinations", err))
		return
	}
	items, nextOffset, err := workflow.ListSchedules(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		"",
		sortBy,
		sortOrder,
		limit,
		offset,
		actor.userID,
		destinations,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("list workflow schedules: %w", err))
		return
	}

	resp := gatewayapi.ListWorkflowSchedulesResponse{
		WorkflowSchedules: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// ListWorkflowSchedules handles GET /api/workflow/{agentName}/{workflowName}/schedule.
func (s *Service) ListWorkflowSchedules(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.ListWorkflowSchedulesParams) {
	actor, _ := requestAuthState(r.Context())
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateScheduleList(agentName, workflowName)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"limit must be between 1 and 200",
				errBadRequest,
			),
		)
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	sortBy := gatewayapi.WorkflowScheduleSortByQueryWorkflowScheduleSortName
	if params.SortBy != nil {
		sortBy = gatewayapi.WorkflowScheduleSortByQuery(*params.SortBy)
	}
	sortOrder := gatewayapi.SortOrderQueryAsc
	if params.SortOrder != nil {
		sortOrder = gatewayapi.SortOrderQuery(*params.SortOrder)
	}

	destinations, err := s.workflowDestinations(r.Context(), agentName)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("list workflow destinations", err))
		return
	}
	items, nextOffset, err := workflow.ListSchedules(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		sortBy,
		sortOrder,
		limit,
		offset,
		actor.userID,
		destinations,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("list workflow schedules: %w", err))
		return
	}

	resp := gatewayapi.ListWorkflowSchedulesResponse{
		WorkflowSchedules: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// DeleteWorkflowSchedule handles DELETE /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}.
func (s *Service) DeleteWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	err = s.authorizeWorkflowSchedule(r.Context(), ns, agentName, workflowName, scheduleName)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow schedule", err))
		return
	}

	fields := workflow.ValidateScheduleLookup(agentName, workflowName, scheduleName)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	err = workflow.DeleteSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		scheduleName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"delete workflow schedule not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("delete workflow schedule", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateWorkflowSchedule handles PUT /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}.
func (s *Service) UpdateWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	err = s.authorizeWorkflowSchedule(r.Context(), ns, agentName, workflowName, scheduleName)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow schedule", err))
		return
	}

	fields := workflow.ValidateScheduleUpdateRequest(
		agentName,
		workflowName,
		scheduleName,
		&req,
	)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	fields, err = workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		ns,
		agentName,
		workflowName,
		req.Inputs,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	delivery, bindingErr := s.workflowDelivery(r.Context(), agentName, req.Delivery)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("bind conversation", bindingErr))
		return
	}
	resp, err := workflow.UpdateSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		scheduleName,
		req,
		delivery,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"update workflow schedule not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("update workflow schedule", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// CreateWorkflowRun handles POST /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run.
func (s *Service) CreateWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	err = s.authorizeWorkflowSchedule(r.Context(), ns, agtName, workflowName, scheduleName)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow schedule", err))
		return
	}

	fields := workflow.ValidateScheduleLookup(agtName, workflowName, scheduleName)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	resp, err := workflow.CreateScheduledRun(
		r.Context(),
		s.k8sClient,
		ns,
		agtName,
		workflowName,
		scheduleName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"create workflow run not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("create workflow run", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusAccepted, resp)
}

func (s *Service) workflowDelivery(ctx context.Context, agent string, input *gatewayapi.WorkflowDelivery) (*agentzv1alpha1.WorkflowDelivery, error) {
	if input == nil {
		return nil, nil
	}
	access, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		return nil, apiErr
	}
	auth, _ := requestAuthState(ctx)
	var root gatewaydb.ChatSession
	var err error
	// The agent tool context identifies a conversation within its shared runtime.
	switch auth.actorType {
	case requestActorSystem:
		root, err = s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   input.SessionId,
		})
	default:
		root, _, err = s.authorizeChat(ctx, access, agent, input.SessionId)
	}

	if err != nil {
		return nil, err
	}
	if !root.Pulse || root.SessionID != input.SessionId {
		return nil, pgx.ErrNoRows
	}
	delivery := &agentzv1alpha1.WorkflowDelivery{
		SessionID:  root.SessionID,
		OwnerID:    root.OwnerID.String,
		Generation: root.Generation,
	}
	if err := s.authorizeWorkflowDelivery(ctx, access, agent, delivery); err != nil {
		return nil, err
	}
	return delivery, nil
}

func (s *Service) authorizeWorkflowSchedule(ctx context.Context, namespace, agent, workflowName, name string) error {
	schedule := &agentzv1alpha1.WorkflowSchedule{}
	err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, schedule)
	if err != nil {
		return err
	}
	if schedule.Spec.AgentName != agent || schedule.Spec.WorkflowName != workflowName {
		return pgx.ErrNoRows
	}
	if schedule.Spec.Delivery == nil {
		return nil
	}
	auth, _ := requestAuthState(ctx)
	if auth.actorType != requestActorSystem && auth.userID != schedule.Spec.Delivery.OwnerID {
		return pgx.ErrNoRows
	}
	access, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		return apiErr
	}
	return s.authorizeWorkflowDelivery(ctx, access, agent, schedule.Spec.Delivery)
}
