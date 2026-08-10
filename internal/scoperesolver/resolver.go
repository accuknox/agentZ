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

// Package scoperesolver maps explicit resource scope to stable namespaces.
package scoperesolver

import (
	"context"
	"errors"
	"fmt"
	"slices"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Namespace resolves scope from a verified Organisation or Workspace namespace.
func Namespace(ctx context.Context, c client.Reader, current string, scope agentzv1alpha1.ResourceScope) (string, error) {
	var ns corev1.Namespace
	if err := c.Get(ctx, client.ObjectKey{Name: current}, &ns); err != nil {
		return "", fmt.Errorf("get current namespace: %w", err)
	}

	workspaceName := ns.Labels[agentzv1alpha1.WorkspaceNameLabel]
	if workspaceName == "" {
		if ns.Labels[agentzv1alpha1.TenantNameLabel] != current {
			return "", errors.New("current namespace has no AgentZ scope identity")
		}
		if scope != agentzv1alpha1.ResourceScopeOrganisation {
			return "", errors.New("organisation namespaces cannot resolve workspace resources")
		}
		return current, nil
	}
	if workspaceName != current {
		return "", errors.New("current namespace has an invalid Workspace identity")
	}
	if scope == agentzv1alpha1.ResourceScopeWorkspace {
		return current, nil
	}
	if scope != agentzv1alpha1.ResourceScopeOrganisation {
		return "", errors.New("resource scope is invalid")
	}

	var workspace agentzv1alpha1.Workspace
	if err := c.Get(ctx, client.ObjectKey{Name: workspaceName}, &workspace); err != nil {
		return "", fmt.Errorf("get current Workspace identity: %w", err)
	}
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		workspace.Spec.OrganizationID,
	)
	if ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel] != organizationNamespace {
		return "", errors.New("current namespace has an invalid Organisation identity")
	}
	return organizationNamespace, nil
}

// SelectedNamespace resolves a scoped resource reference and enforces the
// Workspace's explicit Organisation selection for the generated resource kind.
func SelectedNamespace(ctx context.Context, c client.Reader, current string, scope agentzv1alpha1.ResourceScope, kind agentzv1alpha1.OrganizationResourceKind, name string) (string, error) {
	ns, err := Namespace(ctx, c, current, scope)
	if err != nil || scope == agentzv1alpha1.ResourceScopeWorkspace || ns == current {
		return ns, err
	}
	workspace := &agentzv1alpha1.Workspace{}
	if err := c.Get(ctx, client.ObjectKey{Name: current}, workspace); err != nil {
		return "", fmt.Errorf("get Workspace selection: %w", err)
	}
	names := workspace.Spec.SelectedOrganizationResources.Names(kind)
	if !slices.Contains(names, name) {
		return "", fmt.Errorf("organisation resource %q is not selected by Workspace", name)
	}
	return ns, nil
}
