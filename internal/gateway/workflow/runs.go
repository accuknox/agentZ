package workflow

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"math/big"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	workflowRunNameSuffixLen = 10
	workflowRunDeletePoll    = 200 * time.Millisecond
)

var (
	ErrWorkflowRunTerminal      = errors.New("workflow run already has a terminal status")
	ErrWorkflowRunNodeNotFound  = errors.New("workflow run node not found")
	ErrWorkflowRunScopeMismatch = errors.New("workflow run does not match route scope")
)

// RunPhaseConflictError reports one invalid terminal phase transition.
type RunPhaseConflictError struct {
	Current agentzv1alpha1.WorkflowRunPhase
	Target  agentzv1alpha1.WorkflowRunPhase
}

func (e *RunPhaseConflictError) Error() string {
	return fmt.Sprintf(
		"workflow run phase %q cannot transition to %q",
		e.Current,
		e.Target,
	)
}

// NodePhaseConflictError reports one invalid node phase transition.
type NodePhaseConflictError struct {
	Node    string
	Current agentzv1alpha1.WorkflowRunNodePhase
	Target  agentzv1alpha1.WorkflowRunNodePhase
}

func (e *NodePhaseConflictError) Error() string {
	return fmt.Sprintf(
		"workflow run node %q phase %q cannot transition to %q",
		e.Node,
		e.Current,
		e.Target,
	)
}

// ValidateRunStatusMessage validates one terminal status message.
func ValidateRunStatusMessage(message string) []gatewayapi.FieldError {
	if len(message) <= 4096 {
		return nil
	}

	return []gatewayapi.FieldError{{
		Field:   "message",
		Message: "must be 4096 characters or fewer",
	}}
}

// ValidateRunTerminalPhase validates a terminal WorkflowRun patch phase.
func ValidateRunTerminalPhase(phase gatewayapi.WorkflowRunTerminalPhase) []gatewayapi.FieldError {
	switch phase {
	case gatewayapi.WorkflowRunTerminalPhaseSucceeded,
		gatewayapi.WorkflowRunTerminalPhaseFailed:
		return nil
	default:
		return []gatewayapi.FieldError{{
			Field:   "phase",
			Message: "must be Succeeded or Failed",
		}}
	}
}

// ValidateRunNodePatchPhase validates one node status patch phase.
func ValidateRunNodePatchPhase(phase gatewayapi.WorkflowRunNodePatchPhase) []gatewayapi.FieldError {
	switch phase {
	case gatewayapi.WorkflowRunNodePatchPhaseRunning,
		gatewayapi.WorkflowRunNodePatchPhaseSucceeded,
		gatewayapi.WorkflowRunNodePatchPhaseFailed:
		return nil
	default:
		return []gatewayapi.FieldError{{
			Field:   "phase",
			Message: "must be Running, Succeeded, or Failed",
		}}
	}
}

// ValidateRunName validates one workflow run resource name.
func ValidateRunName(name string) []gatewayapi.FieldError {
	name = strings.TrimSpace(name)
	if name == "" {
		return []gatewayapi.FieldError{{
			Field:   "runName",
			Message: "required",
		}}
	}
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return []gatewayapi.FieldError{{
			Field:   "runName",
			Message: "must be a valid DNS subdomain",
		}}
	}
	return nil
}

// ValidateRunListStatus validates one workflow run phase filter.
func ValidateRunListStatus(status *gatewayapi.WorkflowRunStatus) []gatewayapi.FieldError {
	if status == nil {
		return nil
	}

	switch *status {
	case gatewayapi.WorkflowRunStatusPending,
		gatewayapi.WorkflowRunStatusRunning,
		gatewayapi.WorkflowRunStatusSucceeded,
		gatewayapi.WorkflowRunStatusFailed,
		gatewayapi.WorkflowRunStatusUnacked:
		return nil
	default:
		return []gatewayapi.FieldError{{
			Field:   "status",
			Message: "must be a valid workflow run status",
		}}
	}
}

