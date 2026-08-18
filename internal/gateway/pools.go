package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const poolUpdatedAtAnnotation = "agentz.accuknox.com/inference-pool-updated-at"

func (s *Service) resolveInferencePoolAccess(ctx context.Context, workspaceID, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	if workspaceID == "" {
		return resourceAccess{operation: operation}, resourceForbidden(errors.New("inference pool requires a Workspace scope"))
	}
	req := resourceAccessRequest{
		resource:    "Inference Pool",
		workspaceID: workspaceID,
		operation:   operation,
	}
	if name != "" && (operation == authorization.OperationUpdateInferencePool || operation == authorization.OperationDeleteInferencePool) {
		req.creatorFallback = authorization.OperationCreateInferencePool
		req.isCreator = func(ctx context.Context, namespace, userID string) (bool, error) {
			pool := &agentzv1alpha1.InferencePool{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name, Namespace: namespace}, pool)
			return pool.Spec.CreatorUserID == userID, err
		}
	}
	return s.resolveResourceAccess(ctx, req)
}

func (s *Service) createInferencePoolEventTrail(ctx context.Context, access resourceAccess, name string, result gatewaydb.EventTrailResult) error {
	action := "unmapped"
	switch access.operation {
	case authorization.OperationCreateInferencePool:
		action = "create"
	case authorization.OperationUpdateInferencePool:
		action = "modify"
	case authorization.OperationDeleteInferencePool:
		action = "delete"
	}
	return s.createResourceEventTrail(
		ctx,
		access,
		gatewaydb.EventTrailTargetInferencePool,
		name,
		"inference_pool",
		action,
		result,
	)
}

// ListInferencePools handles GET /api/inference/pool.
func (s *Service) ListInferencePools(w http.ResponseWriter, r *http.Request, params gatewayapi.ListInferencePoolsParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, "", authorization.OperationListInferencePools)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	items, err := s.listInferencePoolItems(r.Context(), access, nil)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	start := min(offset, len(items))
	end := min(start+limit, len(items))
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}
	writeJSON(
		w,
		http.StatusOK,
		gatewayapi.ListInferencePoolsResponse{
			Pools: items[start:end], NextPageToken: next,
		},
	)
}

