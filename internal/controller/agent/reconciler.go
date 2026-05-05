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
	"errors"
	"fmt"
	"strings"
	"time"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

// Reconciler reconciles an Agent object.
type Reconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config RuntimeConfig
	Bao    OpenBaoProvisioner
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments/status,verbs=get
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch;delete

// Reconcile moves the cluster state toward the desired Agent state.
//
//nolint:gocyclo
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	agt := &clawarmorv1alpha1.Agent{}
	err := r.Get(ctx, req.NamespacedName, agt)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !agt.DeletionTimestamp.IsZero() {
		if ctrlutil.ContainsFinalizer(agt, sinjectorFinalizer) {
			if err := r.cleanupSinjector(ctx, agt); err != nil {
				return ctrl.Result{}, fmt.Errorf("cleanup sinjector: %w", err)
			}
			patch := client.MergeFrom(agt.DeepCopy())
			ctrlutil.RemoveFinalizer(agt, sinjectorFinalizer)
			if err := r.Patch(ctx, agt, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove sinjector finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}

	if agt.Spec.Image == "" && r.Config.DefaultImage == "" {
		err = errImageEmpty
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("invalid agent config: %w", err)
	}

	_, err = serverPort(agt.Spec.Server.Address)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("invalid agent config: %w", err)
	}

	cfgYAML, err := renderConfig(agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("render config: %w", err)
	}

	err = r.reconcileConfigMap(ctx, agt, string(cfgYAML))
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile configmap: %w", err)
	}

	err = r.reconcileService(ctx, agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile service: %w", err)
	}

	if r.sinjectorEnabled() {
		if !ctrlutil.ContainsFinalizer(agt, sinjectorFinalizer) {
			patch := client.MergeFrom(agt.DeepCopy())
			ctrlutil.AddFinalizer(agt, sinjectorFinalizer)
			if err := r.Patch(ctx, agt, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("add sinjector finalizer: %w", err)
			}
		}
		err = r.reconcileSinjector(ctx, agt)
		if err != nil {
			updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
			if updateErr != nil {
				return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
			}
			return ctrl.Result{}, fmt.Errorf("reconcile sinjector: %w", err)
		}
		ready, err := r.sinjectorReady(ctx, agt)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("check sinjector readiness: %w", err)
		}
		if !ready {
			return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
		}
	} else if ctrlutil.ContainsFinalizer(agt, sinjectorFinalizer) {
		if err := r.deleteSinjectorResources(ctx, agt); err != nil {
			updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
			if updateErr != nil {
				return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
			}
			return ctrl.Result{}, fmt.Errorf("delete sinjector resources: %w", err)
		}
		if err := r.cleanupSinjector(ctx, agt); err != nil {
			return ctrl.Result{}, fmt.Errorf("cleanup sinjector: %w", err)
		}
		patch := client.MergeFrom(agt.DeepCopy())
		ctrlutil.RemoveFinalizer(agt, sinjectorFinalizer)
		if err := r.Patch(ctx, agt, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("remove sinjector finalizer: %w", err)
		}
	}

	hash, err := configHash(cfgYAML, agt.Spec.Env)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("hash config: %w", err)
	}
	err = r.reconcileDeployment(ctx, agt, hash)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile deployment: %w", err)
	}

	err = r.updateAgentStatus(ctx, req.NamespacedName)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("update agent status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Agent{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&ciliumv2.CiliumNetworkPolicy{}).
		Named("agent").
		Complete(r)
}

func (r *Reconciler) sinjectorEnabled() bool {
	return r.Config.SinjectorImage != "" || r.Config.ProxyAddress != ""
}

func (r *Reconciler) proxyAddress(agt *clawarmorv1alpha1.Agent) string {
	if r.Config.ProxyAddress != "" {
		return strings.ReplaceAll(r.Config.ProxyAddress, "{AGENT_NAME}", agt.Name)
	}
	port, err := sinjectorPort(r.Config)
	if err != nil {
		port = 8080
	}
	return fmt.Sprintf(
		"http://%s.%s.svc.cluster.local:%d",
		sinjectorName(agt),
		agt.Namespace,
		port,
	)
}

func (r *Reconciler) updateAgentStatus(ctx context.Context, key types.NamespacedName) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt := &clawarmorv1alpha1.Agent{}
		err := r.Get(ctx, key, agt)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		svc := &corev1.Service{}
		svcErr := r.Get(ctx, key, svc)
		if svcErr != nil && !apierr.IsNotFound(svcErr) {
			return fmt.Errorf("get service: %w", svcErr)
		}

		cm := &corev1.ConfigMap{}
		cmErr := r.Get(ctx, key, cm)
		if cmErr != nil && !apierr.IsNotFound(cmErr) {
			return fmt.Errorf("get configmap: %w", cmErr)
		}

		dep := &appsv1.Deployment{}
		depErr := r.Get(ctx, key, dep)
		if depErr != nil && !apierr.IsNotFound(depErr) {
			return fmt.Errorf("get deployment: %w", depErr)
		}

		port, portErr := serverPort(agt.Spec.Server.Address)
		if portErr != nil {
			port = 0
		}

		agt.Status.ServiceName = ""
		agt.Status.URL = ""
		if svcErr == nil {
			agt.Status.ServiceName = svc.Name
			agt.Status.URL = fmt.Sprintf(
				"http://%s.%s.svc.cluster.local:%d",
				svc.Name,
				svc.Namespace,
				port,
			)
		}
		agt.Status.ConfigMapName = ""
		if cmErr == nil {
			agt.Status.ConfigMapName = cm.Name
		}
		agt.Status.ObservedSessionID = agt.Spec.Session.ID
		agt.Status.ObservedGeneration = agt.Generation

		if dep.Name == "" {
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Waiting for deployment to be created",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
				Message:            "Deployment has not been created yet",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Agent is being created",
				ObservedGeneration: agt.Generation,
			})
			return r.Status().Update(ctx, agt)
		}

		if dep.Status.ReadyReplicas > 0 {
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is healthy",
				ObservedGeneration: agt.Generation,
			})
			return r.Status().Update(ctx, agt)
		}

		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
			Message:            "Waiting for agent pods to become ready",
			ObservedGeneration: agt.Generation,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Waiting for deployment rollout",
			ObservedGeneration: agt.Generation,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Agent deployment is progressing",
			ObservedGeneration: agt.Generation,
		})
		return r.Status().Update(ctx, agt)
	})
}

func (r *Reconciler) setDegradedStatus(ctx context.Context, key types.NamespacedName, gen int64, recErr error) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt := &clawarmorv1alpha1.Agent{}
		err := r.Get(ctx, key, agt)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		agt.Status.ObservedSessionID = agt.Spec.Session.ID
		agt.Status.ObservedGeneration = gen
		reason := clawarmorv1alpha1.ReasonReconcileFailed
		if errors.Is(recErr, errImageEmpty) || errors.Is(recErr, errPortInvalid) {
			reason = clawarmorv1alpha1.ReasonConfigInvalid
		}
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionTrue,
			Reason:             reason,
			Message:            recErr.Error(),
			ObservedGeneration: gen,
		})
		return r.Status().Update(ctx, agt)
	})
}