// ValidateRunListFilters validates workflow run trigger filters.
func ValidateRunListFilters(params gatewayapi.ListWorkflowRunsParams) []gatewayapi.FieldError {
	fields := ValidateRunListStatus(params.Status)

	if params.TriggerType != nil {
		switch *params.TriggerType {
		case gatewayapi.Schedule, gatewayapi.Webhook:
		default:
			fields = append(fields, gatewayapi.FieldError{
				Field:   "trigger_type",
				Message: "must be a valid workflow run trigger type",
			})
		}
	}

	if params.ScheduleName != nil {
		name := strings.TrimSpace(*params.ScheduleName)
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "schedule_name",
				Message: "required",
			})
		}
		if errs := validation.IsDNS1123Subdomain(name); name != "" && len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "schedule_name",
				Message: "must be a valid DNS subdomain",
			})
		}
		if params.TriggerType == nil || *params.TriggerType != gatewayapi.Schedule {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "schedule_name",
				Message: "requires trigger_type=Schedule",
			})
		}
	}

	if params.WebhookApiKeyId != nil {
		keyID := strings.TrimSpace(*params.WebhookApiKeyId)
		if keyID == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "webhook_api_key_id",
				Message: "required",
			})
		}
		if params.TriggerType == nil || *params.TriggerType != gatewayapi.Webhook {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "webhook_api_key_id",
				Message: "requires trigger_type=Webhook",
			})
		}
	}

	return fields
}

// ValidateRunWatchNames validates run names used by one watch request.
func ValidateRunWatchNames(runNames *[]gatewayapi.WorkflowRunName) []gatewayapi.FieldError {
	if runNames == nil {
		return nil
	}

	fields := make([]gatewayapi.FieldError, 0, len(*runNames))
	for i, runName := range *runNames {
		if errs := ValidateRunName(runName); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("run_names.%d", i),
				Message: errs[0].Message,
			})
		}
	}
	return fields
}

// PatchRunStatus updates one running workflow run with a terminal phase.
func PatchRunStatus(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, runName string, req gatewayapi.PatchWorkflowRunStatusRequest, msg string) error {
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	phase := agentzv1alpha1.WorkflowRunPhase(req.Phase)
	var resultErr error

	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.WorkflowRun{}
		if err := k8sClient.Get(ctx, key, current); err != nil {
			return err
		}
		if current.Spec.AgentName != strings.TrimSpace(agtName) {
			return ErrWorkflowRunScopeMismatch
		}
		if current.Spec.WorkflowName != strings.TrimSpace(wfName) {
			return ErrWorkflowRunScopeMismatch
		}

		if current.Status.Phase.Terminal() && current.Status.Phase == phase &&
			current.Status.Message == msg {
			resultErr = nil
			return nil
		}
		if current.Status.Phase.Terminal() {
			resultErr = ErrWorkflowRunTerminal
			return nil
		}
		if current.Status.Phase != agentzv1alpha1.WorkflowRunPhaseRunning {
			resultErr = &RunPhaseConflictError{
				Current: current.Status.Phase,
				Target:  phase,
			}
			return nil
		}

		patch := ctrlclient.MergeFrom(current.DeepCopy())
		now := metav1.Now()
		current.Status.Phase = phase
		current.Status.Message = msg
		current.Status.CompletedAt = &now

		if err := k8sClient.Status().Patch(ctx, current, patch); err != nil {
			return err
		}

		resultErr = nil
		return nil
	})
	if err != nil {
		return err
	}
	return resultErr
}

