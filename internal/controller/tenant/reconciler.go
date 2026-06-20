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

package tenant

import (
	"context"
	"fmt"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	ciliumpolicyapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// Reconciler reconciles a Tenant object.
type Reconciler struct {
	client.Client
	Direct client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=tenants,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=tenants/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=tenants/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch

// Reconcile converges a Tenant into an isolated namespace and network policy.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var tenant clawarmorv1alpha1.Tenant
	if err := r.Get(ctx, req.NamespacedName, &tenant); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("get tenant: %w", err)
	}

	nsName := clawarmorv1alpha1.TenantName(tenant.Spec.OrganizationID)
	err := r.updateStatus(ctx, tenant.Name, func(current *clawarmorv1alpha1.Tenant) {
		current.Status.Namespace = nsName
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark tenant progressing: %w", err)
	}

	if err := r.reconcileNamespace(ctx, &tenant, nsName); err != nil {
		log.Error(err, "tenant namespace reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, err)
	}
	if err := r.reconcileIsolationPolicy(ctx, &tenant, nsName); err != nil {
		log.Error(err, "tenant isolation policy reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, err)
	}

	err = r.updateStatus(ctx, tenant.Name, func(current *clawarmorv1alpha1.Tenant) {
		current.Status.Namespace = nsName
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonNamespaceReady,
			Message:            "tenant bootstrap completed",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.TenantReasonNamespaceReady,
			Message:            "tenant namespace is ready",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonNamespaceReady,
			Message:            "tenant namespace is ready",
			ObservedGeneration: current.Generation,
		})
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("update tenant status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Tenant{}).
		WithEventFilter(predicate.GenerationChangedPredicate{}).
		Named("tenant").
		Complete(r)
}

func (r *Reconciler) reconcileNamespace(ctx context.Context, tenant *clawarmorv1alpha1.Tenant, nsName string) error {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: nsName}}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), ns, func() error {
		if ns.Labels == nil {
			ns.Labels = map[string]string{}
		}
		ns.Labels[clawarmorv1alpha1.TenantManagedByLabel] = clawarmorv1alpha1.TenantManagedByValue
		ns.Labels[clawarmorv1alpha1.TenantNameLabel] = tenant.Name

		if ns.Annotations == nil {
			ns.Annotations = map[string]string{}
		}
		ns.Annotations[clawarmorv1alpha1.TenantOrganizationIDAnnotation] = tenant.Spec.OrganizationID
		ns.Annotations[clawarmorv1alpha1.TenantUserIDAnnotation] = tenant.Spec.UserID
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile namespace: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileIsolationPolicy(ctx context.Context, tenant *clawarmorv1alpha1.Tenant, nsName string) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      clawarmorv1alpha1.TenantIsolationPolicyName,
			Namespace: nsName,
		},
	}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), policy, func() error {
		if policy.Labels == nil {
			policy.Labels = map[string]string{}
		}
		policy.Labels[clawarmorv1alpha1.TenantManagedByLabel] = clawarmorv1alpha1.TenantManagedByValue
		policy.Labels[clawarmorv1alpha1.TenantNameLabel] = tenant.Name

		policy.Spec = &ciliumpolicyapi.Rule{
			Description:      "Restrict tenant traffic to the same namespace only.",
			EndpointSelector: ciliumpolicyapi.WildcardEndpointSelector,
			Ingress: []ciliumpolicyapi.IngressRule{{
				IngressCommonRule: ciliumpolicyapi.IngressCommonRule{
					FromEndpoints: []ciliumpolicyapi.EndpointSelector{
						ciliumpolicyapi.WildcardEndpointSelector,
					},
				},
			}},
			Egress: []ciliumpolicyapi.EgressRule{
				{
					EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
						ToEndpoints: []ciliumpolicyapi.EndpointSelector{
							ciliumpolicyapi.WildcardEndpointSelector,
						},
					},
				},
				{
					EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
						ToEndpoints: []ciliumpolicyapi.EndpointSelector{
							{
								LabelSelector: &slimv1.LabelSelector{
									MatchLabels: map[string]string{
										"k8s:io.kubernetes.pod.namespace": "kube-system",
										"k8s:k8s-app":                     "kube-dns",
									},
								},
							},
						},
					},
					ToPorts: []ciliumpolicyapi.PortRule{
						{
							Ports: []ciliumpolicyapi.PortProtocol{
								{Port: "53", Protocol: "UDP"},
								{Port: "53", Protocol: "TCP"},
							},
						},
					},
				},
			},
		}
		policy.Specs = nil
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile cilium network policy: %w", err)
	}
	return nil
}

func (r *Reconciler) directClient() client.Client {
	if r.Direct != nil {
		return r.Direct
	}
	return r.Client
}

func (r *Reconciler) failTenant(ctx context.Context, tenant *clawarmorv1alpha1.Tenant, cause error) (ctrl.Result, error) {
	err := r.updateStatus(ctx, tenant.Name, func(current *clawarmorv1alpha1.Tenant) {
		current.Status.Namespace = clawarmorv1alpha1.TenantName(current.Spec.OrganizationID)
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapFailed,
			Message:            cause.Error(),
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapFailed,
			Message:            cause.Error(),
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.TenantReasonBootstrapFailed,
			Message:            cause.Error(),
			ObservedGeneration: current.Generation,
		})
	})
	if err != nil && !apierrors.IsConflict(err) {
		return ctrl.Result{}, fmt.Errorf("update failed tenant status: %w", err)
	}
	return ctrl.Result{}, cause
}

func (r *Reconciler) updateStatus(ctx context.Context, name string, mutate func(*clawarmorv1alpha1.Tenant)) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var tenant clawarmorv1alpha1.Tenant
		if err := r.Get(ctx, client.ObjectKey{Name: name}, &tenant); err != nil {
			return err
		}
		mutate(&tenant)
		return r.Status().Update(ctx, &tenant)
	})
}
