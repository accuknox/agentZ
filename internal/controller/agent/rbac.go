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

package agent

import (
	"context"
	"fmt"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const workflowRunStatusRoleSuffix = "-workflowrun-status"

func (r *Reconciler) reconcileWorkflowRunAccess(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	err := r.reconcileServiceAccount(ctx, agt, agt.Name, resourceLabels(agt))
	if err != nil {
		return err
	}
	err = r.reconcileWorkflowRunStatusRole(ctx, agt)
	if err != nil {
		return err
	}
	err = r.reconcileWorkflowRunStatusRoleBinding(ctx, agt)
	if err != nil {
		return err
	}
	return nil
}

func (r *Reconciler) reconcileWorkflowRunStatusRole(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	name := agt.Name + workflowRunStatusRoleSuffix
	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: agt.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Labels = resourceLabels(agt)
		role.Annotations = agt.Annotations
		role.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{"clawarmor.accuknox.com"},
				Resources: []string{"workflowruns/status"},
				Verbs:     []string{"patch"},
			},
		}
		return ctrl.SetControllerReference(agt, role, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch workflow run status role: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileWorkflowRunStatusRoleBinding(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	name := agt.Name + workflowRunStatusRoleSuffix
	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: agt.Namespace,
		},
	}
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, roleBinding, func() error {
		roleBinding.Labels = resourceLabels(agt)
		roleBinding.Annotations = agt.Annotations
		roleBinding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "Role",
			Name:     name,
		}
		roleBinding.Subjects = []rbacv1.Subject{{
			Kind:      rbacv1.ServiceAccountKind,
			Name:      agt.Name,
			Namespace: agt.Namespace,
		}}
		return ctrl.SetControllerReference(agt, roleBinding, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch workflow run status rolebinding: %w", err)
	}
	return nil
}
