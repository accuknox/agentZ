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

package environment

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/accuknox/clawarmor/internal/envutil"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const finalizer = "clawarmor.accuknox.com/environment-protection"

// Reconciler reconciles Environment lifecycle protection.
type Reconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=envs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=envs/finalizers,verbs=update
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents,verbs=get;list;watch

// Reconcile prevents deletion of environments while an Agent references them.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	env := &clawarmorv1alpha1.Environment{}
	if err := r.Get(ctx, req.NamespacedName, env); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	agentName, err := envutil.ReferencingAgentName(
		ctx,
		r.Client,
		env.Namespace,
		env.Name,
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("find referencing agent: %w", err)
	}

	if !env.DeletionTimestamp.IsZero() {
		if agentName != "" {
			return ctrl.Result{}, fmt.Errorf(
				"environment %q is referenced by agent %q",
				env.Name,
				agentName,
			)
		}
		if ctrlutil.ContainsFinalizer(env, finalizer) {
			patch := client.MergeFrom(env.DeepCopy())
			ctrlutil.RemoveFinalizer(env, finalizer)
			if err := r.Patch(ctx, env, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}

	if !ctrlutil.ContainsFinalizer(env, finalizer) {
		patch := client.MergeFrom(env.DeepCopy())
		ctrlutil.AddFinalizer(env, finalizer)
		if err := r.Patch(ctx, env, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the Environment controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Environment{}).
		Watches(&clawarmorv1alpha1.Agent{}, handler.EnqueueRequestsFromMapFunc(r.environmentForAgent)).
		Named("environment").
		Complete(r)
}

func (r *Reconciler) environmentForAgent(_ context.Context, obj client.Object) []reconcile.Request {
	agt, ok := obj.(*clawarmorv1alpha1.Agent)
	if !ok {
		return []reconcile.Request{}
	}
	ref := agt.Spec.EnvironmentRef
	if ref == nil || ref.Name == "" {
		return []reconcile.Request{}
	}
	return []reconcile.Request{{
		NamespacedName: types.NamespacedName{
			Name:      ref.Name,
			Namespace: agt.Namespace,
		},
	}}
}
