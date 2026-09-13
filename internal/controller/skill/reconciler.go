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

package skill

import (
	"context"
	"fmt"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	skillpkg "github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const skillFinalizer = "agentz.accuknox.com/immutable-skill"

// Reconciler reconciles immutable Skill objects.
type Reconciler struct {
	client.Client
	// Reader bypasses the cache before removing stored versions.
	Reader      client.Reader
	StoreConfig skillpkg.Config
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=skills,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=skills/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=agents;sandboxes;workspaces,verbs=get;list;watch

// Reconcile keeps immutable Skill deletion and references consistent.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	skill := &agentzv1alpha1.Skill{}
	err := r.Get(ctx, req.NamespacedName, skill)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !skill.DeletionTimestamp.IsZero() {
		if !ctrlutil.ContainsFinalizer(skill, skillFinalizer) {
			return ctrl.Result{}, nil
		}
		consumers, err := skillpkg.ReferencingConsumers(ctx, r.Reader, client.ObjectKeyFromObject(skill))
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("check skill references: %w", err)
		}
		if len(consumers) > 0 {
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
		store, err := skillpkg.New(ctx, r.StoreConfig)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("create immutable skill store client: %w", err)
		}
		if err := store.DeleteImmutableSkill(ctx, skill.Namespace, skill.Name); err != nil {
			return ctrl.Result{}, fmt.Errorf("delete immutable skill objects: %w", err)
		}

		patch := client.MergeFrom(skill.DeepCopy())
		ctrlutil.RemoveFinalizer(skill, skillFinalizer)
		if err := r.Patch(ctx, skill, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("remove skill finalizer: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if ctrlutil.ContainsFinalizer(skill, skillFinalizer) {
		return ctrl.Result{}, nil
	}
	patch := client.MergeFrom(skill.DeepCopy())
	ctrlutil.AddFinalizer(skill, skillFinalizer)
	if err := r.Patch(ctx, skill, patch); err != nil {
		return ctrl.Result{}, fmt.Errorf("add skill finalizer: %w", err)
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.Skill{}).
		Named("skill").
		Complete(r)
}
