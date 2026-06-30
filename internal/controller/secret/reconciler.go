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
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/clawarmor/internal/oauth"
	"github.com/accuknox/clawarmor/internal/openbao"
	secretstore "github.com/accuknox/clawarmor/internal/secret"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const secretFinalizer = "clawarmor.accuknox.com/secret"

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
	HTTPClient              *http.Client
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=secrets,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=secrets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=secrets/finalizers,verbs=update

// Reconcile moves Secret runtime state toward the declared spec.
func (r *SecretReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	secret := &clawarmorv1alpha1.Secret{}
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
		For(&clawarmorv1alpha1.Secret{}).
		Named("secret").
		Complete(r)
}

func (r *SecretReconciler) reconcileActive(ctx context.Context, secret *clawarmorv1alpha1.Secret) error {
	path := secretstore.SecretPath(secret.Spec.AgentRef.Name, secret.Spec.Key)
	state := clawarmorv1alpha1.SecretStateReady
	var tokenExpiry *time.Time
	condition := metav1.Condition{
		Type:               clawarmorv1alpha1.SecretConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             clawarmorv1alpha1.SecretReasonReady,
		Message:            "Secret runtime is ready",
		ObservedGeneration: secret.Generation,
	}

	kv, err := r.openBaoKV(ctx)
	if err != nil {
		state = clawarmorv1alpha1.SecretStateDegraded
		condition = metav1.Condition{
			Type:               clawarmorv1alpha1.SecretConditionDegraded,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
			Message:            err.Error(),
			ObservedGeneration: secret.Generation,
		}
		return r.updateStatus(ctx, secret, state, path, nil, condition)
	}

	raw, err := readRuntimeRecord(ctx, kv, path)
	if err != nil {
		state = clawarmorv1alpha1.SecretStateAccepted
		condition = metav1.Condition{
			Type:               clawarmorv1alpha1.SecretConditionAccepted,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.SecretReasonAccepted,
			Message:            "Secret runtime is pending",
			ObservedGeneration: secret.Generation,
		}
		if !errors.Is(err, baoapi.ErrSecretNotFound) {
			state = clawarmorv1alpha1.SecretStateDegraded
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionDegraded,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
				Message:            fmt.Sprintf("read openbao runtime: %v", err),
				ObservedGeneration: secret.Generation,
			}
		}
		return r.updateStatus(ctx, secret, state, path, nil, condition)
	}

	switch secret.Spec.Type {
	case clawarmorv1alpha1.SecretTypeStatic:
		record, err := secretstore.DecodeRecord[secretstore.StaticRecord](raw)
		if err != nil {
			state = clawarmorv1alpha1.SecretStateDegraded
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionDegraded,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
				Message:            err.Error(),
				ObservedGeneration: secret.Generation,
			}
			return r.updateStatus(ctx, secret, state, path, nil, condition)
		}
		if record.Type != clawarmorv1alpha1.SecretTypeStatic {
			state = clawarmorv1alpha1.SecretStateDegraded
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionDegraded,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
				Message:            fmt.Sprintf("runtime record type %q does not match secret type %q", record.Type, secret.Spec.Type),
				ObservedGeneration: secret.Generation,
			}
			return r.updateStatus(ctx, secret, state, path, nil, condition)
		}
	case clawarmorv1alpha1.SecretTypeOAuth:
		record, err := secretstore.DecodeRecord[secretstore.OAuthRecord](raw)
		if err != nil {
			state = clawarmorv1alpha1.SecretStateDegraded
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionDegraded,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
				Message:            err.Error(),
				ObservedGeneration: secret.Generation,
			}
			return r.updateStatus(ctx, secret, state, path, nil, condition)
		}
		if record.Token == nil || strings.TrimSpace(record.Token.AccessToken) == "" {
			state = clawarmorv1alpha1.SecretStateAccepted
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionAccepted,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonAccepted,
				Message:            "Secret runtime is pending",
				ObservedGeneration: secret.Generation,
			}
		}
		if record.Token != nil && !record.Token.Expiry.IsZero() {
			value := record.Token.Expiry.UTC()
			tokenExpiry = &value
		}
		if record.Type != clawarmorv1alpha1.SecretTypeOAuth {
			state = clawarmorv1alpha1.SecretStateDegraded
			condition = metav1.Condition{
				Type:               clawarmorv1alpha1.SecretConditionDegraded,
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
				Message:            fmt.Sprintf("runtime record type %q does not match secret type %q", record.Type, secret.Spec.Type),
				ObservedGeneration: secret.Generation,
			}
			return r.updateStatus(ctx, secret, state, path, tokenExpiry, condition)
		}
	default:
		state = clawarmorv1alpha1.SecretStateDegraded
		condition = metav1.Condition{
			Type:               clawarmorv1alpha1.SecretConditionDegraded,
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.SecretReasonReconcileFailed,
			Message:            fmt.Sprintf("unsupported secret type %q", secret.Spec.Type),
			ObservedGeneration: secret.Generation,
		}
	}

	return r.updateStatus(ctx, secret, state, path, tokenExpiry, condition)
}

