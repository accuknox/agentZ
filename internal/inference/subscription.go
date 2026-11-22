package inference

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/oauth2"

	"github.com/accuknox/agentz/internal/oauth"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	// OpenAICodexClientID is OpenAI's public Codex OAuth client identifier.
	OpenAICodexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	// OpenAICodexTokenEndpoint exchanges and refreshes Codex tokens.
	OpenAICodexTokenEndpoint = "https://auth.openai.com/oauth/token"
	// OpenAICodexModelsEndpoint serves the authenticated Codex model catalog.
	OpenAICodexModelsEndpoint = "https://chatgpt.com/backend-api/codex/models"
)

// SubscriptionRecord is the complete credential record retained only in
// OpenBao for a subscription-backed inference provider.
type SubscriptionRecord struct {
	Kind         agentzv1alpha1.InferenceProviderKind `json:"kind"`
	AccountID    string                               `json:"accountId,omitempty"`
	ClientID     string                               `json:"clientId,omitempty"`
	Token        *oauth2.Token                        `json:"token"`
	Scopes       []string                             `json:"scopes,omitempty"`
	RefreshAfter time.Time                            `json:"refreshAfter,omitzero"`
	UpdatedAt    time.Time                            `json:"updatedAt"`
}

// SubscriptionRecordData encodes a typed subscription record for OpenBao.
func SubscriptionRecordData(record SubscriptionRecord) (map[string]any, error) {
	payload, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("marshal inference subscription record: %w", err)
	}
	data := map[string]any{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, fmt.Errorf("encode inference subscription record: %w", err)
	}
	return data, nil
}

// DecodeSubscriptionRecord decodes one controlled OpenBao record strictly.
func DecodeSubscriptionRecord(data map[string]any) (SubscriptionRecord, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return SubscriptionRecord{}, fmt.Errorf("marshal inference subscription record: %w", err)
	}
	var record SubscriptionRecord
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&record); err != nil {
		return SubscriptionRecord{}, fmt.Errorf("decode inference subscription record: %w", err)
	}
	return record, nil
}

func refreshSubscription(ctx context.Context, client *http.Client, record SubscriptionRecord) (SubscriptionRecord, error) {
	now := time.Now().UTC()
	if record.Kind == agentzv1alpha1.InferenceProviderKindClaudeSubscription {
		return refreshClaudeSubscription(ctx, client, record, now)
	}
	if record.Kind != agentzv1alpha1.InferenceProviderKindOpenAICodex {
		return SubscriptionRecord{}, fmt.Errorf("provider kind %q is not subscription-backed", record.Kind)
	}
	token, scopes, err := oauth.Refresh(
		ctx,
		client,
		oauth.AuthConfig{
			TokenEndpoint:           OpenAICodexTokenEndpoint,
			TokenEndpointAuthMethod: "none",
		},
		oauth.Record{
			ClientID:  record.ClientID,
			Token:     record.Token,
			Scopes:    record.Scopes,
			UpdatedAt: record.UpdatedAt,
		},
	)
	if err != nil {
		return SubscriptionRecord{}, fmt.Errorf("refresh openai codex token: %w", err)
	}
	record.Token = token
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now
	return record, nil
}

// ErrSubscriptionRefresh marks a failed token exchange with the provider.
var ErrSubscriptionRefresh = errors.New("subscription token exchange failed")

var subscriptionRefresh sync.Map // credential path to channel closed when refresh finishes

func lockSubscriptionRefresh(ctx context.Context, path string) (func(), error) {
	done := make(chan struct{})
	for ctx.Err() == nil {
		active, loaded := subscriptionRefresh.LoadOrStore(path, done)
		if !loaded {
			return func() {
				subscriptionRefresh.Delete(path)
				close(done)
			}, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-active.(chan struct{}):
		}
	}
	return nil, ctx.Err()
}