// WatchInferencePools handles POST /api/inference/pool/watch.
func (s *Service) WatchInferencePools(w http.ResponseWriter, r *http.Request, params gatewayapi.WatchInferencePoolsParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, "", authorization.OperationWatchInferencePools)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	var req gatewayapi.WatchInferencePoolsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}
	var filter map[string]struct{}
	if req.PoolIds != nil {
		filter = make(map[string]struct{}, len(*req.PoolIds))
		for _, name := range *req.PoolIds {
			filter[name] = struct{}{}
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"streaming is unavailable",
				nil,
			),
		)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	var previous []gatewayapi.InferencePool
	writeChanges := func() bool {
		items, err := s.listInferencePoolItems(r.Context(), access, filter)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				recordRequestError(w, "internal_error", err)
			}
			return false
		}
		if reflect.DeepEqual(previous, items) {
			return true
		}
		previous = items
		raw, err := json.Marshal(gatewayapi.WatchInferencePoolsEvent{Pools: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !writeChanges() {
		return
	}
	pools, err := s.agentz.AgentzV1alpha1().InferencePools(ns).Watch(
		r.Context(),
		metav1.ListOptions{},
	)
	if err != nil {
		recordRequestError(w, "internal_error", fmt.Errorf("watch inference pools: %w", err))
		return
	}
	defer pools.Stop()
	sandboxes, err := s.agentz.AgentzV1alpha1().Sandboxes(ns).Watch(
		r.Context(),
		metav1.ListOptions{},
	)
	if err != nil {
		recordRequestError(w, "internal_error", fmt.Errorf("watch pool usage: %w", err))
		return
	}
	defer sandboxes.Stop()
	if !writeChanges() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case _, open := <-pools.ResultChan():
			if !open || !writeChanges() {
				return
			}
		case _, open := <-sandboxes.ResultChan():
			if !open || !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) listInferencePoolItems(ctx context.Context, access resourceAccess, filter map[string]struct{}) ([]gatewayapi.InferencePool, error) {
	pools := &agentzv1alpha1.InferencePoolList{}
	if err := s.k8sClient.List(ctx, pools, ctrlclient.InNamespace(access.namespace)); err != nil {
		return nil, fmt.Errorf("list inference pools: %w", err)
	}
	slices.SortFunc(
		pools.Items,
		func(a, b agentzv1alpha1.InferencePool) int {
			return strings.Compare(a.Name, b.Name)
		},
	)
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := s.usageReader.List(ctx, sandboxes, ctrlclient.InNamespace(access.namespace)); err != nil {
		return nil, fmt.Errorf("list inference pool usage: %w", err)
	}
	usage := make(map[string]int)
	for _, sandbox := range sandboxes.Items {
		seen := map[string]struct{}{}
		for _, model := range sandbox.Spec.Inference.Models {
			if model.Provider != agentzv1alpha1.InferencePoolProvider {
				continue
			}
			if _, exists := seen[model.Model]; exists {
				continue
			}
			seen[model.Model] = struct{}{}
			usage[model.Model]++
		}
	}
	items := make([]gatewayapi.InferencePool, 0, len(pools.Items))
	for i := range pools.Items {
		if filter != nil {
			if _, exists := filter[pools.Items[i].Name]; !exists {
				continue
			}
		}
		items = append(items, poolToAPI(&pools.Items[i], usage[pools.Items[i].Name], access))
	}
	return items, nil
}

// CreateInferencePool handles POST /api/inference/pool.
func (s *Service) CreateInferencePool(w http.ResponseWriter, r *http.Request, params gatewayapi.CreateInferencePoolParams) {
	var req gatewayapi.CreateInferencePoolRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	name := "ipl-" + strings.ReplaceAll(uuid.NewString()[:13], "-", "")
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, "", authorization.OperationCreateInferencePool)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			if err := s.createInferencePoolEventTrail(r.Context(), access, name, access.failureResult()); err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	var eventTrailed bool
	defer func() {
		if eventTrailed {
			return
		}
		err := s.createInferencePoolEventTrail(
			context.WithoutCancel(r.Context()),
			access,
			name,
			gatewaydb.EventTrailResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "event trail failed Inference Pool create", slog.Any("err", err))
		}
	}()
	pool := poolFromAPI(access.namespace, name, req)
	pool.Spec.CreatorUserID = access.claims.UserID
	_, issues, err := inference.ResolvePool(r.Context(), s.k8sClient, pool)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(issues) > 0 {
		writeInferenceIssues(w, r, issues)
		return
	}
	issues = validateInferencePoolDependencies(access, pool)
	if len(issues) > 0 {
		writeInferenceIssues(w, r, issues)
		return
	}
	pool.OwnerReferences = []metav1.OwnerReference{access.owner}
	if err := s.k8sClient.Create(r.Context(), pool); err != nil {
		writeError(w, r, mapKubeHTTPError("create inference pool", err))
		return
	}
	eventTrailed = true
	if err := s.createInferencePoolEventTrail(r.Context(), access, name, gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, poolToAPI(pool, 0, access))
}

// GetInferencePool handles GET /api/inference/pool/{poolName}.
func (s *Service) GetInferencePool(w http.ResponseWriter, r *http.Request, poolName gatewayapi.InferencePoolNamePath, params gatewayapi.GetInferencePoolParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, "", authorization.OperationGetInferencePool)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	pool, usage, ok := s.poolAndUsage(w, r, access, poolName)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, poolToAPI(pool, len(usage), access))
}