// PatchRunNodeStatus updates one workflow run node phase.
func PatchRunNodeStatus(ctx context.Context, pool *pgxpool.Pool, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, runName string, nodeName string, req gatewayapi.PatchWorkflowRunNodeStatusRequest, msg string) error {
	workflow, err := Get(ctx, pool, ns, agtName, wfName)
	if err != nil {
		return err
	}

	nodeNames := make(map[string]struct{}, len(workflow.Nodes))
	for _, node := range workflow.Nodes {
		nodeNames[node.Name] = struct{}{}
	}
	if _, ok := nodeNames[nodeName]; !ok {
		return ErrWorkflowRunNodeNotFound
	}

	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	phase := agentzv1alpha1.WorkflowRunNodePhase(req.Phase)
	var resultErr error

	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.WorkflowRun{}
		if err := k8sClient.Get(ctx, key, current); err != nil {
			return err
		}
		if current.Spec.AgentName != strings.TrimSpace(agtName) {
			return ErrWorkflowRunScopeMismatch
		}
		if current.Spec.WorkflowName != strings.TrimSpace(wfName) {
			return ErrWorkflowRunScopeMismatch
		}
		if current.Status.Phase.Terminal() {
			resultErr = ErrWorkflowRunTerminal
			return nil
		}
		if current.Status.Phase != agentzv1alpha1.WorkflowRunPhaseRunning {
			resultErr = &RunPhaseConflictError{
				Current: current.Status.Phase,
				Target:  agentzv1alpha1.WorkflowRunPhaseRunning,
			}
			return nil
		}

		nodes := make([]agentzv1alpha1.WorkflowRunNodeStatus, 0, len(workflow.Nodes))
		existing := make(map[string]agentzv1alpha1.WorkflowRunNodeStatus, len(current.Status.Nodes))
		for _, node := range current.Status.Nodes {
			existing[node.Name] = node
		}

		var nodeStatus agentzv1alpha1.WorkflowRunNodeStatus
		for _, node := range workflow.Nodes {
			next := existing[node.Name]
			if next.Name == "" {
				next.Name = node.Name
				next.Phase = agentzv1alpha1.WorkflowRunNodePhaseDisabled
			}
			if node.Name == nodeName {
				nodeStatus = next
			}
			nodes = append(nodes, next)
		}

		switch phase {
		case agentzv1alpha1.WorkflowRunNodePhaseRunning:
		case agentzv1alpha1.WorkflowRunNodePhaseSucceeded,
			agentzv1alpha1.WorkflowRunNodePhaseFailed:
		default:
			resultErr = &NodePhaseConflictError{
				Node:    nodeName,
				Current: nodeStatus.Phase,
				Target:  phase,
			}
			return nil
		}
		if nodeStatus.Phase == phase && nodeStatus.Message == msg {
			resultErr = nil
			return nil
		}

		switch phase {
		case agentzv1alpha1.WorkflowRunNodePhaseRunning:
			if nodeStatus.Phase != agentzv1alpha1.WorkflowRunNodePhaseDisabled {
				resultErr = &NodePhaseConflictError{
					Node:    nodeName,
					Current: nodeStatus.Phase,
					Target:  phase,
				}
				return nil
			}
		case agentzv1alpha1.WorkflowRunNodePhaseSucceeded,
			agentzv1alpha1.WorkflowRunNodePhaseFailed:
			if nodeStatus.Phase != agentzv1alpha1.WorkflowRunNodePhaseRunning {
				resultErr = &NodePhaseConflictError{
					Node:    nodeName,
					Current: nodeStatus.Phase,
					Target:  phase,
				}
				return nil
			}
		}

		patch := ctrlclient.MergeFrom(current.DeepCopy())
		now := metav1.Now()
		for i := range nodes {
			if nodes[i].Name != nodeName {
				continue
			}
			nodes[i].Phase = phase
			nodes[i].Message = msg
			if phase == agentzv1alpha1.WorkflowRunNodePhaseRunning {
				nodes[i].StartedAt = &now
				nodes[i].CompletedAt = nil
			} else {
				nodes[i].CompletedAt = &now
			}
			break
		}
		current.Status.Nodes = nodes

		if err := k8sClient.Status().Patch(ctx, current, patch); err != nil {
			return err
		}

		resultErr = nil
		return nil
	})
	if err != nil {
		return err
	}
	return resultErr
}

