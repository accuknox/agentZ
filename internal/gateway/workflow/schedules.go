package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	inputworkflow "github.com/accuknox/clawarmor/internal/workflow"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

var ErrScheduleAgentMismatch = errors.New("workflow schedule agent mismatch")

const defaultRunsHistoryLimit int32 = 3

type scheduleSpecInput struct {
	workflowName               string
	schedule                   string
	timeZone                   *string
	inputs                     *gatewayapi.JSONValue
	timeoutSeconds             int32
	suspend                    *bool
	successfulRunsHistoryLimit *int32
	failedRunsHistoryLimit     *int32
}

func ValidateScheduleCreateRequest(req *gatewayapi.CreateWorkflowScheduleRequest) []gatewayapi.FieldError {
	req.Name = strings.TrimSpace(req.Name)
	req.AgentName = strings.TrimSpace(req.AgentName)
	var timeZone *string
	if req.TimeZone != nil {
		name := strings.TrimSpace(*req.TimeZone)
		if name != "" {
			timeZone = &name
		}
	}
	specInput := scheduleSpecInput{
		workflowName:               strings.TrimSpace(req.WorkflowName),
		schedule:                   strings.TrimSpace(req.Schedule),
		timeZone:                   timeZone,
		inputs:                     req.Inputs,
		timeoutSeconds:             req.TimeoutSeconds,
		suspend:                    req.Suspend,
		successfulRunsHistoryLimit: req.SuccessfulRunsHistoryLimit,
		failedRunsHistoryLimit:     req.FailedRunsHistoryLimit,
	}
	req.WorkflowName = specInput.workflowName
	req.Schedule = specInput.schedule
	req.TimeZone = specInput.timeZone

	return validateScheduleRequest(req.AgentName, req.Name, specInput)
}

func ValidateScheduleUpdateRequest(agtName string, name string, req *gatewayapi.UpdateWorkflowScheduleRequest) []gatewayapi.FieldError {
	var timeZone *string
	if req.TimeZone != nil {
		name := strings.TrimSpace(*req.TimeZone)
		if name != "" {
			timeZone = &name
		}
	}
	specInput := scheduleSpecInput{
		workflowName:               strings.TrimSpace(req.WorkflowName),
		schedule:                   strings.TrimSpace(req.Schedule),
		timeZone:                   timeZone,
		inputs:                     req.Inputs,
		timeoutSeconds:             req.TimeoutSeconds,
		suspend:                    req.Suspend,
		successfulRunsHistoryLimit: req.SuccessfulRunsHistoryLimit,
		failedRunsHistoryLimit:     req.FailedRunsHistoryLimit,
	}
	req.WorkflowName = specInput.workflowName
	req.Schedule = specInput.schedule
	req.TimeZone = specInput.timeZone

	return validateScheduleRequest(
		strings.TrimSpace(agtName),
		strings.TrimSpace(name),
		specInput,
	)
}

func ValidateScheduleLookup(agtName string, name string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 2)
	fields = append(fields, validateScheduleDNSLabel("agent_name", strings.TrimSpace(agtName))...)
	fields = append(fields, validateScheduleDNSLabel("name", strings.TrimSpace(name))...)
	return fields
}

func ValidateScheduleList(agtName string, wfName *gatewayapi.WorkflowName) (string, []gatewayapi.FieldError) {
	agtName = strings.TrimSpace(agtName)
	fields := validateScheduleDNSLabel("agent_name", agtName)

	name := ""
	if wfName != nil {
		name = strings.TrimSpace(*wfName)
		fields = append(fields, validateScheduleDNSLabel("workflow_name", name)...)
	}
	return name, fields
}

func ValidateScheduleInputs(ctx context.Context, db *pgxpool.Pool, agtName string, wfName string, inputs *gatewayapi.JSONValue) ([]gatewayapi.FieldError, error) {
	def, err := Get(ctx, db, agtName, wfName)
	if err != nil {
		if errors.Is(err, ErrWorkflowNotFound) {
			return []gatewayapi.FieldError{{
				Field:   "workflow_name",
				Message: "referenced workflow was not found",
			}}, nil
		}
		return nil, err
	}

	rawInputs, err := marshalScheduleInputs(inputs)
	if err != nil {
		return nil, err
	}

	issues, err := inputworkflow.ValidateValues(rawInputs, def.Inputs, "inputs")
	if err != nil {
		return nil, err
	}
	if len(issues) == 0 {
		return nil, nil
	}

	fields := make([]gatewayapi.FieldError, 0, len(issues))
	for _, issue := range issues {
		fields = append(fields, gatewayapi.FieldError{
			Field:   issue.Field,
			Message: issue.Message,
		})
	}
	return fields, nil
}

