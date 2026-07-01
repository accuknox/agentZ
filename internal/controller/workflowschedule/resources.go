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
	"encoding/json"
	"fmt"
	"maps"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/agentz/internal/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	workflowScheduleLabel      = "agentz.accuknox.com/workflow-schedule"
	scheduleRunnerLabel        = "agentz.accuknox.com/workflow-schedule-runner"
	scheduleRunnerRoleSuffix   = "-schedule-runner"
	scheduleRunnerPolicySuffix = "-schedule-runner"
)

func scheduleRunnerName(schedule *agentzv1alpha1.WorkflowSchedule) string {
	return schedule.Name + scheduleRunnerRoleSuffix
}

func scheduleLabels(schedule *agentzv1alpha1.WorkflowSchedule) map[string]string {
	labels := map[string]string{
		workflowScheduleLabel: schedule.Name,
	}
	maps.Copy(labels, schedule.Labels)
	return labels
}

func scheduleRunnerPodLabels(schedule *agentzv1alpha1.WorkflowSchedule) map[string]string {
	labels := scheduleLabels(schedule)
	labels[scheduleRunnerLabel] = schedule.Name
	return labels
}

func scheduleRunnerPolicyName(schedule *agentzv1alpha1.WorkflowSchedule) string {
	return schedule.Name + scheduleRunnerPolicySuffix
}

func (r *Reconciler) reconcileServiceAccount(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) error {
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      scheduleRunnerName(schedule),
			Namespace: schedule.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, sa, func() error {
		sa.Labels = scheduleLabels(schedule)
		sa.Annotations = schedule.Annotations
		return ctrl.SetControllerReference(schedule, sa, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch serviceaccount: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileRole(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) error {
	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      scheduleRunnerName(schedule),
			Namespace: schedule.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Labels = scheduleLabels(schedule)
		role.Annotations = schedule.Annotations
		role.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{"agentz.accuknox.com"},
				Resources: []string{"workflowschedules"},
				Verbs:     []string{"get"},
			},
			{
				APIGroups: []string{"agentz.accuknox.com"},
				Resources: []string{"workflowruns"},
				Verbs:     []string{"create", "get", "list", "watch"},
			},
		}
		return ctrl.SetControllerReference(schedule, role, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch role: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileRoleBinding(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) error {
	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      scheduleRunnerName(schedule),
			Namespace: schedule.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, roleBinding, func() error {
		roleBinding.Labels = scheduleLabels(schedule)
		roleBinding.Annotations = schedule.Annotations
		roleBinding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "Role",
			Name:     scheduleRunnerName(schedule),
		}
		roleBinding.Subjects = []rbacv1.Subject{{
			Kind:      rbacv1.ServiceAccountKind,
			Name:      scheduleRunnerName(schedule),
			Namespace: schedule.Namespace,
		}}
		return ctrl.SetControllerReference(schedule, roleBinding, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch rolebinding: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileRunnerPolicy(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      scheduleRunnerPolicyName(schedule),
			Namespace: schedule.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, policy, func() error {
		policy.Labels = scheduleLabels(schedule)
		policy.Annotations = schedule.Annotations
		policy.Spec = &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(
				ciliumlabels.NewLabel(
					scheduleRunnerLabel,
					schedule.Name,
					ciliumlabels.LabelSourceK8s,
				),
			),
			Egress: []ciliumapi.EgressRule{
				{
					EgressCommonRule: ciliumapi.EgressCommonRule{
						ToEntities: ciliumapi.EntitySlice{
							ciliumapi.EntityKubeAPIServer,
						},
					},
				},
				{
					EgressCommonRule: ciliumapi.EgressCommonRule{
						ToEndpoints: []ciliumapi.EndpointSelector{
							ciliumapi.NewESFromLabels(
								ciliumlabels.NewLabel(
									"io.kubernetes.pod.namespace",
									"kube-system",
									ciliumlabels.LabelSourceK8s,
								),
								ciliumlabels.NewLabel(
									"k8s-app",
									"kube-dns",
									ciliumlabels.LabelSourceK8s,
								),
							),
						},
					},
					ToPorts: []ciliumapi.PortRule{{
						Ports: []ciliumapi.PortProtocol{
							{Port: "53", Protocol: ciliumapi.ProtoUDP},
							{Port: "53", Protocol: ciliumapi.ProtoTCP},
						},
					}},
				},
			},
		}
		return ctrl.SetControllerReference(schedule, policy, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch runner policy: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileCronJob(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) (string, error) {
	name := schedule.Name
	err := workflow.ValidateCronSchedule(schedule.Spec.Schedule)
	if err != nil {
		return "", err
	}
	err = workflow.ValidateTimeZone(schedule.Spec.TimeZone)
	if err != nil {
		return "", err
	}

	inputsJSON := "null"
	if len(schedule.Spec.Inputs.Raw) > 0 {
		inputsJSON = string(schedule.Spec.Inputs.Raw)
	}
	if !json.Valid([]byte(inputsJSON)) {
		return "", fmt.Errorf("workflow inputs are not valid json")
	}

	cronJob := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: schedule.Namespace,
		},
	}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, cronJob, func() error {
		cronJob.Labels = scheduleLabels(schedule)
		cronJob.Annotations = schedule.Annotations
		cronJob.Spec.Schedule = schedule.Spec.Schedule
		cronJob.Spec.TimeZone = nil
		if schedule.Spec.TimeZone != "" {
			cronJob.Spec.TimeZone = &schedule.Spec.TimeZone
		}
		cronJob.Spec.Suspend = &schedule.Spec.Suspend
		cronJob.Spec.ConcurrencyPolicy = batchv1.ForbidConcurrent
		cronJob.Spec.SuccessfulJobsHistoryLimit = new(int32(1))
		cronJob.Spec.FailedJobsHistoryLimit = new(int32(1))
		cronJob.Spec.JobTemplate.Spec.BackoffLimit = new(int32(0))
		cronJob.Spec.JobTemplate.Spec.Template.Labels = scheduleRunnerPodLabels(schedule)
		cronJob.Spec.JobTemplate.Spec.Template.Spec.RestartPolicy = corev1.RestartPolicyNever
		cronJob.Spec.JobTemplate.Spec.Template.Spec.ServiceAccountName = scheduleRunnerName(schedule)
		cronJob.Spec.JobTemplate.Spec.Template.Spec.Containers = []corev1.Container{{
			Name:            "workflow-trigger",
			Image:           r.ControllerImage,
			ImagePullPolicy: corev1.PullIfNotPresent,
			Args: []string{
				"workflow",
				"run-schedule",
				"--namespace=" + schedule.Namespace,
				"--schedule-name=" + schedule.Name,
				"--agent-name=" + schedule.Spec.AgentName,
				"--workflow-name=" + schedule.Spec.WorkflowName,
				"--timeout-seconds=" + fmt.Sprintf("%d", schedule.Spec.TimeoutSeconds),
				"--inputs-json=" + inputsJSON,
			},
		}}
		return ctrl.SetControllerReference(schedule, cronJob, r.Scheme)
	})
	if err != nil {
		return "", fmt.Errorf("create or patch cronjob: %w", err)
	}
	return name, nil
}