// UpdateInferencePool handles PUT /api/inference/pool/{poolName}.
func (s *Service) UpdateInferencePool(w http.ResponseWriter, r *http.Request, poolName gatewayapi.InferencePoolNamePath, params gatewayapi.UpdateInferencePoolParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, poolName, authorization.OperationUpdateInferencePool)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			if err := s.createInferencePoolEventTrail(r.Context(), access, poolName, access.failureResult()); err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	var eventTrailed bool
	defer func() {
		if eventTrailed {
			return
		}
		err := s.createInferencePoolEventTrail(
			context.WithoutCancel(r.Context()),
			access,
			poolName,
			gatewaydb.EventTrailResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "event trail failed Inference Pool update", slog.Any("err", err))
		}
	}()
	var req gatewayapi.UpdateInferencePoolRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	current := &agentzv1alpha1.InferencePool{}
	key := ctrlclient.ObjectKey{Namespace: access.namespace, Name: poolName}
	if err := s.k8sClient.Get(r.Context(), key, current); err != nil {
		writeError(w, r, mapKubeHTTPError("get inference pool", err))
		return
	}
	if current.ResourceVersion != req.ResourceVersion {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusConflict,
				"conflict",
				"pool changed since it was loaded",
				apierrors.NewConflict(
					agentzv1alpha1.Resource("inferencepools"),
					current.Name,
					fmt.Errorf("resource version does not match"),
				),
			),
		)
		return
	}
	desired := poolFromAPI(access.namespace, current.Name, req.Pool)
	desired.Spec.CreatorUserID = current.Spec.CreatorUserID
	_, issues, err := inference.ResolvePool(r.Context(), s.k8sClient, desired)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(issues) > 0 {
		writeInferenceIssues(w, r, issues)
		return
	}
	issues = validateInferencePoolDependencies(access, desired)
	if len(issues) > 0 {
		writeInferenceIssues(w, r, issues)
		return
	}
	current.Spec = desired.Spec
	if current.Annotations == nil {
		current.Annotations = map[string]string{}
	}
	current.Annotations[poolUpdatedAtAnnotation] = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.k8sClient.Update(r.Context(), current); err != nil {
		writeError(w, r, mapKubeHTTPError("update inference pool", err))
		return
	}
	eventTrailed = true
	if err := s.createInferencePoolEventTrail(r.Context(), access, poolName, gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	_, usage, ok := s.poolAndUsage(w, r, access, current.Name)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, poolToAPI(current, len(usage), access))
}

// DeleteInferencePool handles DELETE /api/inference/pool/{poolName}.
func (s *Service) DeleteInferencePool(w http.ResponseWriter, r *http.Request, poolName gatewayapi.InferencePoolNamePath, params gatewayapi.DeleteInferencePoolParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, poolName, authorization.OperationDeleteInferencePool)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			if err := s.createInferencePoolEventTrail(r.Context(), access, poolName, access.failureResult()); err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	var eventTrailed bool
	defer func() {
		if eventTrailed {
			return
		}
		if err := s.createInferencePoolEventTrail(context.WithoutCancel(r.Context()), access, poolName, gatewaydb.EventTrailResultFailed); err != nil {
			slog.ErrorContext(r.Context(), "event trail failed Inference Pool delete", slog.Any("err", err))
		}
	}()
	pool, usage, ok := s.poolAndUsage(w, r, access, poolName)
	if !ok {
		return
	}
	if len(usage) > 0 {
		fields := make([]gatewayapi.FieldError, 0, len(usage))
		for _, sandbox := range usage {
			fields = append(fields, gatewayapi.FieldError{Field: "sandboxes", Message: sandbox})
		}
		writeError(
			w,
			r,
			newAPIError(
				http.StatusConflict,
				"pool_referenced",
				"pool is referenced by one or more sandboxes",
				errBadRequest,
				fields...,
			),
		)
		return
	}
	if err := s.k8sClient.Delete(r.Context(), pool); err != nil {
		writeError(w, r, mapKubeHTTPError("delete inference pool", err))
		return
	}
	eventTrailed = true
	if err := s.createInferencePoolEventTrail(r.Context(), access, poolName, gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetInferencePoolUsage handles GET /api/inference/pool/{poolName}/usage.
func (s *Service) GetInferencePoolUsage(w http.ResponseWriter, r *http.Request, poolName gatewayapi.InferencePoolNamePath, params gatewayapi.GetInferencePoolUsageParams) {
	access, apiErr := s.resolveInferencePoolAccess(r.Context(), params.XAgentZWorkspaceID, "", authorization.OperationGetInferencePoolUsage)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	_, usage, ok := s.poolAndUsage(w, r, access, poolName)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferencePoolUsage{Pool: poolName, Sandboxes: usage})
}