// CreateScheduledRun creates one run from one workflow schedule.
func CreateScheduledRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string) (gatewayapi.WorkflowRunSummary, error) {
	schedule, err := getSchedule(ctx, k8sClient, ns, agtName, wfName, schName)
	if err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}

	name, err := workflowRunName(schedule.Name)
	if err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}

	run := &agentzv1alpha1.WorkflowRun{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "WorkflowRun",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels: map[string]string{
				"agentz.accuknox.com/workflow-schedule": schedule.Name,
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					schedule,
					agentzv1alpha1.SchemeGroupVersion.WithKind("WorkflowSchedule"),
				),
			},
		},
		Spec: agentzv1alpha1.WorkflowRunSpec{
			AgentName:      schedule.Spec.AgentName,
			WorkflowName:   schedule.Spec.WorkflowName,
			Inputs:         apiextensionsv1.JSON{Raw: schedule.Spec.Inputs.Raw},
			TimeoutSeconds: schedule.Spec.TimeoutSeconds,
			ScheduleRef: &corev1.LocalObjectReference{
				Name: schedule.Name,
			},
		},
	}

	return createRun(ctx, k8sClient, run)
}

// CreateWebhookRun creates one direct workflow run from a webhook request.
func CreateWebhookRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, inputs []byte, timeoutSeconds int32, apiKeyID string) (gatewayapi.WorkflowRunSummary, error) {
	agent := &agentzv1alpha1.Agent{}
	agentKey := ctrlclient.ObjectKey{Name: agtName, Namespace: ns}
	if err := k8sClient.Get(ctx, agentKey, agent); err != nil {
		return gatewayapi.WorkflowRunSummary{}, fmt.Errorf(
			"get agent %q: %w",
			agtName,
			err,
		)
	}

	name, err := workflowRunName(wfName)
	if err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}

	run := &agentzv1alpha1.WorkflowRun{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "WorkflowRun",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Annotations: map[string]string{
				agentzv1alpha1.WorkflowRunAnnotationWebhookAPIKeyID: apiKeyID,
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					agent,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Agent"),
				),
			},
		},
		Spec: agentzv1alpha1.WorkflowRunSpec{
			AgentName:      agtName,
			WorkflowName:   wfName,
			Inputs:         apiextensionsv1.JSON{Raw: inputs},
			TimeoutSeconds: timeoutSeconds,
		},
	}

	return createRun(ctx, k8sClient, run)
}

// ListWebhookTriggers lists distinct webhook trigger rows for one agent.
func ListWebhookTriggers(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, limit int, offset int) ([]gatewayapi.WorkflowWebhookTrigger, int, error) {
	list := &agentzv1alpha1.WorkflowRunList{}
	if err := k8sClient.List(ctx, list, ctrlclient.InNamespace(ns)); err != nil {
		return nil, 0, err
	}

	itemsByKey := make(map[string]gatewayapi.WorkflowWebhookTrigger, len(list.Items))
	for i := range list.Items {
		run := &list.Items[i]
		if run.Spec.AgentName != agtName {
			continue
		}
		if run.Spec.ScheduleRef != nil {
			continue
		}

		apiKeyID := workflowRunWebhookAPIKeyID(run)
		if apiKeyID == "" {
			continue
		}

		item := gatewayapi.WorkflowWebhookTrigger{
			ApiKeyId:        apiKeyID,
			LastTriggeredAt: run.CreationTimestamp.Time,
			WorkflowName:    run.Spec.WorkflowName,
		}
		key := item.WorkflowName + "\x00" + item.ApiKeyId
		current, ok := itemsByKey[key]
		if ok && !item.LastTriggeredAt.After(current.LastTriggeredAt) {
			continue
		}
		itemsByKey[key] = item
	}

	items := make([]gatewayapi.WorkflowWebhookTrigger, 0, len(itemsByKey))
	for _, item := range itemsByKey {
		items = append(items, item)
	}

	slices.SortFunc(items, func(a, b gatewayapi.WorkflowWebhookTrigger) int {
		if cmp := b.LastTriggeredAt.Compare(a.LastTriggeredAt); cmp != 0 {
			return cmp
		}
		if cmp := strings.Compare(a.WorkflowName, b.WorkflowName); cmp != 0 {
			return cmp
		}
		return strings.Compare(a.ApiKeyId, b.ApiKeyId)
	})

	start := min(offset, len(items))
	end := min(start+limit, len(items))
	nextOffset := 0
	if end < len(items) {
		nextOffset = end
	}
	return items[start:end], nextOffset, nil
}

