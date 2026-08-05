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

// Package workspace provisions the Kubernetes namespace owned by a Workspace.
package workspace

import (
	"context"
	"fmt"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gwreq"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Reconciler reconciles a Workspace object.
type Reconciler struct {
	client.Client
	Direct        client.Client
	GatewayClient *gatewayapi.ClientWithResponses
	Scheme        *runtime.Scheme
	TokenPath     string
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workspaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workspaces/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=tenants,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;update;patch

// Reconcile creates the deterministic namespace for a Workspace.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var workspace agentzv1alpha1.Workspace
	err := r.Get(ctx, req.NamespacedName, &workspace)
	if apierrors.IsNotFound(err) {
		return ctrl.Result{}, nil
	}
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("get workspace: %w", err)
	}
	if !workspace.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	attempt := workspace.Spec.ProvisioningAttempt
	terminal := workspace.Status.State == agentzv1alpha1.WorkspaceStateReady ||
		workspace.Status.State == agentzv1alpha1.WorkspaceStateFailed
	if workspace.Status.ObservedAttempt == attempt && terminal {
		return ctrl.Result{}, nil
	}

	expectedName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		workspace.Spec.WorkspaceID,
	)
	if workspace.Name != expectedName {
		cause := fmt.Errorf("workspace name must equal deterministic namespace %q", expectedName)
		return r.failWorkspace(ctx, &workspace, attempt, cause)
	}

	err = r.updateLifecycleStatus(
		ctx,
		workspace.Name,
		attempt,
		agentzv1alpha1.WorkspaceStateProvisioning,
		agentzv1alpha1.WorkspaceReasonProvisioning,
		"workspace namespace provisioning in progress",
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark workspace provisioning: %w", err)
	}

	tenant, err := r.readyTenant(ctx, workspace.Spec.OrganizationID)
	if err != nil {
		return r.failWorkspace(ctx, &workspace, attempt, err)
	}
	if err := r.reconcileNamespace(ctx, &workspace, tenant); err != nil {
		return r.failWorkspace(ctx, &workspace, attempt, err)
	}

	if err := r.reportLifecycleState(
		ctx,
		&workspace,
		attempt,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateReady,
		nil,
	); err != nil {
		return ctrl.Result{}, err
	}
	err = r.updateLifecycleStatus(
		ctx,
		workspace.Name,
		attempt,
		agentzv1alpha1.WorkspaceStateReady,
		agentzv1alpha1.WorkspaceReasonNamespaceReady,
		"workspace namespace is ready",
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark workspace ready: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(
			&agentzv1alpha1.Workspace{},
			builder.WithPredicates(predicate.GenerationChangedPredicate{}),
		).
		Owns(&corev1.Namespace{}).
		Named("workspace").
		Complete(r)
}

func (r *Reconciler) readyTenant(ctx context.Context, organizationID string) (*agentzv1alpha1.Tenant, error) {
	name := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	var tenant agentzv1alpha1.Tenant
	if err := r.Direct.Get(ctx, client.ObjectKey{Name: name}, &tenant); err != nil {
		return nil, fmt.Errorf("get organization tenant %q: %w", name, err)
	}
	if tenant.Spec.OrganizationID != organizationID {
		return nil, fmt.Errorf("organization tenant %q has a different organization ID", name)
	}

	ready := apimeta.FindStatusCondition(
		tenant.Status.Conditions,
		agentzv1alpha1.TenantConditionReady,
	)
	if ready == nil || ready.Status != metav1.ConditionTrue {
		return nil, fmt.Errorf("organization tenant %q is not ready", name)
	}
	if ready.ObservedGeneration != tenant.Generation ||
		tenant.Status.ObservedGeneration != tenant.Generation {
		return nil, fmt.Errorf("organization tenant %q has not observed its current generation", name)
	}
	if tenant.Status.Namespace != name {
		return nil, fmt.Errorf("organization tenant %q has namespace %q", name, tenant.Status.Namespace)
	}
	return &tenant, nil
}