func (s *Service) poolAndUsage(w http.ResponseWriter, r *http.Request, access resourceAccess, poolName string) (*agentzv1alpha1.InferencePool, []string, bool) {
	pool := &agentzv1alpha1.InferencePool{}
	key := ctrlclient.ObjectKey{Namespace: access.namespace, Name: strings.TrimSpace(poolName)}
	if err := s.k8sClient.Get(r.Context(), key, pool); err != nil {
		writeError(w, r, mapKubeHTTPError("get inference pool", err))
		return nil, nil, false
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := s.usageReader.List(
		r.Context(),
		sandboxes,
		ctrlclient.InNamespace(access.namespace),
		ctrlclient.MatchingFields{inference.SandboxByPoolIndex: pool.Name},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list inference pool usage: %w", err))
		return nil, nil, false
	}
	usage := make([]string, 0, len(sandboxes.Items))
	for _, sandbox := range sandboxes.Items {
		usage = append(usage, sandbox.Name)
	}
	slices.Sort(usage)
	return pool, usage, true
}

func poolFromAPI(namespace, name string, input gatewayapi.InferencePoolWrite) *agentzv1alpha1.InferencePool {
	members := make([]agentzv1alpha1.InferencePoolMember, 0, len(input.Members))
	for _, member := range input.Members {
		members = append(
			members,
			agentzv1alpha1.InferencePoolMember{
				Scope:    agentzv1alpha1.ResourceScope(member.Scope),
				Provider: member.Provider,
				Model:    member.Model,
			},
		)
	}
	return &agentzv1alpha1.InferencePool{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "InferencePool",
		},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: agentzv1alpha1.InferencePoolSpec{
			DisplayName:       input.DisplayName,
			AutomaticFailover: input.AutomaticFailover,
			Members:           members,
		},
	}
}

func validateInferencePoolDependencies(access resourceAccess, pool *agentzv1alpha1.InferencePool) []inference.Issue {
	issues := []inference.Issue{}
	for i, member := range pool.Spec.Members {
		var workspaceID string
		if member.Scope == agentzv1alpha1.ResourceScopeWorkspace {
			workspaceID = access.workspaceID
		}
		allowed := access.effective.Allows(authorization.Scope{
			OrganizationID: access.claims.OrganizationID,
			WorkspaceID:    workspaceID,
		}, authorization.OperationGetInferenceProvider)
		if allowed {
			continue
		}
		issues = append(
			issues,
			inference.Issue{
				Field:   fmt.Sprintf("members.%d", i),
				Message: "effective Inference Provider read permission is required in the referenced scope",
			},
		)
	}
	return issues
}

