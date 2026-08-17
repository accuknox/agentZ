package extauth

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

	result, err, _ := s.sf.Do(
		conn.Namespace+"/"+conn.Name,
		func() (any, error) {
			return s.refreshOAuthToken(ctx, conn)
		},
	)
	if err != nil {
		return "", nil, true, err
	}

	refreshed, ok := result.(*mcp.OAuthSecretRecord)
	if !ok {
		return "", nil, true, fmt.Errorf(
			"unexpected oauth refresh result type %T: %w",
			result,
			errCredentialUnavailable,
		)
	}
	if refreshed.Token == nil || strings.TrimSpace(refreshed.Token.AccessToken) == "" {
		return "", nil, true, fmt.Errorf(
			"refreshed oauth token is missing access token: %w",
			errCredentialUnavailable,
		)
	}

	return refreshed.Token.AccessToken, auth.Location, true, nil
}

func (s *Service) refreshOAuthToken(ctx context.Context, conn *agentzv1alpha1.MCPConnection) (*mcp.OAuthSecretRecord, error) {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return nil, fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return &record, nil
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
		return nil, fmt.Errorf("%v: %w", err, errCredentialUnavailable)
	}

	record.Token = refreshedToken
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now

	if err := s.writeSecretRecord(ctx, auth.SecretRef.Path, auth.SecretRef.Key, record); err != nil {
		return nil, err
	}
	return &record, nil
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
