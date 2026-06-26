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

package workflowschedule

import (
	"context"
	"fmt"
	"reflect"
	"slices"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const WorkflowRunByScheduleIndex = "spec.scheduleRef.name"

// Reconciler reconciles a WorkflowSchedule object.
type Reconciler struct {
	client.Client
	Scheme          *runtime.Scheme
	ControllerImage string
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowschedules,verbs=get;list;watch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowschedules/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=workflowruns,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups=batch,resources=cronjobs;jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete

// Reconcile keeps one CronJob and its access resources aligned with the schedule.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	schedule := &clawarmorv1alpha1.WorkflowSchedule{}
	err := r.Get(ctx, req.NamespacedName, schedule)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if r.ControllerImage == "" {
		return ctrl.Result{}, r.failSchedule(
			ctx,
			schedule,
			fmt.Errorf("controller image is not configured"),
		)
	}

	err = r.reconcileServiceAccount(ctx, schedule)
	if err != nil {
		return ctrl.Result{}, r.failSchedule(ctx, schedule, err)
	}
	err = r.reconcileRole(ctx, schedule)
	if err != nil {
		return ctrl.Result{}, r.failSchedule(ctx, schedule, err)
	}
	err = r.reconcileRoleBinding(ctx, schedule)
	if err != nil {
		return ctrl.Result{}, r.failSchedule(ctx, schedule, err)
	}
	cronJobName, err := r.reconcileCronJob(ctx, schedule)
	if err != nil {
		return ctrl.Result{}, r.failSchedule(ctx, schedule, err)
	}
	err = r.pruneRuns(ctx, schedule)
	if err != nil {
		return ctrl.Result{}, r.failSchedule(ctx, schedule, err)
	}
	err = r.refreshStatus(ctx, schedule, cronJobName)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("refresh schedule status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.WorkflowSchedule{}).
		Owns(&batchv1.CronJob{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&rbacv1.Role{}).
		Owns(&rbacv1.RoleBinding{}).
		Owns(&clawarmorv1alpha1.WorkflowRun{}).
		Named("workflowschedule").
		Complete(r)
}

// IndexWorkflowRunsBySchedule registers the WorkflowRun schedule reference index.
func IndexWorkflowRunsBySchedule(ctx context.Context, idx client.FieldIndexer) error {
	return idx.IndexField(
		ctx,
		&clawarmorv1alpha1.WorkflowRun{},
		WorkflowRunByScheduleIndex,
		func(obj client.Object) []string {
			run, ok := obj.(*clawarmorv1alpha1.WorkflowRun)
			if !ok {
				return nil
			}
			if run.Spec.ScheduleRef == nil || run.Spec.ScheduleRef.Name == "" {
				return nil
			}
			return []string{run.Spec.ScheduleRef.Name}
		},
	)
}

func (r *Reconciler) failSchedule(ctx context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule, err error) error {
	updateErr := r.updateStatus(ctx, schedule, func(status *clawarmorv1alpha1.WorkflowScheduleStatus) {
		status.ObservedGeneration = schedule.Generation
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.WorkflowScheduleConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.WorkflowScheduleReasonReconcileFailed,
			Message:            err.Error(),
			ObservedGeneration: schedule.Generation,
		})
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.WorkflowScheduleConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.WorkflowScheduleReasonReconcileFailed,
			Message:            err.Error(),
			ObservedGeneration: schedule.Generation,
		})
	})
	if updateErr != nil {
		return fmt.Errorf("update schedule status: %w", updateErr)
	}
	return err
}

