/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package workflowrun

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"text/template"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/gwreq"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	runRequeueInterval = 5 * time.Second
	// openCode can report a brand-new session as effectively idle until the
	// async prompt loop registers itself as busy. Give cold starts time to
	// transition before treating an idle session as a failed run.
	sessionStartupGrace = 30 * time.Second
)

const workflowRunFinalizer = "clawarmor.accuknox.com/workflowrun-session"

//go:embed prompt.tmpl
var promptTemplateText string

var promptTemplate = template.Must(template.New("workflowrun-prompt").Parse(promptTemplateText))

type promptTemplateData struct {
	AgentName    string
	WorkflowName string
	RunName      string
	InputsJSON   string
}

// Reconciler reconciles a WorkflowRun object.
type Reconciler struct {
	client.Client
	GatewayClient *gatewayapi.ClientWithResponses
	TokenPath     string
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowruns,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowruns/finalizers,verbs=update

// Reconcile drives one WorkflowRun through session start, timeout, and completion.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	run := &clawarmorv1alpha1.WorkflowRun{}
	err := r.Get(ctx, req.NamespacedName, run)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !run.DeletionTimestamp.IsZero() {
		err = r.finalizeRun(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("finalize workflow run: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if !ctrlutil.ContainsFinalizer(run, workflowRunFinalizer) {
		err = r.addFinalizer(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("add workflow run finalizer: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if run.Status.Phase == clawarmorv1alpha1.WorkflowRunPhaseUnknown {
		if run.Status.CompletedAt != nil {
			err = r.syncTerminalStatus(ctx, run)
			if err != nil {
				return ctrl.Result{}, fmt.Errorf(
					"sync zero-value workflow run status: %w",
					err,
				)
			}
			return ctrl.Result{}, nil
		}
		err = r.markPending(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("initialize workflow run status: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if run.Status.Phase.Terminal() {
		err = r.syncTerminalStatus(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("sync terminal workflow run status: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if timedOut(run) {
		err = r.failRun(
			ctx,
			run,
			clawarmorv1alpha1.WorkflowRunReasonTimedOut,
			"workflow run timed out",
			true,
		)
		if err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	switch run.Status.Phase {
	case clawarmorv1alpha1.WorkflowRunPhasePending:
		return r.reconcilePending(ctx, run)
	case clawarmorv1alpha1.WorkflowRunPhaseRunning:
		return r.reconcileRunning(ctx, run)
	default:
		return ctrl.Result{}, nil
	}
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.WorkflowRun{}).
		Named("workflowrun").
		Complete(r)
}

func (r *Reconciler) addFinalizer(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		err := r.Get(ctx, client.ObjectKeyFromObject(run), current)
		if err != nil {
			return err
		}
		if ctrlutil.ContainsFinalizer(current, workflowRunFinalizer) {
			return nil
		}
		ctrlutil.AddFinalizer(current, workflowRunFinalizer)
		return r.Update(ctx, current)
	})
}

func (r *Reconciler) finalizeRun(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) error {
	if !ctrlutil.ContainsFinalizer(run, workflowRunFinalizer) {
		return nil
	}
	if run.Status.SessionID != "" {
		if r.GatewayClient == nil {
			return fmt.Errorf("gateway client is not configured")
		}
		resp, err := r.GatewayClient.SessionDeleteWithResponse(
			ctx,
			run.Spec.AgentName,
			run.Status.SessionID,
			nil,
			gwreq.RequestEditor(r.TokenPath, run.Namespace),
		)
		if err != nil {
			return fmt.Errorf("delete workflow session: %w", err)
		}
		if resp.StatusCode() != http.StatusNoContent && resp.StatusCode() != http.StatusNotFound {
			return fmt.Errorf(
				"delete workflow session returned status %d",
				resp.StatusCode(),
			)
		}
	}

	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		err := r.Get(ctx, client.ObjectKeyFromObject(run), current)
		if err != nil {
			if apierrors.IsNotFound(err) {
				return nil
			}
			return err
		}
		if !ctrlutil.ContainsFinalizer(current, workflowRunFinalizer) {
			return nil
		}
		ctrlutil.RemoveFinalizer(current, workflowRunFinalizer)
		err = r.Update(ctx, current)
		if apierrors.IsNotFound(err) || errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	})
}

func (r *Reconciler) reconcilePending(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) (ctrl.Result, error) {
	err := r.startRun(ctx, run)
	if err == nil {
		return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
	}

	failErr := r.failRun(
		ctx,
		run,
		clawarmorv1alpha1.WorkflowRunReasonGatewayError,
		err.Error(),
		false,
	)
	if failErr != nil {
		return ctrl.Result{}, fmt.Errorf("mark workflow run failed: %w", failErr)
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) reconcileRunning(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) (ctrl.Result, error) {
	done, err := r.sessionIdle(ctx, run)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("inspect workflow session status: %w", err)
	}
	if !done {
		return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
	}

	message, err := r.sessionTerminalMessage(ctx, run)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("inspect workflow session messages: %w", err)
	}
	if message == "" {
		// on a fresh agent pod, OpenCode may briefly show no terminal message
		// while the first async prompt is still starting up.
		if sessionMayStillStart(run) {
			return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
		}
		message = "workflow session completed without terminal status update"
	}

	now := metav1.Now()
	err = r.patchStatus(ctx, run, func(status *clawarmorv1alpha1.WorkflowRunStatus) {
		status.Phase = clawarmorv1alpha1.WorkflowRunPhaseUnacked
		status.Message = message
		r.setTerminalStatus(
			status,
			run.Generation,
			clawarmorv1alpha1.WorkflowRunReasonUnacked,
			message,
			&now,
		)
	})
	if err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) startRun(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) error {
	if r.GatewayClient == nil {
		return fmt.Errorf("gateway client is not configured")
	}

	permission := gatewayapi.OpencodePermissionRuleset{
		{
			Action:     gatewayapi.Deny,
			Permission: "question",
			Pattern:    "*",
		},
		{
			Action:     gatewayapi.Deny,
			Permission: "plan_enter",
			Pattern:    "*",
		},
		{
			Action:     gatewayapi.Deny,
			Permission: "plan_exit",
			Pattern:    "*",
		},
	}

	agt := &clawarmorv1alpha1.Agent{}
	agtKey := client.ObjectKey{Name: run.Spec.AgentName, Namespace: run.Namespace}
	err := r.Get(ctx, agtKey, agt)
	if err != nil {
		return fmt.Errorf("get agent %q: %w", run.Spec.AgentName, err)
	}
	if agt.Spec.EnvironmentRef != nil {
		env := &clawarmorv1alpha1.Environment{}
		envKey := client.ObjectKey{
			Name:      agt.Spec.EnvironmentRef.Name,
			Namespace: run.Namespace,
		}
		err = r.Get(ctx, envKey, env)
		if err != nil {
			return fmt.Errorf(
				"get environment %q for agent %q: %w",
				agt.Spec.EnvironmentRef.Name,
				run.Spec.AgentName,
				err,
			)
		}

		for _, ref := range env.Spec.MCPConnectionRefs {
			for _, tool := range ref.Tools {
				if !tool.RequireConsent {
					continue
				}
				permission = append(permission, gatewayapi.OpencodePermissionRule{
					Action:     gatewayapi.Allow,
					Permission: ref.Name + "_" + tool.Name,
					Pattern:    "*",
				})
			}
		}
	}

	title := "workflowrun/" + run.Namespace + "/" + run.Name
	createResp, err := r.GatewayClient.SessionCreateWithResponse(
		ctx,
		run.Spec.AgentName,
		nil,
		gatewayapi.SessionCreateJSONRequestBody{
			Title:      &title,
			Permission: &permission,
		},
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	if createResp.JSON200 == nil {
		return fmt.Errorf("create session returned status %d", createResp.StatusCode())
	}

	sessionID := createResp.JSON200.Id
	prompt, err := buildPromptRequest(run)
	if err != nil {
		return err
	}

	promptResp, err := r.GatewayClient.SessionPromptAsyncWithBodyWithResponse(
		ctx,
		run.Spec.AgentName,
		sessionID,
		nil,
		"application/json",
		bytes.NewReader(prompt),
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return fmt.Errorf("send workflow prompt: %w", err)
	}
	if promptResp.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("send workflow prompt returned status %d", promptResp.StatusCode())
	}

	now := metav1.Now()
	return r.patchStatus(ctx, run, func(status *clawarmorv1alpha1.WorkflowRunStatus) {
		status.Phase = clawarmorv1alpha1.WorkflowRunPhaseRunning
		status.ObservedGeneration = run.Generation
		status.SessionID = sessionID
		status.StartedAt = &now
		status.Message = ""
		r.setActiveConditions(
			status,
			run.Generation,
			clawarmorv1alpha1.WorkflowRunReasonSessionRunning,
			"workflow run is executing",
		)
	})
}

func (r *Reconciler) failRun(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun, reason string, message string, abort bool) error {
	if abort && run.Status.SessionID != "" {
		if r.GatewayClient != nil {
			resp, err := r.GatewayClient.SessionAbortWithResponse(
				ctx,
				run.Spec.AgentName,
				run.Status.SessionID,
				nil,
				gwreq.RequestEditor(r.TokenPath, run.Namespace),
			)
			switch {
			case err != nil:
				slog.WarnContext(
					ctx,
					"abort workflow session",
					slog.String("agent", run.Spec.AgentName),
					slog.String("namespace", run.Namespace),
					slog.String("sessionID", run.Status.SessionID),
					slog.Any("err", err),
				)
			case resp.StatusCode() != http.StatusOK && resp.StatusCode() != http.StatusNotFound:
				slog.WarnContext(
					ctx,
					"abort workflow session returned unexpected status",
					slog.String("agent", run.Spec.AgentName),
					slog.String("namespace", run.Namespace),
					slog.String("sessionID", run.Status.SessionID),
					slog.Int("status", resp.StatusCode()),
				)
			}
		}
	}

	now := metav1.Now()
	return r.patchStatus(ctx, run, func(status *clawarmorv1alpha1.WorkflowRunStatus) {
		status.Phase = clawarmorv1alpha1.WorkflowRunPhaseFailed
		status.Message = message
		r.setTerminalStatus(status, run.Generation, reason, message, &now)
	})
}

func (r *Reconciler) patchStatus(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun, mutate func(*clawarmorv1alpha1.WorkflowRunStatus)) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		err := r.Get(ctx, client.ObjectKeyFromObject(run), current)
		if err != nil {
			return err
		}
		patch := client.MergeFrom(current.DeepCopy())
		mutate(&current.Status)
		return r.Status().Patch(ctx, current, patch)
	})
}

