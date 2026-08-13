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
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	cmapi "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
	cmclientset "github.com/cert-manager/cert-manager/pkg/client/clientset/versioned"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumpolicyapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	"github.com/accuknox/agentz/internal/controller/gatewayrbac"
	"github.com/accuknox/agentz/internal/controller/sinjectorca"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gwreq"
	"github.com/accuknox/agentz/internal/networkpolicy"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var (
	errNamespaceConflict    = errors.New("workspace namespace identity conflicts")
	errStorageConflict      = errors.New("workspace package storage conflicts")
	errNetworkPolicyInvalid = errors.New("cilium rejected the workspace isolation policy")
)

// Reconciler reconciles a Workspace object.
type Reconciler struct {
	client.Client
	Direct                         client.Client
	CertClient                     cmclientset.Interface
	GatewayClient                  *gatewayapi.ClientWithResponses
	Scheme                         *runtime.Scheme
	TokenPath                      string
	SinjectorCASecretName          string
	ClusterIssuerName              string
	GatewayServiceAccountName      string
	GatewayServiceAccountNamespace string
	NixStorePVCName                string
	NixStorePVCSize                resource.Quantity
	NixStorePVCAccessModes         []corev1.PersistentVolumeAccessMode
	NixStorePVCStorageClass        string
	NixCacheTarget                 networkpolicy.Target
	SkillsS3Target                 networkpolicy.Target
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workspaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workspaces/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=tenants,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=cert-manager.io,resources=certificates,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch

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
	reportedReady := workspace.Status.ObservedAttempt == attempt &&
		workspace.Status.State == agentzv1alpha1.WorkspaceStateReady
	reportedFailed := workspace.Status.ObservedAttempt == attempt &&
		workspace.Status.State == agentzv1alpha1.WorkspaceStateFailed
	terminalReported := reportedReady || reportedFailed

	expectedName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		workspace.Spec.WorkspaceID,
	)
	if workspace.Name != expectedName {
		cause := fmt.Errorf("workspace name must equal deterministic namespace %q", expectedName)
		return r.failWorkspace(
			ctx,
			&workspace,
			attempt,
			agentzv1alpha1.WorkspaceReasonIdentityInvalid,
			"workspace identity is invalid",
			cause,
		)
	}

	if !terminalReported {
		err = r.updateLifecycleStatus(
			ctx,
			workspace.Name,
			attempt,
			agentzv1alpha1.WorkspaceStateProvisioning,
			agentzv1alpha1.WorkspaceReasonProvisioning,
			"workspace infrastructure provisioning is in progress",
		)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("mark workspace provisioning: %w", err)
		}
	}

	tenant, err := r.readyTenant(ctx, workspace.Spec.OrganizationID)
	if err != nil {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonTenantUnavailable,
			"Organisation infrastructure is not ready",
		)
	}
	if err := r.reconcileNamespace(ctx, &workspace, tenant); err != nil {
		if errors.Is(err, errNamespaceConflict) {
			return r.failWorkspace(
				ctx,
				&workspace,
				attempt,
				agentzv1alpha1.WorkspaceReasonNamespaceConflict,
				"workspace namespace identity conflicts with an existing resource",
				err,
			)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonProvisioning,
			"workspace namespace is not ready",
		)
	}
	err = gatewayrbac.Reconcile(ctx, r.Direct, gatewayrbac.Config{
		Namespace:               workspace.Name,
		ServiceAccountName:      r.GatewayServiceAccountName,
		ServiceAccountNamespace: r.GatewayServiceAccountNamespace,
		Labels: map[string]string{
			agentzv1alpha1.TenantManagedByLabel:      agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.WorkspaceNameLabel:        workspace.Name,
			agentzv1alpha1.TenantOrganizationIDLabel: tenant.Name,
		},
		Owner: *metav1.NewControllerRef(
			&workspace,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Workspace"),
		),
	})
	if err != nil {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonProvisioning,
			"workspace scoped access is not ready",
		)
	}
	if err := r.reconcileNixStorePVC(ctx, &workspace, tenant); err != nil {
		if errors.Is(err, errStorageConflict) {
			return r.failWorkspace(
				ctx,
				&workspace,
				attempt,
				agentzv1alpha1.WorkspaceReasonStorageInvalid,
				"workspace package storage conflicts with an existing resource",
				err,
			)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonStoragePending,
			"workspace package storage is not ready",
		)
	}

	valid, err := r.reconcileIsolationPolicy(ctx, &workspace, tenant)
	if err != nil {
		if errors.Is(err, errNetworkPolicyInvalid) {
			return r.failWorkspace(
				ctx,
				&workspace,
				attempt,
				agentzv1alpha1.WorkspaceReasonNetworkPolicyInvalid,
				"workspace network isolation policy is invalid",
				err,
			)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonNetworkPolicyPending,
			"workspace network isolation is not ready",
		)
	}
	if !valid {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonNetworkPolicyPending,
			"workspace network isolation is not ready",
		)
	}
	certReady, err := sinjectorca.Reconcile(ctx, r.CertClient, sinjectorca.Config{
		Name:      r.SinjectorCASecretName,
		Namespace: workspace.Name,
		Issuer:    r.ClusterIssuerName,
		Labels: map[string]string{
			agentzv1alpha1.TenantManagedByLabel:      agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.WorkspaceNameLabel:        workspace.Name,
			agentzv1alpha1.TenantOrganizationIDLabel: tenant.Name,
		},
		Owner: *metav1.NewControllerRef(
			&workspace,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Workspace"),
		),
	})
	if err != nil {
		if errors.Is(err, sinjectorca.ErrOwnershipConflict) {
			return r.failWorkspace(
				ctx,
				&workspace,
				attempt,
				agentzv1alpha1.WorkspaceReasonCertificateInvalid,
				"workspace certificate could not be reconciled safely",
				err,
			)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonCertificatePending,
			"workspace certificate is not ready",
		)
	}
	if !certReady {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, r.markPending(
			ctx,
			&workspace,
			attempt,
			terminalReported,
			agentzv1alpha1.WorkspaceReasonCertificatePending,
			"workspace certificate is not ready",
		)
	}
	if reportedFailed {
		failureReason := "workspace infrastructure provisioning failed"
		degraded := apimeta.FindStatusCondition(
			workspace.Status.Conditions,
			agentzv1alpha1.WorkspaceConditionDegraded,
		)
		if degraded != nil && degraded.Message != "" {
			failureReason = degraded.Message
		}
		if err := r.reportLifecycleState(
			ctx,
			&workspace,
			attempt,
			gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed,
			&failureReason,
		); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if !reportedReady {
		err = r.updateLifecycleStatus(
			ctx,
			workspace.Name,
			attempt,
			agentzv1alpha1.WorkspaceStateReady,
			agentzv1alpha1.WorkspaceReasonInfrastructureReady,
			"workspace infrastructure is ready",
		)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("mark workspace ready: %w", err)
		}
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
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&ciliumv2.CiliumNetworkPolicy{}).
		Owns(&cmapi.Certificate{}).
		Owns(&rbacv1.Role{}).
		Owns(&rbacv1.RoleBinding{}).
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
		if ns.UID != "" {
			if ns.Labels[agentzv1alpha1.TenantManagedByLabel] != agentzv1alpha1.TenantManagedByValue ||
				ns.Labels[agentzv1alpha1.WorkspaceNameLabel] != workspace.Name ||
				ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel] != tenant.Name ||
				ns.Annotations[agentzv1alpha1.WorkspaceIDAnnotation] != workspace.Spec.WorkspaceID ||
				ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation] != workspace.Spec.OrganizationID {
				return errNamespaceConflict
			}
			for _, owner := range ns.OwnerReferences {
				if owner.Controller != nil && *owner.Controller && owner.UID != workspace.UID {
					return errNamespaceConflict
				}
			}
		}
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

		err := controllerutil.SetControllerReference(workspace, ns, r.Scheme)
		if err != nil {
			return fmt.Errorf("%w: controller owner", errNamespaceConflict)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile workspace namespace: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileNixStorePVC(ctx context.Context, workspace *agentzv1alpha1.Workspace, tenant *agentzv1alpha1.Tenant) error {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name:      r.NixStorePVCName,
		Namespace: workspace.Name,
	}}
	_, err := controllerutil.CreateOrPatch(ctx, r.Direct, pvc, func() error {
		if pvc.UID != "" {
			managed := pvc.Labels[agentzv1alpha1.TenantManagedByLabel] ==
				agentzv1alpha1.TenantManagedByValue
			workspaceOwned := pvc.Labels[agentzv1alpha1.WorkspaceNameLabel] ==
				workspace.Name
			organizationOwned := pvc.Labels[agentzv1alpha1.TenantOrganizationIDLabel] ==
				tenant.Name
			if !managed || !workspaceOwned || !organizationOwned {
				return errStorageConflict
			}
			for _, owner := range pvc.OwnerReferences {
				if owner.Controller != nil && *owner.Controller && owner.UID != workspace.UID {
					return errStorageConflict
				}
			}
			if !slices.Equal(pvc.Spec.AccessModes, r.NixStorePVCAccessModes) {
				return errStorageConflict
			}
			if r.NixStorePVCStorageClass != "" &&
				(pvc.Spec.StorageClassName == nil ||
					*pvc.Spec.StorageClassName != r.NixStorePVCStorageClass) {
				return errStorageConflict
			}
		}

		if pvc.Labels == nil {
			pvc.Labels = map[string]string{}
		}
		pvc.Labels[agentzv1alpha1.TenantManagedByLabel] = agentzv1alpha1.TenantManagedByValue
		pvc.Labels[agentzv1alpha1.WorkspaceNameLabel] = workspace.Name
		pvc.Labels[agentzv1alpha1.TenantOrganizationIDLabel] = tenant.Name
		pvc.Spec.AccessModes = append(
			[]corev1.PersistentVolumeAccessMode{},
			r.NixStorePVCAccessModes...,
		)
		if pvc.Spec.Resources.Requests == nil {
			pvc.Spec.Resources.Requests = corev1.ResourceList{}
		}
		current := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
		if current.Cmp(r.NixStorePVCSize) < 0 {
			pvc.Spec.Resources.Requests[corev1.ResourceStorage] = r.NixStorePVCSize
		}
		if r.NixStorePVCStorageClass != "" {
			pvc.Spec.StorageClassName = &r.NixStorePVCStorageClass
		}
		if err := controllerutil.SetControllerReference(workspace, pvc, r.Scheme); err != nil {
			return fmt.Errorf("%w: controller owner", errStorageConflict)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile workspace nix store pvc: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileIsolationPolicy(ctx context.Context, workspace *agentzv1alpha1.Workspace, tenant *agentzv1alpha1.Tenant) (bool, error) {
	nonPackageJobs := ciliumpolicyapi.NewESFromK8sLabelSelector(
		ciliumlabels.LabelSourceK8sKeyPrefix,
		&slimv1.LabelSelector{MatchExpressions: []slimv1.LabelSelectorRequirement{{
			Key:      agentzv1alpha1.AgentPackageJobLabel,
			Operator: slimv1.LabelSelectorOpDoesNotExist,
		}}},
	)
	packageJobs := ciliumpolicyapi.NewESFromK8sLabelSelector(
		ciliumlabels.LabelSourceK8sKeyPrefix,
		&slimv1.LabelSelector{MatchExpressions: []slimv1.LabelSelectorRequirement{{
			Key:      agentzv1alpha1.AgentPackageJobLabel,
			Operator: slimv1.LabelSelectorOpExists,
		}}},
	)
	systemServices := ciliumpolicyapi.NewESFromLabels(
		ciliumlabels.NewLabel(
			"io.kubernetes.pod.namespace",
			"agentz-system",
			ciliumlabels.LabelSourceK8s,
		),
	)
	packageRule := (&ciliumpolicyapi.Rule{
		Description:      "Restrict package jobs to the configured Nix and Skill stores.",
		EndpointSelector: packageJobs,
		Egress: networkpolicy.ExternalEgress([]networkpolicy.Target{
			r.NixCacheTarget,
			r.SkillsS3Target,
		}),
	}).WithEnableDefaultDeny(true, true)
	policies := []*ciliumv2.CiliumNetworkPolicy{
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:      agentzv1alpha1.WorkspaceIsolationPolicyName,
				Namespace: workspace.Name,
			},
			Spec: &ciliumpolicyapi.Rule{
				Description:      "Isolate the Workspace while allowing local traffic and DNS.",
				EndpointSelector: nonPackageJobs,
				Ingress: []ciliumpolicyapi.IngressRule{
					{
						IngressCommonRule: ciliumpolicyapi.IngressCommonRule{
							FromEndpoints: []ciliumpolicyapi.EndpointSelector{nonPackageJobs},
						},
					},
					{
						IngressCommonRule: ciliumpolicyapi.IngressCommonRule{
							FromEndpoints: []ciliumpolicyapi.EndpointSelector{systemServices},
						},
					},
				},
				Egress: []ciliumpolicyapi.EgressRule{
					{
						EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
							ToEndpoints: []ciliumpolicyapi.EndpointSelector{nonPackageJobs},
						},
					},
					{
						EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
							ToEndpoints: []ciliumpolicyapi.EndpointSelector{systemServices},
						},
					},
					{
						EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
							ToEndpoints: []ciliumpolicyapi.EndpointSelector{{
								LabelSelector: &slimv1.LabelSelector{
									MatchLabels: map[string]string{
										"k8s:io.kubernetes.pod.namespace": "kube-system",
										"k8s:k8s-app":                     "kube-dns",
									},
								},
							}},
						},
						ToPorts: []ciliumpolicyapi.PortRule{{
							Ports: []ciliumpolicyapi.PortProtocol{
								{Port: "53", Protocol: "UDP"},
								{Port: "53", Protocol: "TCP"},
							},
						}},
					},
				},
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:      agentzv1alpha1.WorkspacePackagePolicyName,
				Namespace: workspace.Name,
			},
			Spec: packageRule,
		},
	}

	ready := true
	for _, policy := range policies {
		spec := policy.Spec
		_, err := controllerutil.CreateOrPatch(ctx, r.Direct, policy, func() error {
			if policy.Labels == nil {
				policy.Labels = map[string]string{}
			}
			policy.Labels[agentzv1alpha1.TenantManagedByLabel] = agentzv1alpha1.TenantManagedByValue
			policy.Labels[agentzv1alpha1.WorkspaceNameLabel] = workspace.Name
			policy.Labels[agentzv1alpha1.TenantOrganizationIDLabel] = tenant.Name
			policy.Spec = spec
			policy.Specs = nil
			return controllerutil.SetControllerReference(workspace, policy, r.Scheme)
		})
		if err != nil {
			return false, fmt.Errorf("reconcile workspace network policy: %w", err)
		}

		valid := false
		for _, condition := range policy.Status.Conditions {
			if condition.Type != ciliumv2.PolicyConditionValid {
				continue
			}
			if condition.Status == corev1.ConditionFalse {
				return false, errNetworkPolicyInvalid
			}
			valid = condition.Status == corev1.ConditionTrue
		}
		if !valid {
			ready = false
		}
	}
	return ready, nil
}

func (r *Reconciler) markPending(ctx context.Context, workspace *agentzv1alpha1.Workspace, attempt int64, terminalReported bool, reason, message string) error {
	if terminalReported {
		return nil
	}
	return r.updateLifecycleStatus(
		ctx,
		workspace.Name,
		attempt,
		agentzv1alpha1.WorkspaceStateProvisioning,
		reason,
		message,
	)
}

func (r *Reconciler) failWorkspace(ctx context.Context, workspace *agentzv1alpha1.Workspace, attempt int64, reason, message string, cause error) (ctrl.Result, error) {
	logf.FromContext(ctx).Error(
		cause,
		"workspace namespace provisioning failed",
		"workspace",
		workspace.Name,
		"attempt",
		attempt,
	)
	failureReason := message
	err := r.updateLifecycleStatus(
		ctx,
		workspace.Name,
		attempt,
		agentzv1alpha1.WorkspaceStateFailed,
		reason,
		message,
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark workspace failed: %w", err)
	}
	err = r.reportLifecycleState(
		ctx,
		workspace,
		attempt,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed,
		&failureReason,
	)
	if err != nil {
		return ctrl.Result{}, err
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