func (r *SecretReconciler) deleteRuntime(ctx context.Context, secret *clawarmorv1alpha1.Secret) error {
	kv, err := r.openBaoKV(ctx)
	if err != nil {
		return fmt.Errorf("create openbao client for secret cleanup: %w", err)
	}

	if secret.Spec.Type == clawarmorv1alpha1.SecretTypeOAuth {
		if err := r.revokeOAuthRuntime(ctx, kv, secret); err != nil {
			slog.WarnContext(
				ctx, "best-effort oauth revoke failed",
				slog.String("namespace", secret.Namespace),
				slog.String("name", secret.Name),
				slog.Any("err", err),
			)
		}
	}

	path := secretstore.SecretPath(secret.Spec.AgentRef.Name, secret.Spec.Key)
	if err := kv.DeleteMetadata(ctx, path); err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
		return fmt.Errorf("delete secret runtime metadata %q: %w", path, err)
	}
	return nil
}

func (r *SecretReconciler) revokeOAuthRuntime(ctx context.Context, kv *baoapi.KVv2, secret *clawarmorv1alpha1.Secret) error {
	path := secretstore.SecretPath(secret.Spec.AgentRef.Name, secret.Spec.Key)
	raw, err := readRuntimeRecord(ctx, kv, path)
	if err != nil {
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			return nil
		}
		return err
	}

	record, err := secretstore.DecodeRecord[secretstore.OAuthRecord](raw)
	if err != nil {
		return err
	}

	endpoint, _ := record.Revocation["endpoint"].(string)
	if strings.TrimSpace(endpoint) == "" || record.Token == nil ||
		strings.TrimSpace(record.Token.AccessToken) == "" {
		return nil
	}
	endpoint, err = oauth.PublicHTTPSURL(ctx, endpoint)
	if err != nil {
		return fmt.Errorf("validate oauth revoke endpoint: %w", err)
	}

	form := url.Values{}
	form.Set("token", record.Token.AccessToken)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return fmt.Errorf("build oauth revoke request: %w", err)
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")

	method, _ := record.Revocation["token_endpoint_auth_method"].(string)
	switch strings.TrimSpace(method) {
	case "", "client_secret_basic":
		req.SetBasicAuth(record.ClientID, record.ClientSecret)
	case "client_secret_post":
		form.Set("client_id", record.ClientID)
		form.Set("client_secret", record.ClientSecret)
		body := form.Encode()
		req.Body = io.NopCloser(strings.NewReader(body))
		req.ContentLength = int64(len(body))
	case "none":
		form.Set("client_id", record.ClientID)
		body := form.Encode()
		req.Body = io.NopCloser(strings.NewReader(body))
		req.ContentLength = int64(len(body))
	default:
		return fmt.Errorf(
			"oauth revocation auth method %q is not supported",
			method,
		)
	}

	httpClient := r.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("send oauth revoke request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("oauth revoke failed: %s", strings.TrimSpace(string(body)))
	}
	return nil
}

func (r *SecretReconciler) updateStatus(ctx context.Context, secret *clawarmorv1alpha1.Secret, state clawarmorv1alpha1.SecretState, path string, tokenExpiry *time.Time, cond metav1.Condition) error {
	current := &clawarmorv1alpha1.Secret{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(secret), current); err != nil {
		return err
	}

	status := current.Status
	status.ObservedGeneration = current.Generation
	status.State = state
	status.RuntimeRef = &clawarmorv1alpha1.SecretRuntimeRef{Path: path}
	now := metav1.Now()
	status.LastRuntimeUpdateTime = &now
	status.TokenExpiryTime = nil
	if tokenExpiry != nil {
		value := metav1.NewTime(tokenExpiry.UTC())
		status.TokenExpiryTime = &value
	}
	secretstore.SetCondition(&status, cond)

	status.LastRefreshFailureReason = ""
	status.LastRefreshFailureMessage = ""
	status.LastRefreshFailureTime = nil
	if cond.Type == clawarmorv1alpha1.SecretConditionDegraded {
		status.LastRefreshFailureReason = cond.Reason
		status.LastRefreshFailureMessage = cond.Message
		status.LastRefreshFailureTime = &now
	}

	if apiequalSecretStatus(current.Status, status) {
		return nil
	}

	current.Status = status
	return r.Status().Update(ctx, current)
}

func (r *SecretReconciler) openBaoKV(ctx context.Context) (*baoapi.KVv2, error) {
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

func readRuntimeRecord(ctx context.Context, kv *baoapi.KVv2, path string) (map[string]any, error) {
	secret, err := kv.Get(ctx, path)
	if err != nil {
		return nil, err
	}
	if secret == nil || secret.Data == nil {
		return nil, baoapi.ErrSecretNotFound
	}
	return secret.Data, nil
}

func apiequalSecretStatus(a, b clawarmorv1alpha1.SecretStatus) bool {
	a.LastRuntimeUpdateTime = nil
	b.LastRuntimeUpdateTime = nil
	return apiequality.Semantic.DeepEqual(a, b)
}