func (r *Reconciler) reconcileNamespace(ctx context.Context, workspace *agentzv1alpha1.Workspace, tenant *agentzv1alpha1.Tenant) error {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: workspace.Name}}
	_, err := controllerutil.CreateOrPatch(ctx, r.Direct, ns, func() error {
		if ns.Labels == nil {
			ns.Labels = map[string]string{}
		}
		ns.Labels[agentzv1alpha1.TenantManagedByLabel] = agentzv1alpha1.TenantManagedByValue
		ns.Labels[agentzv1alpha1.WorkspaceNameLabel] = workspace.Name
		ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel] = tenant.Name

		if ns.Annotations == nil {
			ns.Annotations = map[string]string{}
		}
		ns.Annotations[agentzv1alpha1.WorkspaceIDAnnotation] = workspace.Spec.WorkspaceID
		ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation] = workspace.Spec.OrganizationID

		return controllerutil.SetControllerReference(workspace, ns, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile workspace namespace: %w", err)
	}
	return nil
}

func (r *Reconciler) failWorkspace(ctx context.Context, workspace *agentzv1alpha1.Workspace, attempt int64, cause error) (ctrl.Result, error) {
	logf.FromContext(ctx).Error(
		cause,
		"workspace namespace provisioning failed",
		"workspace",
		workspace.Name,
		"attempt",
		attempt,
	)
	reason := cause.Error()
	err := r.reportLifecycleState(
		ctx,
		workspace,
		attempt,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed,
		&reason,
	)
	if err != nil {
		return ctrl.Result{}, err
	}
	err = r.updateLifecycleStatus(
		ctx,
		workspace.Name,
		attempt,
		agentzv1alpha1.WorkspaceStateFailed,
		agentzv1alpha1.WorkspaceReasonProvisioningFailed,
		reason,
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark workspace failed: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) reportLifecycleState(ctx context.Context, workspace *agentzv1alpha1.Workspace, attempt int64, state gatewayapi.UpdateWorkspaceLifecycleRequestState, failureReason *string) error {
	if r.GatewayClient == nil {
		return fmt.Errorf("gateway client is not configured")
	}

	tenantNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		workspace.Spec.OrganizationID,
	)
	resp, err := r.GatewayClient.UpdateWorkspaceLifecycleWithResponse(
		ctx,
		workspace.Spec.WorkspaceID,
		gatewayapi.UpdateWorkspaceLifecycleJSONRequestBody{
			FailureReason:       failureReason,
			ProvisioningAttempt: attempt,
			State:               state,
		},
		gwreq.RequestEditor(r.TokenPath, tenantNamespace),
	)
	if err != nil {
		return fmt.Errorf("report workspace lifecycle: %w", err)
	}
	if resp.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("report workspace lifecycle returned status %d", resp.StatusCode())
	}
	return nil
}

func (r *Reconciler) updateLifecycleStatus(ctx context.Context, name string, attempt int64, state agentzv1alpha1.WorkspaceState, reason, message string) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var workspace agentzv1alpha1.Workspace
		if err := r.Direct.Get(ctx, client.ObjectKey{Name: name}, &workspace); err != nil {
			return err
		}
		if workspace.Spec.ProvisioningAttempt != attempt {
			return nil
		}

		workspace.Status.Namespace = workspace.Name
		workspace.Status.ObservedGeneration = workspace.Generation
		workspace.Status.ObservedAttempt = attempt
		workspace.Status.State = state
		workspace.Status.SetCondition(workspaceCondition(
			agentzv1alpha1.WorkspaceConditionProgressing,
			state == agentzv1alpha1.WorkspaceStateProvisioning,
			reason,
			message,
			workspace.Generation,
		))
		workspace.Status.SetCondition(workspaceCondition(
			agentzv1alpha1.WorkspaceConditionReady,
			state == agentzv1alpha1.WorkspaceStateReady,
			reason,
			message,
			workspace.Generation,
		))
		workspace.Status.SetCondition(workspaceCondition(
			agentzv1alpha1.WorkspaceConditionDegraded,
			state == agentzv1alpha1.WorkspaceStateFailed,
			reason,
			message,
			workspace.Generation,
		))
		return r.Direct.Status().Update(ctx, &workspace)
	})
}

func workspaceCondition(conditionType string, isTrue bool, reason, message string, generation int64) metav1.Condition {
	status := metav1.ConditionFalse
	if isTrue {
		status = metav1.ConditionTrue
	}
	return metav1.Condition{
		Type:               conditionType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	}
}
