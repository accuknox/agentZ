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

	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	workflowRunNameSuffixLen = 10
	workflowRunDeletePoll    = 200 * time.Millisecond
)

var (
	ErrWorkflowRunTerminal         = errors.New("workflow run already has a terminal status")
	ErrWorkflowScheduleRefMismatch = errors.New("workflow run or schedule does not match route scope")
)

type RunPhaseConflictError struct {
	Current clawarmorv1alpha1.WorkflowRunPhase
	Target  clawarmorv1alpha1.WorkflowRunPhase
}

func (e *RunPhaseConflictError) Error() string {
	return fmt.Sprintf(
		"workflow run phase %q cannot transition to %q",
		e.Current,
		e.Target,
	)
}

func ValidateRunStatusRequest(name string, message string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 2)
	if errs := validation.IsDNS1123Subdomain(strings.TrimSpace(name)); len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "must be a valid DNS subdomain",
		})
	}
	if len(message) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "message",
			Message: "must be 4096 characters or fewer",
		})
	}
	return fields
}

func ValidateRunRoute(agtName string, wfName string, schName string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 3)
	fields = append(fields, validateScheduleDNSLabel("agentName", strings.TrimSpace(agtName))...)
	fields = append(fields, validateScheduleDNSLabel("workflowName", strings.TrimSpace(wfName))...)
	fields = append(fields, validateScheduleDNSLabel("scheduleName", strings.TrimSpace(schName))...)
	return fields
}

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

func PatchRunStatus(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, runName string, req gatewayapi.PatchWorkflowRunStatusRequest, msg string) error {
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	phase := clawarmorv1alpha1.WorkflowRunPhase(req.Phase)
	var resultErr error

	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		if err := k8sClient.Get(ctx, key, current); err != nil {
			return err
		}
		if current.Spec.AgentName != strings.TrimSpace(agtName) {
			return ErrWorkflowScheduleRefMismatch
		}
		if current.Spec.WorkflowName != strings.TrimSpace(wfName) {
			return ErrWorkflowScheduleRefMismatch
		}

		if current.Status.Phase.Terminal() {
			if current.Status.Phase == phase && current.Status.Message == msg {
				resultErr = nil
				return nil
			}
			resultErr = ErrWorkflowRunTerminal
			return nil
		}
		if current.Status.Phase != clawarmorv1alpha1.WorkflowRunPhaseRunning {
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

func CreateRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string, tenant *clawarmorv1alpha1.Tenant) (gatewayapi.WorkflowRunSummary, error) {
	schedule, err := getSchedule(ctx, k8sClient, ns, agtName, wfName, schName)
	if err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}

	run := &clawarmorv1alpha1.WorkflowRun{
		TypeMeta: metav1.TypeMeta{
			APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
			Kind:       "WorkflowRun",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      schedule.Name + "-" + workflowRunSuffix(),
			Namespace: ns,
			Labels: map[string]string{
				"clawarmor.accuknox.com/workflow-schedule": schedule.Name,
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					schedule,
					clawarmorv1alpha1.SchemeGroupVersion.WithKind("WorkflowSchedule"),
				),
				{
					APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
					Kind:       "Tenant",
					Name:       tenant.Name,
					UID:        tenant.UID,
				},
			},
		},
		Spec: clawarmorv1alpha1.WorkflowRunSpec{
			AgentName:      schedule.Spec.AgentName,
			WorkflowName:   schedule.Spec.WorkflowName,
			Inputs:         apiextensionsv1.JSON{Raw: schedule.Spec.Inputs.Raw},
			TimeoutSeconds: schedule.Spec.TimeoutSeconds,
			ScheduleRef: &corev1.LocalObjectReference{
				Name: schedule.Name,
			},
		},
	}
	if err := k8sClient.Create(ctx, run); err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}
	if err := k8sClient.Get(ctx, ctrlclient.ObjectKeyFromObject(run), run); err != nil {
		return gatewayapi.WorkflowRunSummary{}, err
	}
	return runSummaryFromCRD(run), nil
}