func timedOut(run *clawarmorv1alpha1.WorkflowRun) bool {
	if run.Status.StartedAt == nil || run.Spec.TimeoutSeconds == 0 {
		return false
	}
	deadline := run.Status.StartedAt.Add(time.Duration(run.Spec.TimeoutSeconds) * time.Second)
	return time.Now().After(deadline)
}

func sessionMayStillStart(run *clawarmorv1alpha1.WorkflowRun) bool {
	if run.Status.StartedAt == nil {
		return false
	}
	return time.Since(run.Status.StartedAt.Time) < sessionStartupGrace
}

func (r *Reconciler) syncTerminalStatus(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) error {
	reason := clawarmorv1alpha1.WorkflowRunReasonSucceeded
	switch run.Status.Phase {
	case clawarmorv1alpha1.WorkflowRunPhaseFailed:
		reason = clawarmorv1alpha1.WorkflowRunReasonFailed
	case clawarmorv1alpha1.WorkflowRunPhaseUnacked:
		reason = clawarmorv1alpha1.WorkflowRunReasonUnacked
	}
	message := run.Status.Message
	if message == "" {
		message = "workflow run completed"
	}
	completedAt := run.Status.CompletedAt
	if completedAt == nil {
		now := metav1.Now()
		completedAt = &now
	}

	return r.patchStatus(ctx, run, func(status *clawarmorv1alpha1.WorkflowRunStatus) {
		status.Message = message
		r.setTerminalStatus(status, run.Generation, reason, message, completedAt)
	})
}

