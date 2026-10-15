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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gwreq"
	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	runRequeueInterval = 5 * time.Second
	// DefaultOrphanRetention retains terminal webhook-triggered runs for seven
	// days before opportunistic pruning deletes them.
	DefaultOrphanRetention = 7 * 24 * time.Hour
)

const workflowRunFinalizer = "agentz.accuknox.com/workflowrun-session"

// Reconciler reconciles a WorkflowRun object.
type Reconciler struct {
	client.Client
	GatewayClient   *gatewayapi.ClientWithResponses
	OrphanRetention time.Duration
	TokenPath       string
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workflowruns,verbs=get;list;watch;update;patch;delete
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workflowruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workflowruns/finalizers,verbs=update

// Reconcile drives one WorkflowRun through session start, timeout, and completion.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	run := &agentzv1alpha1.WorkflowRun{}
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

	var workspace agentzv1alpha1.Workspace
	err = r.Get(ctx, client.ObjectKey{Name: run.Namespace}, &workspace)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("get workflow Workspace: %w", err)
	}
	if workspace.Spec.Type == agentzv1alpha1.WorkspaceTypeCoding {
		// Admission rejects these resources; never execute them if it was bypassed.
		return ctrl.Result{}, nil
	}

	if !ctrlutil.ContainsFinalizer(run, workflowRunFinalizer) {
		err = r.addFinalizer(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("add workflow run finalizer: %w", err)
		}
		return ctrl.Result{RequeueAfter: time.Millisecond}, nil
	}

	terminal := run.Status.Phase.Terminal()
	if run.Status.Phase == agentzv1alpha1.WorkflowRunPhaseUnknown {
		terminal = run.Status.CompletedAt != nil
	}
	if terminal {
		err = r.syncTerminalStatus(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("sync terminal workflow run status: %w", err)
		}
		err = r.pruneOrphanRuns(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf(
				"prune orphan workflow runs: %w",
				err,
			)
		}
		return ctrl.Result{}, nil
	}
	if run.Status.Phase == agentzv1alpha1.WorkflowRunPhaseUnknown {
		err = r.markPending(ctx, run)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("initialize workflow run status: %w", err)
		}
		return ctrl.Result{RequeueAfter: time.Millisecond}, nil
	}

	if run.Status.StartedAt != nil && run.Spec.TimeoutSeconds > 0 {
		deadline := run.Status.StartedAt.Add(time.Duration(run.Spec.TimeoutSeconds) * time.Second)
		if time.Now().After(deadline) {
			err = r.failRun(
				ctx,
				run,
				agentzv1alpha1.WorkflowRunReasonTimedOut,
				"workflow run timed out",
			)
			if err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{}, nil
		}
	}

	switch run.Status.Phase {
	case agentzv1alpha1.WorkflowRunPhasePending:
		return r.reconcilePending(ctx, run)
	case agentzv1alpha1.WorkflowRunPhaseRunning:
		return r.reconcileRunning(ctx, run)
	default:
		return ctrl.Result{}, nil
	}
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.WorkflowRun{}).
		Named("workflowrun").
		WithOptions(controller.Options{
			MaxConcurrentReconciles: 2,
			ReconciliationTimeout:   time.Minute,
		}).
		Complete(r)
}

func (r *Reconciler) pruneOrphanRuns(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	if r.OrphanRetention <= 0 || run.Spec.ScheduleRef != nil {
		return nil
	}

	cutoff := time.Now().Add(-r.OrphanRetention)
	runList := &agentzv1alpha1.WorkflowRunList{}
	err := r.List(ctx, runList, client.InNamespace(run.Namespace))
	if err != nil {
		return fmt.Errorf("list workflow runs: %w", err)
	}

	for i := range runList.Items {
		current := &runList.Items[i]
		if current.Spec.AgentName != run.Spec.AgentName {
			continue
		}
		if current.Spec.WorkflowName != run.Spec.WorkflowName {
			continue
		}
		if current.Spec.ScheduleRef != nil {
			continue
		}
		if !current.Status.Phase.Terminal() || current.Status.CompletedAt == nil {
			continue
		}
		if !current.Status.CompletedAt.Time.Before(cutoff) {
			continue
		}

		err = r.Delete(ctx, current)
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete workflow run %q: %w", current.Name, err)
		}
	}

	return nil
}