func CreateSchedule(ctx context.Context, k8sClient ctrlclient.Client, ns string, req gatewayapi.CreateWorkflowScheduleRequest) (gatewayapi.WorkflowSchedule, error) {
	specInput := scheduleSpecInput{
		workflowName:               req.WorkflowName,
		schedule:                   req.Schedule,
		timeZone:                   req.TimeZone,
		inputs:                     req.Inputs,
		timeoutSeconds:             req.TimeoutSeconds,
		suspend:                    req.Suspend,
		successfulRunsHistoryLimit: req.SuccessfulRunsHistoryLimit,
		failedRunsHistoryLimit:     req.FailedRunsHistoryLimit,
	}

	inputsJSON, err := marshalScheduleInputs(specInput.inputs)
	if err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}

	agt := &clawarmorv1alpha1.Agent{}
	agtKey := ctrlclient.ObjectKey{
		Name:      req.AgentName,
		Namespace: ns,
	}
	err = k8sClient.Get(ctx, agtKey, agt)
	if err != nil {
		return gatewayapi.WorkflowSchedule{}, fmt.Errorf(
			"get agent %q: %w",
			req.AgentName,
			err,
		)
	}

	schedule := &clawarmorv1alpha1.WorkflowSchedule{
		TypeMeta: metav1.TypeMeta{
			APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
			Kind:       "WorkflowSchedule",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: ns,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
				Kind:       "Agent",
				Name:       agt.Name,
				UID:        agt.UID,
			}},
		},
	}
	applyScheduleSpec(&schedule.Spec, req.AgentName, specInput, inputsJSON)

	if err := k8sClient.Create(ctx, schedule); err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}
	if err := k8sClient.Get(ctx, ctrlclient.ObjectKeyFromObject(schedule), schedule); err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}

	return scheduleViewFromCRD(schedule)
}

func ListSchedules(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, wfName string, limit int, offset int) ([]gatewayapi.WorkflowSchedule, int, error) {
	list := &clawarmorv1alpha1.WorkflowScheduleList{}
	if err := k8sClient.List(ctx, list, ctrlclient.InNamespace(ns)); err != nil {
		return nil, 0, err
	}

	items := make([]gatewayapi.WorkflowSchedule, 0, len(list.Items))
	for i := range list.Items {
		schedule := &list.Items[i]
		if schedule.Spec.AgentName != agtName {
			continue
		}
		if wfName != "" && schedule.Spec.WorkflowName != wfName {
			continue
		}

		item, err := scheduleViewFromCRD(schedule)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}

	slices.SortFunc(items, func(a, b gatewayapi.WorkflowSchedule) int {
		if cmp := strings.Compare(a.Name, b.Name); cmp != 0 {
			return cmp
		}
		return a.CreatedAt.Compare(b.CreatedAt)
	})

	start := min(offset, len(items))
	end := min(start+limit, len(items))
	nextOffset := 0
	if end < len(items) {
		nextOffset = end
	}
	return items[start:end], nextOffset, nil
}

func DeleteSchedule(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, name string) error {
	schedule := &clawarmorv1alpha1.WorkflowSchedule{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: ns}
	if err := k8sClient.Get(ctx, key, schedule); err != nil {
		return err
	}
	if schedule.Spec.AgentName != agtName {
		return ErrScheduleAgentMismatch
	}
	return k8sClient.Delete(ctx, schedule)
}

func UpdateSchedule(ctx context.Context, k8sClient ctrlclient.Client, ns string, agtName string, name string, req gatewayapi.UpdateWorkflowScheduleRequest) (gatewayapi.WorkflowSchedule, error) {
	current := &clawarmorv1alpha1.WorkflowSchedule{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: ns}
	if err := k8sClient.Get(ctx, key, current); err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}
	if current.Spec.AgentName != agtName {
		return gatewayapi.WorkflowSchedule{}, ErrScheduleAgentMismatch
	}

	specInput := scheduleSpecInput{
		workflowName:               req.WorkflowName,
		schedule:                   req.Schedule,
		timeZone:                   req.TimeZone,
		inputs:                     req.Inputs,
		timeoutSeconds:             req.TimeoutSeconds,
		suspend:                    req.Suspend,
		successfulRunsHistoryLimit: req.SuccessfulRunsHistoryLimit,
		failedRunsHistoryLimit:     req.FailedRunsHistoryLimit,
	}

	inputsJSON, err := marshalScheduleInputs(specInput.inputs)
	if err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}

	updated := &clawarmorv1alpha1.WorkflowSchedule{}
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		if err := k8sClient.Get(ctx, key, current); err != nil {
			return err
		}

		applyScheduleSpec(&current.Spec, agtName, specInput, inputsJSON)

		if err := k8sClient.Update(ctx, current); err != nil {
			return err
		}
		updated = current
		return nil
	})
	if err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}
	if err := k8sClient.Get(ctx, ctrlclient.ObjectKeyFromObject(updated), updated); err != nil {
		return gatewayapi.WorkflowSchedule{}, err
	}

	return scheduleViewFromCRD(updated)
}