func (r *Reconciler) markPending(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) error {
	return r.patchStatus(ctx, run, func(status *clawarmorv1alpha1.WorkflowRunStatus) {
		status.Phase = clawarmorv1alpha1.WorkflowRunPhasePending
		status.ObservedGeneration = run.Generation
		r.setActiveConditions(
			status,
			run.Generation,
			clawarmorv1alpha1.WorkflowRunReasonPending,
			"workflow run is pending",
		)
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.WorkflowRunConditionProgressing,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.WorkflowRunReasonPending,
			Message:            "workflow run is waiting to start",
			ObservedGeneration: run.Generation,
		})
	})
}

func (r *Reconciler) setActiveConditions(status *clawarmorv1alpha1.WorkflowRunStatus, generation int64, reason string, message string) {
	status.SetCondition(metav1.Condition{
		Type:               clawarmorv1alpha1.WorkflowRunConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
	status.SetCondition(metav1.Condition{
		Type:               clawarmorv1alpha1.WorkflowRunConditionProgressing,
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
}

func (r *Reconciler) setTerminalStatus(status *clawarmorv1alpha1.WorkflowRunStatus, generation int64, reason string, message string, completedAt *metav1.Time) {
	status.ObservedGeneration = generation
	if status.CompletedAt == nil {
		status.CompletedAt = completedAt
	}
	status.SetCondition(metav1.Condition{
		Type:               clawarmorv1alpha1.WorkflowRunConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
	status.SetCondition(metav1.Condition{
		Type:               clawarmorv1alpha1.WorkflowRunConditionProgressing,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
}

func buildPromptRequest(run *clawarmorv1alpha1.WorkflowRun) ([]byte, error) {
	inputs := "null"
	if len(run.Spec.Inputs.Raw) > 0 {
		inputs = string(run.Spec.Inputs.Raw)
	}

	var prompt bytes.Buffer
	err := promptTemplate.Execute(&prompt, promptTemplateData{
		AgentName:    run.Spec.AgentName,
		WorkflowName: run.Spec.WorkflowName,
		RunName:      run.Name,
		InputsJSON:   inputs,
	})
	if err != nil {
		return nil, fmt.Errorf("render session prompt: %w", err)
	}

	body := map[string]any{
		"parts": []map[string]any{{
			"type": "text",
			"text": prompt.String(),
		}},
		"tools": map[string]bool{
			"get_workflow":           true,
			"question":               false,
			"set_workflowrun_status": true,
		},
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal session prompt: %w", err)
	}
	return data, nil
}

func (r *Reconciler) sessionIdle(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) (bool, error) {
	if run.Status.SessionID == "" {
		return false, nil
	}
	if r.GatewayClient == nil {
		return false, fmt.Errorf("gateway client is not configured")
	}

	resp, err := r.GatewayClient.SessionStatusWithResponse(
		ctx,
		run.Spec.AgentName,
		nil,
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return false, fmt.Errorf("get session status: %w", err)
	}
	if resp.JSON200 == nil {
		return false, nil
	}

	status, ok := (*resp.JSON200)[run.Status.SessionID]
	if !ok {
		// openCode omits idle sessions from the status map, so a missing entry
		// means "not busy anymore" rather than "unknown session".
		return true, nil
	}
	if idle, err := status.AsOpencodeSessionStatus0(); err == nil && idle.Type == gatewayapi.Idle {
		return true, nil
	}
	if retry, err := status.AsOpencodeSessionStatus1(); err == nil && retry.Type == gatewayapi.OpencodeSessionStatus1TypeRetry {
		return false, nil
	}
	if busy, err := status.AsOpencodeSessionStatus2(); err == nil && busy.Type == gatewayapi.Busy {
		return false, nil
	}
	return false, nil
}

func (r *Reconciler) sessionTerminalMessage(ctx context.Context, run *clawarmorv1alpha1.WorkflowRun) (string, error) {
	if run.Status.SessionID == "" {
		return "", nil
	}
	if r.GatewayClient == nil {
		return "", fmt.Errorf("gateway client is not configured")
	}

	limit := 20
	resp, err := r.GatewayClient.SessionMessagesWithResponse(
		ctx,
		run.Spec.AgentName,
		run.Status.SessionID,
		&gatewayapi.SessionMessagesParams{
			Limit: &limit,
		},
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return "", fmt.Errorf("list session messages: %w", err)
	}
	if resp.JSON200 == nil {
		return "", nil
	}

	for i := len(*resp.JSON200) - 1; i >= 0; i-- {
		msg := (*resp.JSON200)[i]
		assistant, err := msg.Info.AsOpencodeAssistantMessage()
		if err != nil {
			continue
		}
		if assistant.Finish == nil {
			continue
		}
		if *assistant.Finish == "tool-calls" || *assistant.Finish == "stop" {
			return "", nil
		}
		return assistantFailureMessage(assistant), nil
	}
	return "", nil
}

func assistantFailureMessage(assistant gatewayapi.OpencodeAssistantMessage) string {
	if assistant.Finish == nil || *assistant.Finish != "error" || assistant.Error == nil {
		return ""
	}

	if providerAuthError, err := assistant.Error.AsOpencodeProviderAuthError(); err == nil {
		message := providerAuthError.Data.Message
		if providerAuthError.Data.ProviderID != "" {
			return providerAuthError.Data.ProviderID + ": " + message
		}
		return message
	}
	if apiError, err := assistant.Error.AsOpencodeAPIError(); err == nil {
		message := apiError.Data.Message
		if apiError.Data.StatusCode != nil {
			return fmt.Sprintf("%s (status %d)", message, *apiError.Data.StatusCode)
		}
		return message
	}
	if unknownError, err := assistant.Error.AsOpencodeUnknownError(); err == nil {
		return unknownError.Data.Message
	}
	if abortedError, err := assistant.Error.AsOpencodeMessageAbortedError(); err == nil {
		return abortedError.Data.Message
	}
	if contextOverflowError, err := assistant.Error.AsOpencodeContextOverflowError(); err == nil {
		return contextOverflowError.Data.Message
	}
	if structuredOutputError, err := assistant.Error.AsOpencodeStructuredOutputError(); err == nil {
		return structuredOutputError.Data.Message
	}
	if outputLengthError, err := assistant.Error.AsOpencodeMessageOutputLengthError(); err == nil {
		raw, marshalErr := json.Marshal(outputLengthError.Data)
		if marshalErr == nil {
			return string(raw)
		}
	}

	return "workflow session failed"
}