// ResolveSubscription reads a usable credential and persists rotated tokens.
// Claude refresh claims use OpenBao CAS before the exchange, preventing the UI
// and extAuth processes from consuming the same single-use refresh token.
func ResolveSubscription(ctx context.Context, client *http.Client, kv *baoapi.KVv2, provider *agentzv1alpha1.InferenceProvider) (SubscriptionRecord, bool, error) {
	kind := provider.Spec.Kind
	path := CredentialPath(provider.Namespace, provider.Name, kind, provider.Spec.CredentialRevision)
	read := func(ctx context.Context) (SubscriptionRecord, int, error) {
		secret, err := kv.Get(ctx, path)
		if err != nil {
			return SubscriptionRecord{}, 0, fmt.Errorf("read inference credentials: %w", err)
		}
		record, err := DecodeSubscriptionRecord(secret.Data)
		if err != nil {
			return SubscriptionRecord{}, 0, err
		}
		if record.Kind != kind {
			return SubscriptionRecord{}, 0, errors.New("inference credentials do not match provider")
		}
		var version int
		if secret.VersionMetadata != nil {
			version = secret.VersionMetadata.Version
		}
		return record, version, nil
	}

	record, _, err := read(ctx)
	if err != nil {
		return SubscriptionRecord{}, false, err
	}
	if oauth.TokenUsable(record.Token, time.Now()) {
		return record, false, nil
	}
	unlock, err := lockSubscriptionRefresh(ctx, path)
	if err != nil {
		return SubscriptionRecord{}, true, err
	}
	defer unlock()
	record, version, err := read(ctx)
	if err != nil {
		return SubscriptionRecord{}, true, err
	}
	if oauth.TokenUsable(record.Token, time.Now()) {
		return record, true, nil
	}
	if version == 0 {
		return SubscriptionRecord{}, true, errors.New("inference credential version is missing")
	}
	refreshCtx := ctx
	if record.Kind == agentzv1alpha1.InferenceProviderKindClaudeSubscription {
		if record.RefreshAfter.After(time.Now()) {
			return SubscriptionRecord{}, true, errors.New("subscription refresh is in progress or cooling down; retry shortly")
		}
		// Keep an ambiguous exchange from immediately replaying a token that
		// Anthropic may already have consumed. Success clears this cooldown.
		record.RefreshAfter = time.Now().UTC().Add(5 * time.Minute)
		data, err := SubscriptionRecordData(record)
		if err != nil {
			return SubscriptionRecord{}, true, err
		}
		claim, err := kv.Put(ctx, path, data, baoapi.WithCheckAndSet(version))
		if err != nil {
			return SubscriptionRecord{}, true, fmt.Errorf("claim subscription refresh: %w", err)
		}
		if claim.VersionMetadata == nil {
			return SubscriptionRecord{}, true, errors.New("subscription refresh claim has no version")
		}
		version = claim.VersionMetadata.Version
		// Once claimed, let the exchange finish within its own timeout so a
		// disconnect cannot interrupt reading a token Claude already rotated.
		refreshCtx = context.WithoutCancel(ctx)
	}
	record, err = refreshSubscription(refreshCtx, client, record)
	if err != nil {
		return SubscriptionRecord{}, true, fmt.Errorf("%w: %w", ErrSubscriptionRefresh, err)
	}
	record.RefreshAfter = time.Time{}
	data, err := SubscriptionRecordData(record)
	if err != nil {
		return SubscriptionRecord{}, true, err
	}
	// Persist the rotated token even if the request has gone away.
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	cas := baoapi.WithCheckAndSet(version)
	var writeErr error
	for range 2 {
		_, writeErr = kv.Put(saveCtx, path, data, cas)
		if writeErr == nil {
			return record, true, nil
		}
		latest, latestVersion, readErr := read(saveCtx)
		if readErr != nil {
			return SubscriptionRecord{}, true, errors.Join(writeErr, readErr)
		}
		// Retry the save while our expected version is still current. The OAuth
		// exchange may have already consumed the previous refresh token.
		if latestVersion == version {
			continue
		}
		if latestVersion > version && oauth.TokenUsable(latest.Token, time.Now()) {
			return latest, true, nil
		}
		break
	}
	return SubscriptionRecord{}, true, writeErr
}
