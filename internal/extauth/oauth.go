package extauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/oauth"
	secretstore "github.com/accuknox/agentz/internal/secret"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) resolveOAuthRequest(ctx context.Context, conn *agentzv1alpha1.MCPConnection, attrs *requestAttrs) (injectedRequest, error) {
	token, location, refreshAttempted, err := s.resolveOAuthAccessToken(ctx, conn)
	if refreshAttempted {
		attrs.refreshAttempted = true
	}
	if err != nil {
		return injectedRequest{}, err
	}
	if refreshAttempted {
		attrs.refreshSucceeded = true
	}
	return injectionForLocation(location, token)
}

func (s *Service) resolveOAuthAccessToken(ctx context.Context, conn *agentzv1alpha1.MCPConnection) (string, *agentzv1alpha1.MCPConnectionAuthLocation, bool, error) {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return "", nil, false, fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return "", nil, false, err
	}

	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return record.Token.AccessToken, auth.Location, false, nil
	}

	// Coordinate rotation of the persisted credential, not a connection name
	// whose secret reference may have changed. Callers read their own record.
	refresh := s.oauthRefresh.DoChan(auth.SecretRef.Path, func() (any, error) {
		return nil, s.refreshOAuthToken(ctx, conn)
	})
	select {
	case <-ctx.Done():
		return "", nil, true, ctx.Err()
	case result := <-refresh:
		if result.Err != nil {
			return "", nil, true, result.Err
		}
	}
	record, err = s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return "", nil, true, err
	}
	if record.Token == nil || record.Token.AccessToken == "" {
		return "", nil, true, errCredentialUnavailable
	}
	if !record.Token.Expiry.IsZero() && !record.Token.Expiry.After(time.Now()) {
		return "", nil, true, errCredentialUnavailable
	}
	return record.Token.AccessToken, auth.Location, true, nil
}

func (s *Service) refreshOAuthToken(ctx context.Context, conn *agentzv1alpha1.MCPConnection) error {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return nil
	}

	refreshedToken, scopes, err := oauth.Refresh(
		ctx,
		s.http,
		oauth.AuthConfig{
			TokenEndpoint: auth.TokenEndpoint,
			Resource:      auth.Resource,
			Scopes:        auth.Scopes,
		},
		record.Record,
	)
	if err != nil {
		return fmt.Errorf("%v: %w", err, errCredentialUnavailable)
	}

	record.Token = refreshedToken
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now

	return s.writeSecretRecord(ctx, auth.SecretRef.Path, auth.SecretRef.Key, record)
}

func (s *Service) readBearerRecord(ctx context.Context, ref agentzv1alpha1.MCPConnectionSecretRef) (mcp.BearerSecretRecord, error) {
	var record mcp.BearerSecretRecord
	secretCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	record, err := secretstore.ReadField[mcp.BearerSecretRecord](
		secretCtx,
		s.kv,
		ref.Path,
		ref.Key,
	)
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return record, fmt.Errorf("%v: %w", err, errCredentialPending)
	}
	if err != nil {
		return record, fmt.Errorf("%v: %w", err, errCredentialUnavailable)
	}
	return record, nil
}

func (s *Service) readOAuthRecord(ctx context.Context, ref agentzv1alpha1.MCPConnectionSecretRef) (mcp.OAuthSecretRecord, error) {
	secretCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	record, err := secretstore.ReadField[mcp.OAuthSecretRecord](
		secretCtx,
		s.kv,
		ref.Path,
		ref.Key,
	)
	if err != nil {
		var empty mcp.OAuthSecretRecord
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			return empty, fmt.Errorf("%v: %w", err, errCredentialPending)
		}
		return empty, fmt.Errorf("%v: %w", err, errCredentialUnavailable)
	}
	if record.Scopes == nil {
		record.Scopes = []string{}
	}
	if record.Registration == nil {
		record.Registration = map[string]any{}
	}
	if record.Revocation == nil {
		record.Revocation = map[string]any{}
	}
	return record, nil
}

func (s *Service) writeSecretRecord(ctx context.Context, path, key string, record any) error {
	secretCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	if err := secretstore.WriteField(secretCtx, s.kv, path, key, record); err != nil {
		return fmt.Errorf("%v: %w", err, errCredentialUnavailable)
	}
	return nil
}