// ListRuns lists workflow runs for one workflow.
func ListRuns(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, params gatewayapi.ListWorkflowRunsParams, limit int, offset int) ([]gatewayapi.WorkflowRunSummary, int, error) {
	list := &agentzv1alpha1.WorkflowRunList{}
	if err := k8sClient.List(ctx, list, ctrlclient.InNamespace(ns)); err != nil {
		return nil, 0, err
	}

	var scheduleName string
	if params.ScheduleName != nil {
		scheduleName = strings.TrimSpace(*params.ScheduleName)
	}

	var webhookAPIKeyID string
	if params.WebhookApiKeyId != nil {
		webhookAPIKeyID = strings.TrimSpace(*params.WebhookApiKeyId)
	}

	items := make([]gatewayapi.WorkflowRunSummary, 0, len(list.Items))
	for i := range list.Items {
		run := &list.Items[i]
		if run.Spec.AgentName != agtName {
			continue
		}
		if run.Spec.WorkflowName != wfName {
			continue
		}
		if params.Status != nil && string(*params.Status) != string(run.Status.Phase) {
			continue
		}
		if params.TriggerType != nil && *params.TriggerType == gatewayapi.Schedule && run.Spec.ScheduleRef == nil {
			continue
		}
		if params.TriggerType != nil && *params.TriggerType == gatewayapi.Webhook && run.Spec.ScheduleRef != nil {
			continue
		}
		if scheduleName != "" && (run.Spec.ScheduleRef == nil || run.Spec.ScheduleRef.Name != scheduleName) {
			continue
		}
		if webhookAPIKeyID != "" && workflowRunWebhookAPIKeyID(run) != webhookAPIKeyID {
			continue
		}

		items = append(items, runSummaryFromCRD(run))
	}

	slices.SortFunc(items, func(a, b gatewayapi.WorkflowRunSummary) int {
		if !a.CreatedAt.Equal(b.CreatedAt) {
			if a.CreatedAt.After(b.CreatedAt) {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})

	start := min(offset, len(items))
	end := min(start+limit, len(items))
	nextOffset := 0
	if end < len(items) {
		nextOffset = end
	}
	return items[start:end], nextOffset, nil
}

// GetRun returns one workflow run detail.
func GetRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, runName string) (gatewayapi.WorkflowRunDetail, error) {
	run := &agentzv1alpha1.WorkflowRun{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	if err := k8sClient.Get(ctx, key, run); err != nil {
		return gatewayapi.WorkflowRunDetail{}, err
	}
	if run.Spec.AgentName != strings.TrimSpace(agtName) {
		return gatewayapi.WorkflowRunDetail{}, ErrWorkflowRunScopeMismatch
	}
	if run.Spec.WorkflowName != strings.TrimSpace(wfName) {
		return gatewayapi.WorkflowRunDetail{}, ErrWorkflowRunScopeMismatch
	}
	return runDetailFromCRD(run), nil
}

// DeleteRun deletes one workflow run.
func DeleteRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, runName string) error {
	run := &agentzv1alpha1.WorkflowRun{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	if err := k8sClient.Get(ctx, key, run); err != nil {
		return err
	}
	if run.Spec.AgentName != strings.TrimSpace(agtName) {
		return ErrWorkflowRunScopeMismatch
	}
	if run.Spec.WorkflowName != strings.TrimSpace(wfName) {
		return ErrWorkflowRunScopeMismatch
	}

	if err := k8sClient.Delete(ctx, run); err != nil && !apierrors.IsNotFound(err) {
		return err
	}

	ticker := time.NewTicker(workflowRunDeletePoll)
	defer ticker.Stop()

	for {
		current := &agentzv1alpha1.WorkflowRun{}
		err := k8sClient.Get(ctx, key, current)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func createRun(ctx context.Context, k8sClient ctrlclient.Client, run *agentzv1alpha1.WorkflowRun) (gatewayapi.WorkflowRunSummary, error) {
	if err := k8sClient.Create(ctx, run); err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}
	if err := k8sClient.Get(ctx, ctrlclient.ObjectKeyFromObject(run), run); err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}
	return runSummaryFromCRD(run), nil
}

func runSummaryFromCRD(run *agentzv1alpha1.WorkflowRun) gatewayapi.WorkflowRunSummary {
	summary := gatewayapi.WorkflowRunSummary{
		Name:         run.Name,
		WorkflowName: run.Spec.WorkflowName,
		TriggerType:  workflowRunTriggerType(run),
		Status:       workflowRunStatus(run.Status.Phase),
		Reason:       workflowRunReason(run),
		CreatedAt:    run.CreationTimestamp.Time,
	}
	if run.Spec.ScheduleRef != nil {
		summary.ScheduleName = &run.Spec.ScheduleRef.Name
	}
	if run.Status.StartedAt != nil && run.Status.CompletedAt != nil {
		durationSeconds := int64(math.Ceil(run.Status.CompletedAt.Time.Sub(run.Status.StartedAt.Time).Seconds()))
		summary.DurationSeconds = &durationSeconds
	}
	return summary
}

func runDetailFromCRD(run *agentzv1alpha1.WorkflowRun) gatewayapi.WorkflowRunDetail {
	inputs := gatewayapi.JSONValue{}
	raw := run.Spec.Inputs.Raw
	if len(raw) == 0 {
		raw = []byte("null")
	}
	_ = inputs.UnmarshalJSON(raw)

	detail := gatewayapi.WorkflowRunDetail{
		Name:           run.Name,
		AgentName:      run.Spec.AgentName,
		WorkflowName:   run.Spec.WorkflowName,
		TriggerType:    workflowRunTriggerType(run),
		Inputs:         inputs,
		TimeoutSeconds: run.Spec.TimeoutSeconds,
		Status:         workflowRunStatus(run.Status.Phase),
		Reason:         workflowRunReason(run),
		Message:        run.Status.Message,
		CreatedAt:      run.CreationTimestamp.Time,
	}
	if run.Spec.ScheduleRef != nil {
		detail.ScheduleName = &run.Spec.ScheduleRef.Name
	}
	if run.Status.SessionID != "" {
		detail.SessionId = &run.Status.SessionID
	}
	if run.Status.StartedAt != nil {
		startedAt := run.Status.StartedAt.Time
		detail.StartedAt = &startedAt
	}
	if run.Status.CompletedAt != nil {
		completedAt := run.Status.CompletedAt.Time
		detail.CompletedAt = &completedAt
	}
	if run.Status.StartedAt != nil && run.Status.CompletedAt != nil {
		durationSeconds := int64(math.Ceil(run.Status.CompletedAt.Time.Sub(run.Status.StartedAt.Time).Seconds()))
		detail.DurationSeconds = &durationSeconds
	}
	detail.NodeStatuses = make([]gatewayapi.WorkflowRunNodeStatus, 0, len(run.Status.Nodes))
	for _, node := range run.Status.Nodes {
		item := gatewayapi.WorkflowRunNodeStatus{
			Name:    node.Name,
			Phase:   gatewayapi.WorkflowRunNodePhase(node.Phase),
			Message: node.Message,
		}
		if node.StartedAt != nil {
			startedAt := node.StartedAt.Time
			item.StartedAt = &startedAt
		}
		if node.CompletedAt != nil {
			completedAt := node.CompletedAt.Time
			item.CompletedAt = &completedAt
		}
		detail.NodeStatuses = append(detail.NodeStatuses, item)
	}
	return detail
}

func workflowRunStatus(phase agentzv1alpha1.WorkflowRunPhase) gatewayapi.WorkflowRunStatus {
	switch phase {
	case agentzv1alpha1.WorkflowRunPhasePending:
		return gatewayapi.WorkflowRunStatusPending
	case agentzv1alpha1.WorkflowRunPhaseRunning:
		return gatewayapi.WorkflowRunStatusRunning
	case agentzv1alpha1.WorkflowRunPhaseSucceeded:
		return gatewayapi.WorkflowRunStatusSucceeded
	case agentzv1alpha1.WorkflowRunPhaseFailed:
		return gatewayapi.WorkflowRunStatusFailed
	case agentzv1alpha1.WorkflowRunPhaseUnacked:
		return gatewayapi.WorkflowRunStatusUnacked
	default:
		return gatewayapi.WorkflowRunStatusPending
	}
}

func workflowRunReason(run *agentzv1alpha1.WorkflowRun) string {
	if run == nil {
		return ""
	}

	for _, node := range run.Status.Nodes {
		switch node.Phase {
		case agentzv1alpha1.WorkflowRunNodePhaseFailed:
			if node.Message != "" {
				return fmt.Sprintf("node %s failed: %s", node.Name, node.Message)
			}
			return fmt.Sprintf("node %s failed", node.Name)
		case agentzv1alpha1.WorkflowRunNodePhaseRunning:
			if node.Message != "" {
				return fmt.Sprintf("node %s running: %s", node.Name, node.Message)
			}
			return fmt.Sprintf("node %s running", node.Name)
		}
	}

	if run.Status.Phase.Terminal() {
		cond := apimeta.FindStatusCondition(
			run.Status.Conditions,
			agentzv1alpha1.WorkflowRunConditionReady,
		)
		if cond != nil && cond.Message != "" {
			return cond.Message
		}
		return string(run.Status.Phase)
	}

	cond := apimeta.FindStatusCondition(
		run.Status.Conditions,
		agentzv1alpha1.WorkflowRunConditionProgressing,
	)
	if cond != nil && cond.Message != "" {
		return cond.Message
	}
	if run.Status.Phase != agentzv1alpha1.WorkflowRunPhaseUnknown {
		return string(run.Status.Phase)
	}
	return agentzv1alpha1.WorkflowRunReasonPending
}

func workflowRunTriggerType(run *agentzv1alpha1.WorkflowRun) gatewayapi.WorkflowRunTriggerType {
	if run != nil && run.Spec.ScheduleRef != nil {
		return gatewayapi.Schedule
	}
	return gatewayapi.Webhook
}

func workflowRunWebhookAPIKeyID(run *agentzv1alpha1.WorkflowRun) string {
	if run == nil || len(run.Annotations) == 0 {
		return ""
	}
	return strings.TrimSpace(run.Annotations[agentzv1alpha1.WorkflowRunAnnotationWebhookAPIKeyID])
}

func getSchedule(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string) (*agentzv1alpha1.WorkflowSchedule, error) {
	schedule := &agentzv1alpha1.WorkflowSchedule{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(schName)}
	if err := k8sClient.Get(ctx, key, schedule); err != nil {
		return nil, err
	}
	if schedule.Spec.AgentName != strings.TrimSpace(agtName) {
		return nil, ErrWorkflowRunScopeMismatch
	}
	if schedule.Spec.WorkflowName != strings.TrimSpace(wfName) {
		return nil, ErrWorkflowRunScopeMismatch
	}
	return schedule, nil
}

func workflowRunName(prefix string) (string, error) {
	suffix, err := workflowRunSuffix()
	if err != nil {
		return "", err
	}
	return prefix + "-" + suffix, nil
}

func workflowRunSuffix() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

	buf := make([]byte, workflowRunNameSuffixLen)
	max := big.NewInt(int64(len(alphabet)))
	for i := range buf {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", fmt.Errorf("generate workflow run suffix: %w", err)
		}
		buf[i] = alphabet[n.Int64()]
	}
	return string(buf), nil
}