func (r *Reconciler) refreshStatus(ctx context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule, cronJobName string) error {
	cronJob := &batchv1.CronJob{}
	err := r.Get(ctx, client.ObjectKey{
		Namespace: schedule.Namespace,
		Name:      cronJobName,
	}, cronJob)
	if err != nil {
		return fmt.Errorf("get cronjob: %w", err)
	}

	runs, err := r.listOwnedRuns(ctx, schedule)
	if err != nil {
		return err
	}

	var lastRun *clawarmorv1alpha1.WorkflowRun
	for i := range runs {
		run := &runs[i]
		if lastRun == nil || run.CreationTimestamp.After(lastRun.CreationTimestamp.Time) {
			lastRun = run
		}
	}

	return r.updateStatus(ctx, schedule, func(status *clawarmorv1alpha1.WorkflowScheduleStatus) {
		status.ObservedGeneration = schedule.Generation
		status.CronJobName = cronJobName
		status.LastScheduledAt = cronJob.Status.LastScheduleTime
		status.LastRunName = ""
		if lastRun != nil {
			status.LastRunName = lastRun.Name
		}
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.WorkflowScheduleConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.WorkflowScheduleReasonCronJobReady,
			Message:            "cronjob is ready",
			ObservedGeneration: schedule.Generation,
		})
		progressing := metav1.ConditionTrue
		if schedule.Spec.Suspend {
			progressing = metav1.ConditionFalse
		}
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.WorkflowScheduleConditionProgressing,
			Status:             progressing,
			Reason:             clawarmorv1alpha1.WorkflowScheduleReasonCronJobReady,
			Message:            "cronjob is reconciled",
			ObservedGeneration: schedule.Generation,
		})
	})
}

func (r *Reconciler) pruneRuns(ctx context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule) error {
	runs, err := r.listOwnedRuns(ctx, schedule)
	if err != nil {
		return err
	}

	successful := []clawarmorv1alpha1.WorkflowRun{}
	failed := []clawarmorv1alpha1.WorkflowRun{}
	for _, run := range runs {
		switch run.Status.Phase {
		case clawarmorv1alpha1.WorkflowRunPhaseSucceeded:
			successful = append(successful, run)
		case clawarmorv1alpha1.WorkflowRunPhaseFailed:
			failed = append(failed, run)
		}
	}

	slices.SortFunc(successful, newerFirst)
	slices.SortFunc(failed, newerFirst)

	err = r.deleteRunsAfterLimit(
		ctx,
		successful,
		ptr.Deref(schedule.Spec.SuccessfulRunsHistoryLimit, int32(0)),
	)
	if err != nil {
		return err
	}
	err = r.deleteRunsAfterLimit(
		ctx,
		failed,
		ptr.Deref(schedule.Spec.FailedRunsHistoryLimit, int32(0)),
	)
	if err != nil {
		return err
	}
	return nil
}

func (r *Reconciler) listOwnedRuns(ctx context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule) ([]clawarmorv1alpha1.WorkflowRun, error) {
	runList := &clawarmorv1alpha1.WorkflowRunList{}
	err := r.List(
		ctx,
		runList,
		client.InNamespace(schedule.Namespace),
		client.MatchingFields{WorkflowRunByScheduleIndex: schedule.Name},
	)
	if err != nil {
		return nil, fmt.Errorf("list workflow runs: %w", err)
	}

	runs := make([]clawarmorv1alpha1.WorkflowRun, 0, len(runList.Items))
	for _, run := range runList.Items {
		if !metav1.IsControlledBy(&run, schedule) {
			continue
		}
		runs = append(runs, run)
	}
	return runs, nil
}

func (r *Reconciler) deleteRunsAfterLimit(ctx context.Context, runs []clawarmorv1alpha1.WorkflowRun, limit int32) error {
	if len(runs) <= int(limit) {
		return nil
	}
	for i := int(limit); i < len(runs); i++ {
		err := r.Delete(ctx, &runs[i])
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete workflow run %s: %w", runs[i].Name, err)
		}
	}
	return nil
}

func (r *Reconciler) updateStatus(ctx context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule, mutate func(*clawarmorv1alpha1.WorkflowScheduleStatus)) error {
	current := &clawarmorv1alpha1.WorkflowSchedule{}
	err := r.Get(ctx, client.ObjectKeyFromObject(schedule), current)
	if err != nil {
		return err
	}
	status := current.Status.DeepCopy()
	mutate(status)
	if reflect.DeepEqual(current.Status, *status) {
		return nil
	}
	patch := client.MergeFrom(current.DeepCopy())
	current.Status = *status
	return r.Status().Patch(ctx, current, patch)
}

func newerFirst(left, right clawarmorv1alpha1.WorkflowRun) int {
	switch {
	case left.CreationTimestamp.After(right.CreationTimestamp.Time):
		return -1
	case right.CreationTimestamp.After(left.CreationTimestamp.Time):
		return 1
	default:
		return 0
	}
}
