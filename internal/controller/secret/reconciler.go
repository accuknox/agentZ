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

package secret

import (
	"context"
	"errors"
	"fmt"
	"strings"

	baoapi "github.com/openbao/openbao/api/v2"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/agentz/internal/openbao"
	secretstore "github.com/accuknox/agentz/internal/secret"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const secretFinalizer = "agentz.accuknox.com/secret"

// SecretReconciler reconciles Secret lifecycle and runtime status.
type SecretReconciler struct {
	client.Client
	Scheme                  *runtime.Scheme
	OpenBaoAddr             string
	ManagerOpenBaoAddr      string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=secrets,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=secrets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=secrets/finalizers,verbs=update

// Reconcile moves Secret runtime state toward the declared spec.
func (r *SecretReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	secret := &agentzv1alpha1.Secret{}
	if err := r.Get(ctx, req.NamespacedName, secret); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if secret.DeletionTimestamp.IsZero() {
		if !ctrlutil.ContainsFinalizer(secret, secretFinalizer) {
			patch := client.MergeFrom(secret.DeepCopy())
			ctrlutil.AddFinalizer(secret, secretFinalizer)
			if err := r.Patch(ctx, secret, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
			}
		}
		return ctrl.Result{}, r.reconcileActive(ctx, secret)
	}

	if err := r.deleteRuntime(ctx, secret); err != nil {
		return ctrl.Result{}, err
	}
	if ctrlutil.ContainsFinalizer(secret, secretFinalizer) {
		patch := client.MergeFrom(secret.DeepCopy())
		ctrlutil.RemoveFinalizer(secret, secretFinalizer)
		if err := r.Patch(ctx, secret, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
		}
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *SecretReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.Secret{}).
		Named("secret").
		Complete(r)
}

func (r *SecretReconciler) reconcileActive(ctx context.Context, secret *agentzv1alpha1.Secret) error {
	path := secretstore.SecretPath(secret.Namespace, secret.Spec.AgentRef.Name, secret.Spec.Key)
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.Secret{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(secret), current); err != nil {
			return err
		}
		observed := current.Status.ObservedGeneration == current.Generation
		hasRuntime := current.Status.State != "" && current.Status.RuntimeRef != nil
		if observed && hasRuntime && current.Status.RuntimeRef.Path == path {
			return nil
		}

		status := current.Status
		status.ObservedGeneration = current.Generation
		status.State = agentzv1alpha1.SecretStateAccepted
		status.RuntimeRef = &agentzv1alpha1.SecretRuntimeRef{Path: path}
		now := metav1.Now()
		status.LastRuntimeUpdateTime = &now
		status.TokenExpiryTime = nil
		status.LastRefreshFailureReason = ""
		status.LastRefreshFailureMessage = ""
		status.LastRefreshFailureTime = nil
		secretstore.SetCondition(&status, metav1.Condition{
			Type:               agentzv1alpha1.SecretConditionAccepted,
			Status:             metav1.ConditionTrue,
			Reason:             agentzv1alpha1.SecretReasonAccepted,
			Message:            "Secret runtime is pending",
			ObservedGeneration: current.Generation,
		})

		oldStatus := current.Status
		oldStatus.LastRuntimeUpdateTime = nil
		newStatus := status
		newStatus.LastRuntimeUpdateTime = nil
		if apiequality.Semantic.DeepEqual(oldStatus, newStatus) {
			return nil
		}

		current.Status = status
		return r.Status().Update(ctx, current)
	})
}

func (r *SecretReconciler) deleteRuntime(ctx context.Context, secret *agentzv1alpha1.Secret) error {
	kv, err := r.openBaoMetadata(ctx)
	if err != nil {
		return fmt.Errorf("create openbao client for secret cleanup: %w", err)
	}

	path := secretstore.SecretPath(secret.Namespace, secret.Spec.AgentRef.Name, secret.Spec.Key)
	if err := kv.DeleteMetadata(ctx, path); err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
		return fmt.Errorf("delete secret runtime metadata %q: %w", path, err)
	}
	return nil
}

func (r *SecretReconciler) openBaoMetadata(ctx context.Context) (*baoapi.KVv2, error) {
	addr := strings.TrimSpace(r.ManagerOpenBaoAddr)
	if addr == "" {
		addr = strings.TrimSpace(r.OpenBaoAddr)
	}
	if addr == "" {
		return nil, fmt.Errorf("openbao addr is required")
	}
	if strings.TrimSpace(r.OpenBaoSecretMountPath) == "" {
		return nil, fmt.Errorf("openbao secret mount path is required")
	}
	if strings.TrimSpace(r.OpenBaoK8sAuthRole) == "" {
		return nil, fmt.Errorf("openbao k8s auth role is required")
	}

	client, err := openbao.NewClient(
		ctx,
		addr,
		r.OpenBaoK8sAuthRole,
		r.OpenBaoK8sAuthMountPath,
		r.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return nil, err
	}
	return client.KVv2(r.OpenBaoSecretMountPath), nil
}
