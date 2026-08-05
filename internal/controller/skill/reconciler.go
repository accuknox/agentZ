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
	"slices"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
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
	StoreConfig skillpkg.Config
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=skills,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=skills/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=agents,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes,verbs=get;list;watch;update;patch

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
		if err := r.detachReferences(ctx, skill); err != nil {
			return ctrl.Result{}, fmt.Errorf("detach skill references: %w", err)
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

func (r *Reconciler) detachReferences(ctx context.Context, skill *agentzv1alpha1.Skill) error {
	ref := agentzv1alpha1.ResourceReference{
		Scope: agentzv1alpha1.ResourceScopeOrganisation,
		Name:  skill.Name,
	}
	agents := &agentzv1alpha1.AgentList{}
	if err := r.List(ctx, agents, client.InNamespace(skill.Namespace)); err != nil {
		return fmt.Errorf("list agents: %w", err)
	}
	for _, item := range agents.Items {
		if !slices.Contains(item.Spec.Skills, ref) {
			continue
		}
		key := types.NamespacedName{Name: item.Name, Namespace: item.Namespace}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			agt := &agentzv1alpha1.Agent{}
			if err := r.Get(ctx, key, agt); err != nil {
				return client.IgnoreNotFound(err)
			}
			next := slices.DeleteFunc(append([]agentzv1alpha1.ResourceReference{}, agt.Spec.Skills...), func(item agentzv1alpha1.ResourceReference) bool {
				return item == ref
			})
			if len(next) == len(agt.Spec.Skills) {
				return nil
			}
			agt.Spec.Skills = next
			return r.Update(ctx, agt)
		})
		if err != nil {
			return fmt.Errorf("detach skill from agent %q: %w", item.Name, err)
		}
	}

	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := r.List(ctx, sandboxes, client.InNamespace(skill.Namespace)); err != nil {
		return fmt.Errorf("list sandboxes: %w", err)
	}
	for _, item := range sandboxes.Items {
		if !slices.Contains(item.Spec.Skills, ref) {
			continue
		}
		key := types.NamespacedName{Name: item.Name, Namespace: item.Namespace}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			sandbox := &agentzv1alpha1.Sandbox{}
			if err := r.Get(ctx, key, sandbox); err != nil {
				if errors.IsNotFound(err) {
					return nil
				}
				return err
			}
			next := slices.DeleteFunc(append([]agentzv1alpha1.ResourceReference{}, sandbox.Spec.Skills...), func(item agentzv1alpha1.ResourceReference) bool {
				return item == ref
			})
			if len(next) == len(sandbox.Spec.Skills) {
				return nil
			}
			sandbox.Spec.Skills = next
			return r.Update(ctx, sandbox)
		})
		if err != nil {
			return fmt.Errorf("detach skill from sandbox %q: %w", item.Name, err)
		}
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.Skill{}).
		Named("skill").
		Complete(r)
}