func poolToAPI(pool *agentzv1alpha1.InferencePool, usage int, access resourceAccess) gatewayapi.InferencePool {
	state := gatewayapi.InferencePoolState(pool.Status.State)
	if state == "" {
		state = gatewayapi.InferencePoolStateAccepted
	}
	members := make([]gatewayapi.InferencePoolMember, 0, len(pool.Spec.Members))
	for _, member := range pool.Spec.Members {
		members = append(
			members,
			gatewayapi.InferencePoolMember{
				Scope:    gatewayapi.ResourceScope(member.Scope),
				Provider: member.Provider,
				Model:    member.Model,
			},
		)
	}
	conditions := make([]gatewayapi.InferenceProviderCondition, 0, len(pool.Status.Conditions))
	for _, condition := range pool.Status.Conditions {
		conditions = append(
			conditions,
			gatewayapi.InferenceProviderCondition{
				Type: condition.Type, Status: gatewayapi.InferenceProviderConditionStatus(condition.Status),
				Reason: condition.Reason, Message: condition.Message,
			},
		)
	}
	warnings := make([]gatewayapi.InferencePoolWarning, 0, len(pool.Status.Warnings))
	for _, warning := range pool.Status.Warnings {
		warnings = append(
			warnings,
			gatewayapi.InferencePoolWarning{
				Code: gatewayapi.InferencePoolWarningCode(warning.Code), Message: warning.Message,
			},
		)
	}
	statuses := make([]gatewayapi.InferencePoolMemberStatus, 0, len(pool.Status.Members))
	for _, member := range pool.Status.Members {
		statuses = append(
			statuses,
			gatewayapi.InferencePoolMemberStatus{
				Scope:    gatewayapi.ResourceScope(member.Scope),
				Provider: member.Provider,
				Model:    member.Model,
				Protocol: gatewayapi.InferenceProtocol(member.Protocol),
				Ready:    member.Ready,
				Reason:   member.Reason,
				Message:  member.Message,
			},
		)
	}
	updatedAt := pool.CreationTimestamp.Time
	if raw := pool.Annotations[poolUpdatedAtAnnotation]; raw != "" {
		if value, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			updatedAt = value
		}
	}
	out := gatewayapi.InferencePool{
		Id: pool.Name, DisplayName: pool.Spec.DisplayName,
		ResourceVersion:   pool.ResourceVersion,
		AutomaticFailover: pool.Spec.AutomaticFailover,
		Members:           members, State: state, Conditions: conditions,
		Warnings: warnings, MemberStatuses: statuses, UsageCount: usage,
		CreatedAt: pool.CreationTimestamp.Time, UpdatedAt: updatedAt,
	}
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	creator := pool.Spec.CreatorUserID == access.claims.UserID &&
		access.effective.Allows(scope, authorization.OperationCreateInferencePool)
	out.CanModify = access.effective.Allows(scope, authorization.OperationUpdateInferencePool) || creator
	out.CanDelete = access.effective.Allows(scope, authorization.OperationDeleteInferencePool) || creator
	if pool.Status.Protocol != "" {
		protocol := gatewayapi.InferenceProtocol(pool.Status.Protocol)
		out.Protocol = &protocol
	}
	if pool.Status.Contract != nil {
		contract := pool.Status.Contract
		input := make([]gatewayapi.InferenceModelModality, len(contract.Modalities.Input))
		for i, modality := range contract.Modalities.Input {
			input[i] = gatewayapi.InferenceModelModality(modality)
		}
		output := make([]gatewayapi.InferenceModelModality, len(contract.Modalities.Output))
		for i, modality := range contract.Modalities.Output {
			output[i] = gatewayapi.InferenceModelModality(modality)
		}
		out.Contract = &gatewayapi.InferencePoolContract{
			Api: gatewayapi.InferenceModelAPI(contract.API),
			Capabilities: gatewayapi.InferenceModelCapabilities{
				Attachment:  contract.Capabilities.Attachment,
				Reasoning:   contract.Capabilities.Reasoning,
				Temperature: contract.Capabilities.Temperature,
				ToolCall:    contract.Capabilities.ToolCall,
			},
			Modalities: gatewayapi.InferenceModelModalities{Input: input, Output: output},
			Limits: gatewayapi.InferenceModelLimits{
				Context: contract.Limits.Context,
				Input:   contract.Limits.Input,
				Output:  contract.Limits.Output,
			},
		}
	}
	return out
}