func ListRuns(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string, status *gatewayapi.WorkflowRunStatus, limit int, offset int) ([]gatewayapi.WorkflowRunSummary, int, error) {
	schedule, err := getSchedule(ctx, k8sClient, ns, agtName, wfName, schName)
	if err != nil {
		return nil, 0, err
	}

	list := &clawarmorv1alpha1.WorkflowRunList{}
	if err := k8sClient.List(ctx, list, ctrlclient.InNamespace(ns)); err != nil {
		return nil, 0, err
	}

	items := make([]gatewayapi.WorkflowRunSummary, 0, len(list.Items))
	for i := range list.Items {
		run := &list.Items[i]
		if run.Spec.AgentName != schedule.Spec.AgentName {
			continue
		}
		if run.Spec.ScheduleRef == nil || run.Spec.ScheduleRef.Name != schedule.Name {
			continue
		}
		if status != nil && string(*status) != string(run.Status.Phase) {
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

func GetRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string, runName string) (gatewayapi.WorkflowRunDetail, error) {
	schedule, err := getSchedule(ctx, k8sClient, ns, agtName, wfName, schName)
	if err != nil {
		return gatewayapi.WorkflowRunDetail{}, err
	}

	run := &clawarmorv1alpha1.WorkflowRun{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	if err := k8sClient.Get(ctx, key, run); err != nil {
		return gatewayapi.WorkflowRunDetail{}, err
	}
	if run.Spec.AgentName != schedule.Spec.AgentName {
		return gatewayapi.WorkflowRunDetail{}, ErrWorkflowScheduleRefMismatch
	}
	if run.Spec.ScheduleRef == nil || run.Spec.ScheduleRef.Name != schedule.Name {
		return gatewayapi.WorkflowRunDetail{}, ErrWorkflowScheduleRefMismatch
	}
	return runDetailFromCRD(run), nil
}

func DeleteRun(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string, runName string) error {
	schedule, err := getSchedule(ctx, k8sClient, ns, agtName, wfName, schName)
	if err != nil {
		return err
	}

	run := &clawarmorv1alpha1.WorkflowRun{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(runName)}
	if err := k8sClient.Get(ctx, key, run); err != nil {
		return err
	}
	if run.Spec.AgentName != schedule.Spec.AgentName {
		return ErrWorkflowScheduleRefMismatch
	}
	if run.Spec.ScheduleRef == nil || run.Spec.ScheduleRef.Name != schedule.Name {
		return ErrWorkflowScheduleRefMismatch
	}

	if err := k8sClient.Delete(ctx, run); err != nil && !apierrors.IsNotFound(err) {
		return err
	}

	ticker := time.NewTicker(workflowRunDeletePoll)
	defer ticker.Stop()

	for {
		current := &clawarmorv1alpha1.WorkflowRun{}
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

func runSummaryFromCRD(run *clawarmorv1alpha1.WorkflowRun) gatewayapi.WorkflowRunSummary {
	summary := gatewayapi.WorkflowRunSummary{
		Name:         run.Name,
		WorkflowName: run.Spec.WorkflowName,
		Status:       workflowRunStatus(run.Status.Phase),
		Reason:       workflowRunReason(run),
		CreatedAt:    run.CreationTimestamp.Time,
	}
	if run.Status.StartedAt != nil && run.Status.CompletedAt != nil {
		durationSeconds := int64(math.Ceil(run.Status.CompletedAt.Time.Sub(run.Status.StartedAt.Time).Seconds()))
		summary.DurationSeconds = &durationSeconds
	}
	return summary
}

func runDetailFromCRD(run *clawarmorv1alpha1.WorkflowRun) gatewayapi.WorkflowRunDetail {
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
	return detail
}

func workflowRunStatus(phase clawarmorv1alpha1.WorkflowRunPhase) gatewayapi.WorkflowRunStatus {
	switch phase {
	case clawarmorv1alpha1.WorkflowRunPhasePending:
		return gatewayapi.WorkflowRunStatusPending
	case clawarmorv1alpha1.WorkflowRunPhaseRunning:
		return gatewayapi.WorkflowRunStatusRunning
	case clawarmorv1alpha1.WorkflowRunPhaseSucceeded:
		return gatewayapi.WorkflowRunStatusSucceeded
	case clawarmorv1alpha1.WorkflowRunPhaseFailed:
		return gatewayapi.WorkflowRunStatusFailed
	case clawarmorv1alpha1.WorkflowRunPhaseUnacked:
		return gatewayapi.WorkflowRunStatusUnacked
	default:
		return gatewayapi.WorkflowRunStatusPending
	}
}

func workflowRunReason(run *clawarmorv1alpha1.WorkflowRun) string {
	if run == nil {
		return ""
	}

	if run.Status.Phase.Terminal() {
		cond := apimeta.FindStatusCondition(
			run.Status.Conditions,
			clawarmorv1alpha1.WorkflowRunConditionReady,
		)
		if cond != nil && cond.Message != "" {
			return cond.Message
		}
		return string(run.Status.Phase)
	}

	cond := apimeta.FindStatusCondition(
		run.Status.Conditions,
		clawarmorv1alpha1.WorkflowRunConditionProgressing,
	)
	if cond != nil && cond.Message != "" {
		return cond.Message
	}
	if run.Status.Phase != clawarmorv1alpha1.WorkflowRunPhaseUnknown {
		return string(run.Status.Phase)
	}
	return clawarmorv1alpha1.WorkflowRunReasonPending
}

func getSchedule(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, schName string) (*clawarmorv1alpha1.WorkflowSchedule, error) {
	schedule := &clawarmorv1alpha1.WorkflowSchedule{}
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(schName)}
	if err := k8sClient.Get(ctx, key, schedule); err != nil {
		return nil, err
	}
	if schedule.Spec.AgentName != strings.TrimSpace(agtName) {
		return nil, ErrWorkflowScheduleRefMismatch
	}
	if schedule.Spec.WorkflowName != strings.TrimSpace(wfName) {
		return nil, ErrWorkflowScheduleRefMismatch
	}
	return schedule, nil
}

func workflowRunSuffix() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

	buf := make([]byte, workflowRunNameSuffixLen)
	max := big.NewInt(int64(len(alphabet)))
	for i := range buf {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		buf[i] = alphabet[n.Int64()]
	}
	return string(buf)
}