func (r *Reconciler) addFinalizer(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	return retry.RetryOnConflict(
		retry.DefaultRetry,
		func() error {
			current := &agentzv1alpha1.WorkflowRun{}
			err := r.Get(ctx, client.ObjectKeyFromObject(run), current)
			if err != nil {
				return err
			}
			if ctrlutil.ContainsFinalizer(current, workflowRunFinalizer) {
				return nil
			}
			ctrlutil.AddFinalizer(current, workflowRunFinalizer)
			return r.Update(ctx, current)
		},
	)
}

func (r *Reconciler) finalizeRun(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	if !ctrlutil.ContainsFinalizer(run, workflowRunFinalizer) {
		return nil
	}
	if run.Status.SessionID != "" {
		err := r.abortRun(ctx, run)
		if err != nil {
			return err
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
		if resp.StatusCode() != http.StatusOK && resp.StatusCode() != http.StatusNotFound {
			return fmt.Errorf(
				"delete workflow session returned status %d",
				resp.StatusCode(),
			)
		}
	}

	return retry.RetryOnConflict(
		retry.DefaultRetry,
		func() error {
			current := &agentzv1alpha1.WorkflowRun{}
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
		},
	)
}

func (r *Reconciler) reconcilePending(ctx context.Context, run *agentzv1alpha1.WorkflowRun) (ctrl.Result, error) {
	err := r.startRun(ctx, run)
	if err == nil {
		return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
	}

	failErr := r.failRun(
		ctx,
		run,
		agentzv1alpha1.WorkflowRunReasonGatewayError,
		err.Error(),
	)
	if failErr != nil {
		return ctrl.Result{}, fmt.Errorf("mark workflow run failed: %w", failErr)
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) reconcileRunning(ctx context.Context, run *agentzv1alpha1.WorkflowRun) (ctrl.Result, error) {
	if run.Status.ExecutionID == "" {
		return ctrl.Result{}, r.failRun(
			ctx,
			run,
			agentzv1alpha1.WorkflowRunReasonGatewayError,
			"Workflow run has no tracked execution",
		)
	}
	response, err := r.GatewayClient.GetWorkflowExecutionWithResponse(
		ctx,
		run.Spec.AgentName,
		run.Spec.WorkflowName,
		run.Name,
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("read workflow execution: %w", err)
	}
	if response.JSON200 == nil {
		return ctrl.Result{}, fmt.Errorf("read workflow execution returned status %d", response.StatusCode())
	}
	execution := response.JSON200.Execution
	if execution == nil {
		admitted, err := r.GatewayClient.StartWorkflowExecutionWithResponse(
			ctx,
			run.Spec.AgentName,
			run.Spec.WorkflowName,
			run.Name,
			gatewayapi.StartWorkflowExecutionJSONRequestBody{RunUid: string(run.UID)},
			gwreq.RequestEditor(r.TokenPath, run.Namespace),
		)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("admit workflow execution: %w", err)
		}
		if admitted.JSON202 == nil {
			return ctrl.Result{}, fmt.Errorf("admit workflow execution returned status %d", admitted.StatusCode())
		}
		return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
	}
	switch execution.State {
	case gatewayapi.ConversationExecutionStateAdmitting,
		gatewayapi.ConversationExecutionStateRunning,
		gatewayapi.ConversationExecutionStateRecovering,
		gatewayapi.ConversationExecutionStateBlocked:
		recovering := execution.State == gatewayapi.ConversationExecutionStateRecovering
		condition := apimeta.FindStatusCondition(run.Status.Conditions, agentzv1alpha1.WorkflowRunConditionRecovering)
		desired := metav1.ConditionFalse
		if recovering {
			desired = metav1.ConditionTrue
		}
		if condition == nil || condition.Status != desired || condition.Message != execution.Message {
			err = r.patchStatus(ctx, run, func(status *agentzv1alpha1.WorkflowRunStatus) {
				if status.Phase.Terminal() {
					return
				}
				status.Message = execution.Message
				status.SetCondition(metav1.Condition{
					Type:               agentzv1alpha1.WorkflowRunConditionRecovering,
					Status:             desired,
					Reason:             "ExecutionObserved",
					Message:            execution.Message,
					ObservedGeneration: run.Generation,
				})
			})
			if err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: runRequeueInterval}, nil
	case gatewayapi.ConversationExecutionStateFailed, gatewayapi.ConversationExecutionStateCancelled:
		return ctrl.Result{}, r.failRun(ctx, run, agentzv1alpha1.WorkflowRunReasonGatewayError, execution.Message)
	}
	message := "workflow session completed without terminal status update"
	now := metav1.Now()
	err = r.patchStatus(
		ctx,
		run,
		func(status *agentzv1alpha1.WorkflowRunStatus) {
			if status.Phase.Terminal() || status.CompletedAt != nil {
				return
			}
			status.Phase = agentzv1alpha1.WorkflowRunPhaseUnacked
			status.Message = message
			r.setTerminalStatus(
				status,
				run.Generation,
				agentzv1alpha1.WorkflowRunReasonUnacked,
				message,
				&now,
			)
		},
	)
	if err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) startRun(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	if r.GatewayClient == nil {
		return fmt.Errorf("gateway client is not configured")
	}

	permission := gatewayapi.OpencodePermissionRuleset{
		{
			Action:     gatewayapi.OpencodePermissionActionDeny,
			Permission: "question",
			Pattern:    "*",
		},
		{
			Action:     gatewayapi.OpencodePermissionActionDeny,
			Permission: "plan_enter",
			Pattern:    "*",
		},
		{
			Action:     gatewayapi.OpencodePermissionActionDeny,
			Permission: "plan_exit",
			Pattern:    "*",
		},
	}

	agt := &agentzv1alpha1.Agent{}
	agtKey := client.ObjectKey{Name: run.Spec.AgentName, Namespace: run.Namespace}
	err := r.Get(ctx, agtKey, agt)
	if err != nil {
		return fmt.Errorf("get agent %q: %w", run.Spec.AgentName, err)
	}
	sandbox := &agentzv1alpha1.Sandbox{}
	ref := agt.Spec.SandboxRef
	sandboxNamespace, err := scope.SelectedNamespace(ctx, r.Client, run.Namespace, scope.Selection{
		Scope: ref.Scope,
		Kind:  agentzv1alpha1.OrganizationResourceKindSandbox,
		Name:  ref.Name,
	})
	if err != nil {
		return fmt.Errorf("resolve workflow sandbox: %w", err)
	}
	sandboxKey := client.ObjectKey{
		Name:      ref.Name,
		Namespace: sandboxNamespace,
	}
	err = r.Get(ctx, sandboxKey, sandbox)
	if err != nil {
		return fmt.Errorf(
			"get sandbox %q for agent %q: %w",
			agt.Spec.SandboxRef.Name,
			run.Spec.AgentName,
			err,
		)
	}

	for _, ref := range sandbox.Spec.MCPConnectionRefs {
		for _, tool := range ref.Tools {
			if !tool.RequireConsent {
				continue
			}
			permission = append(
				permission,
				gatewayapi.OpencodePermissionRule{
					Action:     gatewayapi.OpencodePermissionActionAllow,
					Permission: ref.Name + "_" + tool.Name,
					Pattern:    "*",
				},
			)
		}
	}

	title := "workflowrun/" + run.Namespace + "/" + run.Name
	var metadata *map[string]any
	if evaluation := run.Labels["agentz.accuknox.com/evaluation"]; evaluation != "" {
		metadata = &map[string]any{"agentz.evaluation_id": evaluation}
	}
	createResp, err := r.GatewayClient.SessionCreateWithResponse(
		ctx,
		run.Spec.AgentName,
		nil,
		gatewayapi.SessionCreateJSONRequestBody{
			Title:      &title,
			Permission: &permission,
			Metadata:   metadata,
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

	// Persist admission before submitting work. Retrying an ambiguous prompt
	// response can repeat live tool effects; recovery inspects this same session.
	now := metav1.Now()
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.WorkflowRun{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(run), current); err != nil {
			return err
		}
		if !current.DeletionTimestamp.IsZero() || current.Status.Phase != agentzv1alpha1.WorkflowRunPhasePending {
			return errors.New("workflow run is no longer pending")
		}
		patch := client.MergeFromWithOptions(current.DeepCopy(), client.MergeFromWithOptimisticLock{})
		current.Status.Phase = agentzv1alpha1.WorkflowRunPhaseRunning
		current.Status.ObservedGeneration = run.Generation
		current.Status.SessionID = sessionID
		current.Status.ExecutionID = uuid.NewSHA1(uuid.NameSpaceOID, []byte(current.UID)).String()
		current.Status.StartedAt = &now
		current.Status.Message = ""
		r.setActiveConditions(
			&current.Status,
			run.Generation,
			agentzv1alpha1.WorkflowRunReasonSessionRunning,
			"workflow run is executing",
		)
		if err := r.Status().Patch(ctx, current, patch); err != nil {
			return err
		}
		run.Status = current.Status
		return nil
	})
	if err != nil {
		_, cleanupErr := r.GatewayClient.SessionDeleteWithResponse(
			ctx, run.Spec.AgentName, sessionID, nil,
			gwreq.RequestEditor(r.TokenPath, run.Namespace),
		)
		if cleanupErr != nil {
			slog.WarnContext(ctx, "delete unadmitted workflow session", "sessionID", sessionID, "error", cleanupErr)
		}
		return fmt.Errorf("persist workflow session admission: %w", err)
	}
	response, err := r.GatewayClient.StartWorkflowExecutionWithResponse(
		ctx, run.Spec.AgentName, run.Spec.WorkflowName, run.Name,
		gatewayapi.StartWorkflowExecutionJSONRequestBody{RunUid: string(run.UID)},
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		slog.WarnContext(ctx, "workflow execution admission uncertain", "run", run.Name, "error", err)
		return nil
	}
	if response.JSON202 == nil {
		return fmt.Errorf("admit workflow execution returned status %d", response.StatusCode())
	}

	return nil
}

func (r *Reconciler) failRun(ctx context.Context, run *agentzv1alpha1.WorkflowRun, reason, message string) error {
	// Record the failure and cancellation intent together before contacting the
	// agent. An unavailable agent must not hide an expired execution deadline.
	now := metav1.Now()
	err := r.patchStatus(
		ctx,
		run,
		func(status *agentzv1alpha1.WorkflowRunStatus) {
			if status.Phase.Terminal() || status.CompletedAt != nil {
				return
			}
			status.Phase = agentzv1alpha1.WorkflowRunPhaseFailed
			status.Message = message
			r.setTerminalStatus(status, run.Generation, reason, message, &now)
			if status.SessionID != "" {
				status.SetCondition(metav1.Condition{
					Type:               agentzv1alpha1.WorkflowRunConditionSessionAborted,
					Status:             metav1.ConditionFalse,
					ObservedGeneration: run.Generation,
					Reason:             reason,
					Message:            "workflow session cancellation is pending",
				})
			}
		},
	)
	if err != nil {
		return err
	}
	return r.syncTerminalStatus(ctx, run)
}

func (r *Reconciler) patchStatus(ctx context.Context, run *agentzv1alpha1.WorkflowRun, mutate func(*agentzv1alpha1.WorkflowRunStatus)) error {
	return retry.RetryOnConflict(
		retry.DefaultRetry,
		func() error {
			current := &agentzv1alpha1.WorkflowRun{}
			err := r.Get(ctx, client.ObjectKeyFromObject(run), current)
			if err != nil {
				return err
			}
			patch := client.MergeFromWithOptions(current.DeepCopy(), client.MergeFromWithOptimisticLock{})
			mutate(&current.Status)
			if err := r.Status().Patch(ctx, current, patch); err != nil {
				return err
			}
			run.Status = current.Status
			return nil
		},
	)
}

func (r *Reconciler) syncTerminalStatus(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	err := r.patchStatus(
		ctx,
		run,
		func(status *agentzv1alpha1.WorkflowRunStatus) {
			reason := agentzv1alpha1.WorkflowRunReasonSucceeded
			switch status.Phase {
			case agentzv1alpha1.WorkflowRunPhaseFailed:
				reason = agentzv1alpha1.WorkflowRunReasonFailed
				ready := apimeta.FindStatusCondition(
					status.Conditions,
					agentzv1alpha1.WorkflowRunConditionReady,
				)
				if ready != nil && ready.Status == metav1.ConditionTrue {
					reason = ready.Reason
				}
			case agentzv1alpha1.WorkflowRunPhaseUnacked:
				reason = agentzv1alpha1.WorkflowRunReasonUnacked
			}
			if status.Message == "" {
				status.Message = "workflow run completed"
			}
			completedAt := status.CompletedAt
			if completedAt == nil {
				now := metav1.Now()
				completedAt = &now
			}
			r.setTerminalStatus(status, run.Generation, reason, status.Message, completedAt)
		},
	)
	if err != nil {
		return err
	}
	if !apimeta.IsStatusConditionFalse(run.Status.Conditions, agentzv1alpha1.WorkflowRunConditionSessionAborted) {
		return nil
	}

	err = r.abortRun(ctx, run)
	cond := metav1.Condition{
		Type:               agentzv1alpha1.WorkflowRunConditionSessionAborted,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: run.Generation,
		Reason:             agentzv1alpha1.WorkflowRunConditionSessionAborted,
		Message:            "workflow session cancellation is confirmed",
	}
	if err != nil {
		cond.Status = metav1.ConditionFalse
		cond.Reason = agentzv1alpha1.WorkflowRunReasonGatewayError
		cond.Message = err.Error()
	}
	patchErr := r.patchStatus(ctx, run, func(status *agentzv1alpha1.WorkflowRunStatus) {
		status.SetCondition(cond)
	})
	return errors.Join(err, patchErr)
}

func (r *Reconciler) abortRun(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	if run.Status.SessionID == "" {
		return nil
	}
	if r.GatewayClient == nil {
		return errors.New("gateway client is not configured")
	}
	resp, err := r.GatewayClient.SessionAbortWithResponse(
		ctx, run.Spec.AgentName, run.Status.SessionID, nil,
		gwreq.RequestEditor(r.TokenPath, run.Namespace),
	)
	if err != nil {
		return fmt.Errorf("abort workflow session: %w", err)
	}
	if resp.StatusCode() != http.StatusOK && resp.StatusCode() != http.StatusNotFound {
		return fmt.Errorf("abort workflow session returned status %d", resp.StatusCode())
	}
	return nil
}

func (r *Reconciler) markPending(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	if r.GatewayClient == nil {
		return fmt.Errorf("gateway client is not configured")
	}

	var definition gatewayapi.Workflow
	switch {
	case run.Spec.Definition != nil:
		if err := json.Unmarshal(run.Spec.Definition.Raw, &definition); err != nil {
			return fmt.Errorf("decode frozen workflow: %w", err)
		}
	default:
		resp, err := r.GatewayClient.GetWorkflowWithResponse(
			ctx,
			run.Spec.AgentName,
			run.Spec.WorkflowName,
			gwreq.RequestEditor(r.TokenPath, run.Namespace),
		)
		if err != nil {
			return fmt.Errorf("get workflow: %w", err)
		}
		if resp.JSON200 == nil {
			return fmt.Errorf("get workflow returned status %d", resp.StatusCode())
		}
		definition = *resp.JSON200
	}

	nodes := make([]agentzv1alpha1.WorkflowRunNodeStatus, 0, len(definition.Nodes))
	for _, node := range definition.Nodes {
		nodes = append(
			nodes,
			agentzv1alpha1.WorkflowRunNodeStatus{
				Name:  node.Name,
				Phase: agentzv1alpha1.WorkflowRunNodePhaseDisabled,
			},
		)
	}

	return r.patchStatus(
		ctx,
		run,
		func(status *agentzv1alpha1.WorkflowRunStatus) {
			status.Phase = agentzv1alpha1.WorkflowRunPhasePending
			status.ObservedGeneration = run.Generation
			status.Nodes = nodes
			r.setActiveConditions(
				status,
				run.Generation,
				agentzv1alpha1.WorkflowRunReasonPending,
				"workflow run is pending",
			)
			status.SetCondition(metav1.Condition{
				Type:               agentzv1alpha1.WorkflowRunConditionProgressing,
				Status:             metav1.ConditionTrue,
				Reason:             agentzv1alpha1.WorkflowRunReasonPending,
				Message:            "workflow run is waiting to start",
				ObservedGeneration: run.Generation,
			})
		},
	)
}

func (r *Reconciler) setActiveConditions(status *agentzv1alpha1.WorkflowRunStatus, generation int64, reason string, message string) {
	status.SetCondition(metav1.Condition{
		Type:               agentzv1alpha1.WorkflowRunConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
	status.SetCondition(metav1.Condition{
		Type:               agentzv1alpha1.WorkflowRunConditionProgressing,
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
}

func (r *Reconciler) setTerminalStatus(status *agentzv1alpha1.WorkflowRunStatus, generation int64, reason string, message string, completedAt *metav1.Time) {
	status.ObservedGeneration = generation
	if status.CompletedAt == nil {
		status.CompletedAt = completedAt
	}
	for i := range status.Nodes {
		if status.Nodes[i].Phase != agentzv1alpha1.WorkflowRunNodePhaseRunning {
			continue
		}
		status.Nodes[i].Phase = agentzv1alpha1.WorkflowRunNodePhaseUnacked
		status.Nodes[i].CompletedAt = completedAt
	}
	status.SetCondition(metav1.Condition{
		Type:               agentzv1alpha1.WorkflowRunConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
	status.SetCondition(metav1.Condition{
		Type:               agentzv1alpha1.WorkflowRunConditionProgressing,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	})
}
