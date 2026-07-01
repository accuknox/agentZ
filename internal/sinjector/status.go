package sinjector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/oauth"
	secretstore "github.com/accuknox/agentz/internal/secret"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type secretRuntimeStatus struct {
	state       agentzv1alpha1.SecretState
	condition   string
	reason      string
	message     string
	tokenExpiry *time.Time
	refreshTime *time.Time
}

func (r *resolver) runSecretProbes(ctx context.Context) {
	if err := r.probeSecrets(ctx); err != nil {
		slog.ErrorContext(ctx, "initial secret probe cycle failed", slog.Any("error", err))
	}

	ticker := time.NewTicker(r.probeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.probeSecrets(ctx); err != nil {
				slog.ErrorContext(ctx, "secret probe cycle failed", slog.Any("error", err))
			}
		}
	}
}

func (r *resolver) runProbeQueue(ctx context.Context) {
	for {
		name, shutdown := r.probeQueue.Get()
		if shutdown {
			return
		}

		_, err, _ := r.sf.Do("probe:"+name, func() (any, error) {
			secret, err := r.secrets.Get(name)
			if err != nil {
				return nil, ctrlclient.IgnoreNotFound(err)
			}
			if !secret.DeletionTimestamp.IsZero() {
				return nil, nil
			}
			return nil, r.probeSecret(ctx, secret)
		})
		r.probeQueue.Done(name)
		if err == nil {
			continue
		}
		slog.ErrorContext(
			ctx,
			"secret immediate probe failed",
			slog.String("secret", name),
			slog.Any("error", err),
		)
	}
}

func (r *resolver) probeSecrets(ctx context.Context) error {
	items, err := r.secrets.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list secrets: %w", err)
	}

	for _, secret := range items {
		if secret.Spec.AgentRef.Name != r.agentName || !secret.DeletionTimestamp.IsZero() {
			continue
		}
		lastProbeTime := time.Time{}
		if secret.Status.LastRuntimeUpdateTime != nil {
			lastProbeTime = secret.Status.LastRuntimeUpdateTime.Time
		}
		r.probeTimesMu.Lock()
		if probeTime, ok := r.probeTimes[secret.Name]; ok && probeTime.After(lastProbeTime) {
			lastProbeTime = probeTime
		}
		r.probeTimesMu.Unlock()
		if !lastProbeTime.IsZero() && time.Since(lastProbeTime) < r.probeInterval {
			continue
		}
		if err := r.probeSecret(ctx, secret); err != nil {
			slog.ErrorContext(
				ctx,
				"write secret probe status failed",
				slog.String("secret", secret.Name),
				slog.Any("error", err),
			)
		}
	}
	return nil
}

func (r *resolver) probeSecret(ctx context.Context, secret *agentzv1alpha1.Secret) error {
	status := r.secretRuntimeStatus(ctx, secret)
	now := time.Now().UTC()
	r.probeTimesMu.Lock()
	r.probeTimes[secret.Name] = now
	r.probeTimesMu.Unlock()
	return r.writeSecretStatus(ctx, secret.Namespace, secret.Name, status)
}

func (r *resolver) secretRuntimeStatus(ctx context.Context, secret *agentzv1alpha1.Secret) secretRuntimeStatus {
	path := secretstore.SecretPath(secret.Namespace, secret.Spec.AgentRef.Name, secret.Spec.Key)
	rawSecret, err := r.kv.Get(ctx, path)
	if err != nil {
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			return acceptedSecretStatus()
		}
		return degradedSecretStatus(
			agentzv1alpha1.SecretReasonReconcileFailed,
			fmt.Sprintf("read openbao runtime: %v", err),
		)
	}
	if rawSecret == nil || rawSecret.Data == nil {
		return acceptedSecretStatus()
	}

	switch secret.Spec.Type {
	case agentzv1alpha1.SecretTypeStatic:
		record, err := secretstore.DecodeRecord[secretstore.StaticRecord](rawSecret.Data)
		if err != nil {
			return degradedSecretStatus(agentzv1alpha1.SecretReasonReconcileFailed, err.Error())
		}
		if record.Type != agentzv1alpha1.SecretTypeStatic {
			return degradedSecretStatus(
				agentzv1alpha1.SecretReasonReconcileFailed,
				fmt.Sprintf("runtime record type %q does not match secret type %q", record.Type, secret.Spec.Type),
			)
		}
		if _, err := ParseSecretHosts(record.Hosts); err != nil {
			return degradedSecretStatus(agentzv1alpha1.SecretReasonReconcileFailed, err.Error())
		}
		if err := validateSecretValue(record.Value); err != nil {
			return degradedSecretStatus(agentzv1alpha1.SecretReasonReconcileFailed, err.Error())
		}
		return readySecretStatus(nil, nil)
	case agentzv1alpha1.SecretTypeOAuth:
		return r.oauthRuntimeStatus(ctx, secret, rawSecret.Data)
	default:
		return degradedSecretStatus(
			agentzv1alpha1.SecretReasonReconcileFailed,
			fmt.Sprintf("unsupported secret type %q", secret.Spec.Type),
		)
	}
}

