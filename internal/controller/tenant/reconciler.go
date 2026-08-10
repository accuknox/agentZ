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
	"errors"
	"fmt"
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
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	"github.com/accuknox/agentz/internal/controller/gatewayrbac"
	"github.com/accuknox/agentz/internal/controller/sinjectorca"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	agentLabelKey                  = "agentz.accuknox.com/agent"
	workflowScheduleRunnerLabelKey = "agentz.accuknox.com/workflow-schedule-runner"
)

var errTenantIdentityConflict = errors.New("tenant infrastructure identity conflicts")

// Reconciler reconciles a Tenant object.
type Reconciler struct {
	client.Client
	Direct                         client.Client
	CertClient                     cmclientset.Interface
	Scheme                         *runtime.Scheme
	NixStorePVCName                string
	NixStorePVCSize                resource.Quantity
	NixStorePVCAccessModes         []corev1.PersistentVolumeAccessMode
	NixStorePVCStorageClass        string
	SinjectorCASecretName          string
	ClusterIssuerName              string
	ManagerServiceAccountName      string
	ManagerServiceAccountNamespace string
	GatewayServiceAccountName      string
	GatewayServiceAccountNamespace string
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=tenants,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=tenants,verbs=use
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=tenants/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=cert-manager.io,resources=certificates,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles;clusterrolebindings,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch

// Reconcile converges a Tenant into an isolated namespace and network policy.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var tenant agentzv1alpha1.Tenant
	if err := r.Get(ctx, req.NamespacedName, &tenant); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("get tenant: %w", err)
	}
	organizationLabel := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		tenant.Spec.OrganizationID,
	)
	if tenant.Name != organizationLabel {
		cause := fmt.Errorf("tenant name must equal deterministic namespace %q", organizationLabel)
		return r.failTenant(ctx, &tenant, "Organisation identity is invalid", cause)
	}
	if tenant.Labels[agentzv1alpha1.TenantOrganizationIDLabel] != organizationLabel {
		base := tenant.DeepCopy()
		if tenant.Labels == nil {
			tenant.Labels = map[string]string{}
		}
		tenant.Labels[agentzv1alpha1.TenantOrganizationIDLabel] = organizationLabel
		if err := r.Patch(ctx, &tenant, client.MergeFrom(base)); err != nil {
			return ctrl.Result{}, fmt.Errorf("label tenant identity: %w", err)
		}
	}

	nsName := tenant.Name
	err := r.updateStatus(ctx, tenant.Name, func(current *agentzv1alpha1.Tenant) {
		current.Status.Namespace = nsName
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionTrue,
			Reason:             agentzv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonBootstrapping,
			Message:            "tenant bootstrap in progress",
			ObservedGeneration: current.Generation,
		})
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("mark tenant progressing: %w", err)
	}

	if err := r.reconcileNamespace(ctx, &tenant, nsName); err != nil {
		log.Error(err, "tenant namespace reconcile failed", "tenant", tenant.Name)
		if errors.Is(err, errTenantIdentityConflict) {
			return r.failTenant(ctx, &tenant, "Organisation namespace identity conflicts with an existing resource", err)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, err
	}
	if err := r.reconcileNixStorePVC(ctx, &tenant, nsName); err != nil {
		log.Error(err, "tenant nix store pvc reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, "Organisation storage could not be reconciled", err)
	}
	certReady, err := sinjectorca.Reconcile(ctx, r.CertClient, sinjectorca.Config{
		Name:      r.SinjectorCASecretName,
		Namespace: nsName,
		Issuer:    r.ClusterIssuerName,
		Labels: map[string]string{
			agentzv1alpha1.TenantManagedByLabel: agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.TenantNameLabel:      tenant.Name,
		},
		Owner: *metav1.NewControllerRef(
			&tenant,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
		),
	})
	if err != nil {
		log.Error(err, "tenant sinjector certificate reconcile failed", "tenant", tenant.Name)
		if errors.Is(err, sinjectorca.ErrOwnershipConflict) {
			return r.failTenant(ctx, &tenant, "Organisation certificate could not be reconciled safely", err)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, err
	}
	if !certReady {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}
	if err := r.reconcileIsolationPolicy(ctx, &tenant, nsName); err != nil {
		log.Error(err, "tenant isolation policy reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, "Organisation network isolation could not be reconciled", err)
	}
	if err := r.reconcileGatewayAccess(ctx, &tenant); err != nil {
		log.Error(err, "tenant gateway access reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, "Organisation scoped access could not be reconciled", err)
	}
	err = gatewayrbac.Reconcile(ctx, r.directClient(), gatewayrbac.Config{
		Namespace:               nsName,
		ServiceAccountName:      r.GatewayServiceAccountName,
		ServiceAccountNamespace: r.GatewayServiceAccountNamespace,
		Labels: map[string]string{
			agentzv1alpha1.TenantManagedByLabel: agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.TenantNameLabel:      tenant.Name,
		},
		Owner: *metav1.NewControllerRef(
			&tenant,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
		),
	})
	if err != nil {
		log.Error(err, "tenant gateway RBAC reconcile failed", "tenant", tenant.Name)
		return r.failTenant(ctx, &tenant, "Organisation scoped access could not be reconciled", err)
	}

	err = r.updateStatus(ctx, tenant.Name, func(current *agentzv1alpha1.Tenant) {
		current.Status.Namespace = nsName
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonNamespaceReady,
			Message:            "tenant bootstrap completed",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             agentzv1alpha1.TenantReasonNamespaceReady,
			Message:            "tenant namespace is ready",
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonNamespaceReady,
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
		For(
			&agentzv1alpha1.Tenant{},
			builder.WithPredicates(tenantChangePredicate()),
		).
		Owns(&corev1.Namespace{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&ciliumv2.CiliumNetworkPolicy{}).
		Owns(&cmapi.Certificate{}).
		Owns(&rbacv1.ClusterRole{}).
		Owns(&rbacv1.ClusterRoleBinding{}).
		Owns(&rbacv1.Role{}).
		Owns(&rbacv1.RoleBinding{}).
		Named("tenant").
		Complete(r)
}

func tenantChangePredicate() predicate.Predicate {
	identityLabelChanged := predicate.Funcs{
		UpdateFunc: func(e event.UpdateEvent) bool {
			key := agentzv1alpha1.TenantOrganizationIDLabel
			return e.ObjectOld.GetLabels()[key] != e.ObjectNew.GetLabels()[key]
		},
	}
	return predicate.Or(predicate.GenerationChangedPredicate{}, identityLabelChanged)
}

func (r *Reconciler) reconcileNamespace(ctx context.Context, tenant *agentzv1alpha1.Tenant, nsName string) error {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: nsName}}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), ns, func() error {
		if ns.UID != "" {
			if ns.Labels[agentzv1alpha1.TenantManagedByLabel] != agentzv1alpha1.TenantManagedByValue ||
				ns.Labels[agentzv1alpha1.TenantNameLabel] != tenant.Name ||
				ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel] != tenant.Name ||
				ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation] != tenant.Spec.OrganizationID {
				return errTenantIdentityConflict
			}
			for _, owner := range ns.OwnerReferences {
				if owner.Controller != nil && *owner.Controller && owner.UID != tenant.UID {
					return errTenantIdentityConflict
				}
			}
		}
		if ns.Labels == nil {
			ns.Labels = map[string]string{}
		}
		ns.Labels[agentzv1alpha1.TenantManagedByLabel] = agentzv1alpha1.TenantManagedByValue
		ns.Labels[agentzv1alpha1.TenantNameLabel] = tenant.Name
		ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel] = tenant.Name

		if ns.Annotations == nil {
			ns.Annotations = map[string]string{}
		}
		ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation] = tenant.Spec.OrganizationID
		ns.Annotations[agentzv1alpha1.KubeArmorVisibilityAnnotation] = "process"
		err := controllerutil.SetControllerReference(tenant, ns, r.Scheme)
		if err != nil {
			return fmt.Errorf("%w: controller owner", errTenantIdentityConflict)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile namespace: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileNixStorePVC(ctx context.Context, tenant *agentzv1alpha1.Tenant, nsName string) error {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name:      r.NixStorePVCName,
		Namespace: nsName,
	}}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), pvc, func() error {
		pvc.Labels = map[string]string{
			agentzv1alpha1.TenantManagedByLabel: agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.TenantNameLabel:      tenant.Name,
		}
		pvc.Spec.AccessModes = append(
			[]corev1.PersistentVolumeAccessMode{},
			r.NixStorePVCAccessModes...,
		)
		pvc.Spec.Resources.Requests = corev1.ResourceList{
			corev1.ResourceStorage: r.NixStorePVCSize,
		}
		if r.NixStorePVCStorageClass != "" {
			pvc.Spec.StorageClassName = &r.NixStorePVCStorageClass
		}
		return controllerutil.SetControllerReference(tenant, pvc, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile nix store pvc: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileIsolationPolicy(ctx context.Context, tenant *agentzv1alpha1.Tenant, nsName string) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      agentzv1alpha1.TenantIsolationPolicyName,
			Namespace: nsName,
		},
	}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), policy, func() error {
		if policy.Labels == nil {
			policy.Labels = map[string]string{}
		}
		policy.Labels[agentzv1alpha1.TenantManagedByLabel] = agentzv1alpha1.TenantManagedByValue
		policy.Labels[agentzv1alpha1.TenantNameLabel] = tenant.Name
		selector := ciliumpolicyapi.NewESFromK8sLabelSelector(
			ciliumlabels.LabelSourceK8sKeyPrefix,
			&slimv1.LabelSelector{
				MatchExpressions: []slimv1.LabelSelectorRequirement{
					{
						Key:      agentzv1alpha1.AgentPackageJobLabel,
						Operator: slimv1.LabelSelectorOpDoesNotExist,
					},
					{
						Key:      workflowScheduleRunnerLabelKey,
						Operator: slimv1.LabelSelectorOpDoesNotExist,
					},
				},
			},
		)
		peerSelector := ciliumpolicyapi.NewESFromK8sLabelSelector(
			ciliumlabels.LabelSourceK8sKeyPrefix,
			&slimv1.LabelSelector{
				MatchExpressions: []slimv1.LabelSelectorRequirement{
					{
						Key:      agentzv1alpha1.AgentPackageJobLabel,
						Operator: slimv1.LabelSelectorOpDoesNotExist,
					},
					{
						Key:      workflowScheduleRunnerLabelKey,
						Operator: slimv1.LabelSelectorOpDoesNotExist,
					},
					{
						Key:      agentLabelKey,
						Operator: slimv1.LabelSelectorOpDoesNotExist,
					},
				},
			},
		)

		policy.Spec = &ciliumpolicyapi.Rule{
			Description:      "Restrict tenant traffic and isolate agents from each other.",
			EndpointSelector: selector,
			Ingress: []ciliumpolicyapi.IngressRule{
				{
					IngressCommonRule: ciliumpolicyapi.IngressCommonRule{
						FromEndpoints: []ciliumpolicyapi.EndpointSelector{
							peerSelector,
						},
					},
				},
				{
					IngressCommonRule: ciliumpolicyapi.IngressCommonRule{
						FromEndpoints: []ciliumpolicyapi.EndpointSelector{
							ciliumpolicyapi.NewESFromLabels(
								ciliumlabels.NewLabel(
									"io.kubernetes.pod.namespace",
									"agentz-system",
									ciliumlabels.LabelSourceK8s,
								),
							),
						},
					},
				},
			},
			Egress: []ciliumpolicyapi.EgressRule{
				{
					EgressCommonRule: ciliumpolicyapi.EgressCommonRule{
						ToEndpoints: []ciliumpolicyapi.EndpointSelector{
							peerSelector,
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
		return controllerutil.SetControllerReference(tenant, policy, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile cilium network policy: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileGatewayAccess(ctx context.Context, tenant *agentzv1alpha1.Tenant) error {
	if r.ManagerServiceAccountName == "" {
		return fmt.Errorf("manager service account name is required")
	}
	if r.ManagerServiceAccountNamespace == "" {
		return fmt.Errorf("manager service account namespace is required")
	}

	roleName := tenant.Name + "-gateway-use"
	role := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: roleName},
	}
	_, err := controllerutil.CreateOrPatch(ctx, r.directClient(), role, func() error {
		role.Labels = map[string]string{
			agentzv1alpha1.TenantManagedByLabel: agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.TenantNameLabel:      tenant.Name,
		}
		if err := controllerutil.SetControllerReference(tenant, role, r.Scheme); err != nil {
			return fmt.Errorf("retain tenant gateway role owner: %w", err)
		}
		role.Rules = []rbacv1.PolicyRule{{
			APIGroups:     []string{agentzv1alpha1.SchemeGroupVersion.Group},
			Resources:     []string{"tenants"},
			ResourceNames: []string{tenant.Name},
			Verbs:         []string{"use"},
		}}
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile tenant gateway cluster role: %w", err)
	}

	binding := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleName},
	}
	_, err = controllerutil.CreateOrPatch(ctx, r.directClient(), binding, func() error {
		binding.Labels = map[string]string{
			agentzv1alpha1.TenantManagedByLabel: agentzv1alpha1.TenantManagedByValue,
			agentzv1alpha1.TenantNameLabel:      tenant.Name,
		}
		if err := controllerutil.SetControllerReference(tenant, binding, r.Scheme); err != nil {
			return fmt.Errorf("retain tenant gateway binding owner: %w", err)
		}
		binding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "ClusterRole",
			Name:     roleName,
		}
		binding.Subjects = []rbacv1.Subject{{
			Kind:      rbacv1.ServiceAccountKind,
			Name:      r.ManagerServiceAccountName,
			Namespace: r.ManagerServiceAccountNamespace,
		}}
		return nil
	})
	if err != nil {
		return fmt.Errorf(
			"reconcile tenant gateway cluster role binding: %w",
			err,
		)
	}
	return nil
}

func (r *Reconciler) directClient() client.Client {
	if r.Direct != nil {
		return r.Direct
	}
	return r.Client
}

func (r *Reconciler) failTenant(ctx context.Context, tenant *agentzv1alpha1.Tenant, message string, cause error) (ctrl.Result, error) {
	err := r.updateStatus(ctx, tenant.Name, func(current *agentzv1alpha1.Tenant) {
		current.Status.Namespace = current.Name
		current.Status.ObservedGeneration = current.Generation
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonBootstrapFailed,
			Message:            message,
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             agentzv1alpha1.TenantReasonBootstrapFailed,
			Message:            message,
			ObservedGeneration: current.Generation,
		})
		current.Status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.TenantConditionDegraded,
			Status:             metav1.ConditionTrue,
			Reason:             agentzv1alpha1.TenantReasonBootstrapFailed,
			Message:            message,
			ObservedGeneration: current.Generation,
		})
	})
	if err != nil && !apierrors.IsConflict(err) {
		return ctrl.Result{}, fmt.Errorf("update failed tenant status: %w", err)
	}
	return ctrl.Result{}, cause
}

func (r *Reconciler) updateStatus(ctx context.Context, name string, mutate func(*agentzv1alpha1.Tenant)) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var tenant agentzv1alpha1.Tenant
		if err := r.Get(ctx, client.ObjectKey{Name: name}, &tenant); err != nil {
			return err
		}
		mutate(&tenant)
		return r.Status().Update(ctx, &tenant)
	})
}
