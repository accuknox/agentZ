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

// Package gatewayrbac grants the gateway access inside one managed namespace.
package gatewayrbac

import (
	"context"
	"fmt"
	"maps"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const accessName = "agentz-gateway"

// Config identifies one namespace and the gateway ServiceAccount allowed to
// manage its API resources.
type Config struct {
	Namespace               string
	ServiceAccountName      string
	ServiceAccountNamespace string
	Labels                  map[string]string
	Owner                   metav1.OwnerReference
}

// The manager must hold every permission delegated by this Role because
// Kubernetes rejects RBAC privilege escalation during reconciliation.
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=agents;skills;sandboxes;inferencepools;inferenceproviders,verbs=create;delete;get;list;update;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=mcpconnections;secrets;workflowruns,verbs=create;delete;get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workflowschedules,verbs=create;delete;get;list;update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workflowruns/status,verbs=get;patch;update

// Reconcile converges the namespace-local gateway Role and RoleBinding.
func Reconcile(ctx context.Context, c client.Client, cfg Config) error {
	if cfg.ServiceAccountName == "" {
		return fmt.Errorf("gateway service account name is required")
	}
	if cfg.ServiceAccountNamespace == "" {
		return fmt.Errorf("gateway service account namespace is required")
	}

	role := &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{
		Name:      accessName,
		Namespace: cfg.Namespace,
	}}
	_, err := controllerutil.CreateOrPatch(
		ctx,
		c,
		role,
		func() error {
			role.Labels = maps.Clone(cfg.Labels)
			role.OwnerReferences = []metav1.OwnerReference{cfg.Owner}
			role.Rules = rules()
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("reconcile gateway role: %w", err)
	}

	binding := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{
		Name:      accessName,
		Namespace: cfg.Namespace,
	}}
	_, err = controllerutil.CreateOrPatch(
		ctx,
		c,
		binding,
		func() error {
			binding.Labels = maps.Clone(cfg.Labels)
			binding.OwnerReferences = []metav1.OwnerReference{cfg.Owner}
			binding.RoleRef = rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "Role",
				Name:     accessName,
			}
			binding.Subjects = []rbacv1.Subject{{
				Kind:      rbacv1.ServiceAccountKind,
				Name:      cfg.ServiceAccountName,
				Namespace: cfg.ServiceAccountNamespace,
			}}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("reconcile gateway role binding: %w", err)
	}
	return nil
}

func rules() []rbacv1.PolicyRule {
	group := agentzv1alpha1.SchemeGroupVersion.Group
	return []rbacv1.PolicyRule{
		{
			APIGroups: []string{""},
			Resources: []string{"persistentvolumeclaims"},
			Verbs:     []string{"get", "list", "watch"},
		},
		{
			APIGroups: []string{group},
			Resources: []string{
				"agents", "skills", "sandboxes", "inferencepools", "inferenceproviders",
			},
			Verbs: []string{"create", "delete", "get", "list", "update", "watch"},
		},
		{
			APIGroups: []string{group},
			Resources: []string{"mcpconnections", "secrets", "workflowruns"},
			Verbs:     []string{"create", "delete", "get", "list", "watch"},
		},
		{
			APIGroups: []string{group},
			Resources: []string{"workflowschedules"},
			Verbs:     []string{"create", "delete", "get", "list", "update"},
		},
		{
			APIGroups: []string{group},
			Resources: []string{"workflowruns/status"},
			Verbs:     []string{"get", "patch", "update"},
		},
	}
}