func (r *resolver) oauthRuntimeStatus(ctx context.Context, secret *agentzv1alpha1.Secret, raw map[string]any) secretRuntimeStatus {
	record, err := secretstore.DecodeRecord[secretstore.OAuthRecord](raw)
	if err != nil {
		return degradedSecretStatus(agentzv1alpha1.SecretReasonReconcileFailed, err.Error())
	}
	if record.Type != agentzv1alpha1.SecretTypeOAuth {
		return degradedSecretStatus(
			agentzv1alpha1.SecretReasonReconcileFailed,
			fmt.Sprintf("runtime record type %q does not match secret type %q", record.Type, secret.Spec.Type),
		)
	}
	if _, err := ParseSecretHosts(record.Hosts); err != nil {
		return degradedSecretStatus(agentzv1alpha1.SecretReasonReconcileFailed, err.Error())
	}
	if record.Token == nil || strings.TrimSpace(record.Token.AccessToken) == "" {
		return acceptedSecretStatus()
	}

	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		expiry := record.Token.Expiry.UTC()
		return readySecretStatus(&expiry, nil)
	}

	refreshed, err := r.refreshOAuth(ctx, secret.Spec.Key, record)
	if err != nil {
		return degradedSecretStatus(agentzv1alpha1.SecretReasonRefreshFailed, err.Error())
	}
	if refreshed.Token == nil || strings.TrimSpace(refreshed.Token.AccessToken) == "" {
		return acceptedSecretStatus()
	}
	expiry := refreshed.Token.Expiry.UTC()
	refreshTime := time.Now().UTC()
	return readySecretStatus(&expiry, &refreshTime)
}

func (r *resolver) writeStatusForKey(ctx context.Context, key string, status secretRuntimeStatus) {
	secret, err := r.secretForKey(key)
	if err != nil {
		slog.WarnContext(ctx, "load secret for runtime status", slog.String("key", key), slog.Any("err", err))
		return
	}
	if err := r.writeSecretStatus(ctx, secret.Namespace, secret.Name, status); err != nil {
		slog.WarnContext(ctx, "update secret runtime status", slog.String("secret", secret.Name), slog.Any("err", err))
	}
}

func (r *resolver) secretForKey(key string) (*agentzv1alpha1.Secret, error) {
	items, err := r.secrets.List(labels.Everything())
	if err != nil {
		return nil, err
	}
	for _, secret := range items {
		if secret.Spec.AgentRef.Name == r.agentName && secret.Spec.Key == key {
			return secret, nil
		}
	}
	return nil, fmt.Errorf("secret key %q not found", key)
}

func (r *resolver) writeSecretStatus(ctx context.Context, namespace, name string, next secretRuntimeStatus) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		secret := &agentzv1alpha1.Secret{}
		key := ctrlclient.ObjectKey{Namespace: namespace, Name: name}
		if err := r.k8sClient.Get(ctx, key, secret); err != nil {
			return ctrlclient.IgnoreNotFound(err)
		}

		path := secretstore.SecretPath(secret.Namespace, secret.Spec.AgentRef.Name, secret.Spec.Key)
		now := metav1.NewTime(time.Now().UTC())
		secret.Status.State = next.state
		secret.Status.ObservedGeneration = secret.Generation
		secret.Status.RuntimeRef = &agentzv1alpha1.SecretRuntimeRef{Path: path}
		secret.Status.LastRuntimeUpdateTime = &now
		secret.Status.TokenExpiryTime = nil
		if next.tokenExpiry != nil && !next.tokenExpiry.IsZero() {
			expiry := metav1.NewTime(next.tokenExpiry.UTC())
			secret.Status.TokenExpiryTime = &expiry
		}
		if next.refreshTime != nil && !next.refreshTime.IsZero() {
			refreshTime := metav1.NewTime(next.refreshTime.UTC())
			secret.Status.LastRefreshTime = &refreshTime
		}

		secret.Status.LastRefreshFailureTime = nil
		secret.Status.LastRefreshFailureReason = ""
		secret.Status.LastRefreshFailureMessage = ""
		if next.state == agentzv1alpha1.SecretStateDegraded {
			secret.Status.LastRefreshFailureTime = &now
			secret.Status.LastRefreshFailureReason = next.reason
			secret.Status.LastRefreshFailureMessage = next.message
		}

		secretstore.SetCondition(&secret.Status, metav1.Condition{
			Type:               next.condition,
			Status:             metav1.ConditionTrue,
			Reason:             next.reason,
			Message:            next.message,
			ObservedGeneration: secret.Generation,
		})
		return r.k8sClient.Status().Update(ctx, secret)
	})
}

func acceptedSecretStatus() secretRuntimeStatus {
	return secretRuntimeStatus{
		state:     agentzv1alpha1.SecretStateAccepted,
		condition: agentzv1alpha1.SecretConditionAccepted,
		reason:    agentzv1alpha1.SecretReasonAccepted,
		message:   "Secret runtime is pending",
	}
}

func readySecretStatus(tokenExpiry *time.Time, refreshTime *time.Time) secretRuntimeStatus {
	return secretRuntimeStatus{
		state:       agentzv1alpha1.SecretStateReady,
		condition:   agentzv1alpha1.SecretConditionReady,
		reason:      agentzv1alpha1.SecretReasonReady,
		message:     "Secret runtime is ready",
		tokenExpiry: tokenExpiry,
		refreshTime: refreshTime,
	}
}

func degradedSecretStatus(reason, message string) secretRuntimeStatus {
	return secretRuntimeStatus{
		state:     agentzv1alpha1.SecretStateDegraded,
		condition: agentzv1alpha1.SecretConditionDegraded,
		reason:    reason,
		message:   message,
	}
}