func scheduleViewFromCRD(schedule *clawarmorv1alpha1.WorkflowSchedule) (gatewayapi.WorkflowSchedule, error) {
	inputs := gatewayapi.JSONValue{}
	raw := schedule.Spec.Inputs.Raw
	if len(raw) == 0 {
		raw = []byte("null")
	}
	if err := inputs.UnmarshalJSON(raw); err != nil {
		return gatewayapi.WorkflowSchedule{}, fmt.Errorf("decode schedule inputs: %w", err)
	}

	view := gatewayapi.WorkflowSchedule{
		Name:           schedule.Name,
		AgentName:      schedule.Spec.AgentName,
		WorkflowName:   schedule.Spec.WorkflowName,
		Schedule:       schedule.Spec.Schedule,
		Inputs:         inputs,
		TimeoutSeconds: schedule.Spec.TimeoutSeconds,
		Suspend:        schedule.Spec.Suspend,
		CreatedAt:      schedule.CreationTimestamp.Time,
	}
	if schedule.Spec.TimeZone != "" {
		view.TimeZone = &schedule.Spec.TimeZone
	}
	if schedule.Spec.SuccessfulRunsHistoryLimit != nil {
		view.SuccessfulRunsHistoryLimit = *schedule.Spec.SuccessfulRunsHistoryLimit
	}
	if schedule.Spec.FailedRunsHistoryLimit != nil {
		view.FailedRunsHistoryLimit = *schedule.Spec.FailedRunsHistoryLimit
	}
	return view, nil
}

func marshalScheduleInputs(value *gatewayapi.JSONValue) ([]byte, error) {
	if value == nil {
		return []byte("null"), nil
	}

	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal schedule inputs: %w", err)
	}
	return raw, nil
}

func validateScheduleRequest(agtName string, name string, specInput scheduleSpecInput) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 5)
	fields = append(fields, validateScheduleDNSLabel("agent_name", agtName)...)
	fields = append(fields, validateScheduleDNSLabel("name", name)...)
	fields = append(fields, validateScheduleDNSLabel("workflow_name", specInput.workflowName)...)
	if specInput.schedule == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "schedule",
			Message: "required",
		})
	}
	if specInput.schedule != "" {
		err := inputworkflow.ValidateCronSchedule(specInput.schedule)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "schedule",
				Message: err.Error(),
			})
		}
	}
	if specInput.timeZone != nil {
		err := inputworkflow.ValidateTimeZone(*specInput.timeZone)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "time_zone",
				Message: err.Error(),
			})
		}
	}
	return fields
}

func applyScheduleSpec(spec *clawarmorv1alpha1.WorkflowScheduleSpec, agtName string, specInput scheduleSpecInput, inputsJSON []byte) {
	spec.AgentName = agtName
	spec.WorkflowName = specInput.workflowName
	spec.Schedule = specInput.schedule
	spec.TimeZone = ""
	if specInput.timeZone != nil {
		spec.TimeZone = *specInput.timeZone
	}
	spec.Inputs = apiextensionsv1.JSON{Raw: inputsJSON}
	spec.TimeoutSeconds = specInput.timeoutSeconds
	spec.Suspend = false
	if specInput.suspend != nil {
		spec.Suspend = *specInput.suspend
	}
	spec.SuccessfulRunsHistoryLimit = specInput.successfulRunsHistoryLimit
	if spec.SuccessfulRunsHistoryLimit != nil && *spec.SuccessfulRunsHistoryLimit == 0 {
		value := defaultRunsHistoryLimit
		spec.SuccessfulRunsHistoryLimit = &value
	}

	spec.FailedRunsHistoryLimit = specInput.failedRunsHistoryLimit
	if spec.FailedRunsHistoryLimit != nil && *spec.FailedRunsHistoryLimit == 0 {
		value := defaultRunsHistoryLimit
		spec.FailedRunsHistoryLimit = &value
	}
}

func validateScheduleDNSLabel(fieldName string, value string) []gatewayapi.FieldError {
	if value == "" {
		return []gatewayapi.FieldError{{
			Field:   fieldName,
			Message: "required",
		}}
	}
	if len(value) > 32 {
		return []gatewayapi.FieldError{{
			Field:   fieldName,
			Message: "must be at most 32 characters",
		}}
	}
	if errs := validation.IsDNS1123Label(value); len(errs) > 0 {
		return []gatewayapi.FieldError{{
			Field:   fieldName,
			Message: "must be a valid DNS label",
		}}
	}
	return nil
}
