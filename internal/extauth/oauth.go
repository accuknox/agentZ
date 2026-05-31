package extauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
	"golang.org/x/oauth2"
)

const oauthRefreshGrace = time.Minute

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int64  `json:"expires_in"`
	Scope            string `json:"scope"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (s *Service) resolveOAuthHeader(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection, attrs *requestAttrs) (injectedHeader, error) {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return injectedHeader{}, fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	location, err := headerLocation(auth.Location)
	if err != nil {
		return injectedHeader{}, err
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return injectedHeader{}, err
	}

	token := record.Token
	if oauthTokenUsable(token, time.Now().UTC()) {
		return injectedHeader{
			name:  location.name,
			value: prefixedValue(location.prefix, token.AccessToken),
		}, nil
	}

	attrs.refreshAttempted = true
	result, err, _ := s.sf.Do(conn.Namespace+"/"+conn.Name, func() (any, error) {
		return s.refreshOAuthToken(ctx, conn)
	})
	if err != nil {
		return injectedHeader{}, err
	}

	refreshed, ok := result.(*mcp.OAuthSecretRecord)
	if !ok {
		return injectedHeader{}, fmt.Errorf("unexpected oauth refresh result type %T: %w", result, errCredentialUnavailable)
	}

	if refreshed.Token == nil || strings.TrimSpace(refreshed.Token.AccessToken) == "" {
		return injectedHeader{}, fmt.Errorf("refreshed oauth token is missing access token: %w", errCredentialUnavailable)
	}

	attrs.refreshSucceeded = true
	return injectedHeader{
		name:  location.name,
		value: prefixedValue(location.prefix, refreshed.Token.AccessToken),
	}, nil
}

func (s *Service) refreshOAuthToken(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection) (*mcp.OAuthSecretRecord, error) {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return nil, fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if oauthTokenUsable(record.Token, now) {
		return &record, nil
	}
	if strings.TrimSpace(auth.TokenEndpoint) == "" {
		return nil, fmt.Errorf("oauth token endpoint is missing: %w", errCredentialUnavailable)
	}
	if strings.TrimSpace(record.ClientID) == "" {
		return nil, fmt.Errorf("oauth client id is missing: %w", errCredentialUnavailable)
	}
	if record.Token == nil || strings.TrimSpace(record.Token.RefreshToken) == "" {
		return nil, fmt.Errorf("oauth refresh token is missing: %w", errCredentialUnavailable)
	}

	refreshedToken, scopes, err := s.refreshToken(ctx, auth, record)
	if err != nil {
		return nil, err
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

func (s *Service) refreshToken(ctx context.Context, auth *clawarmorv1alpha1.MCPConnectionOAuthAuth, record mcp.OAuthSecretRecord) (*oauth2.Token, []string, error) {
	if strings.TrimSpace(auth.Resource) != "" {
		return s.refreshTokenWithResource(ctx, auth, record)
	}

	conf, err := oauthConfig(auth, record)
	if err != nil {
		return nil, nil, err
	}

	clientCtx := context.WithValue(ctx, oauth2.HTTPClient, s.http)
	src := oauth2.ReuseTokenSourceWithExpiry(
		record.Token,
		conf.TokenSource(clientCtx, record.Token),
		oauthRefreshGrace,
	)

	token, err := src.Token()
	if err != nil {
		return nil, nil, fmt.Errorf(
			"refresh oauth token: %v: %w",
			err,
			errCredentialUnavailable,
		)
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return nil, nil, fmt.Errorf(
			"oauth refresh response omitted access token: %w",
			errCredentialUnavailable,
		)
	}

	return token, tokenScopes(token), nil
}

func (s *Service) refreshTokenWithResource(ctx context.Context, auth *clawarmorv1alpha1.MCPConnectionOAuthAuth, record mcp.OAuthSecretRecord) (*oauth2.Token, []string, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", record.Token.RefreshToken)

	scopeValue := strings.Join(record.Scopes, " ")
	if scopeValue == "" {
		scopeValue = strings.Join(auth.Scopes, " ")
	}
	if scopeValue != "" {
		form.Set("scope", scopeValue)
	}
	if strings.TrimSpace(auth.Resource) != "" {
		form.Set("resource", auth.Resource)
	}

	tokenEndpointAuthMethod := registrationString(record.Registration, "token_endpoint_auth_method")
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		auth.TokenEndpoint,
		bytes.NewBufferString(form.Encode()),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("build oauth refresh request: %w", err)
	}

	req.Header.Set("content-type", "application/x-www-form-urlencoded")

	switch tokenEndpointAuthMethod {
	case "", "client_secret_basic":
		req.SetBasicAuth(record.ClientID, record.ClientSecret)
	case "client_secret_post":
		form.Set("client_id", record.ClientID)
		form.Set("client_secret", record.ClientSecret)
		req.Body = io.NopCloser(strings.NewReader(form.Encode()))
		req.ContentLength = int64(len(form.Encode()))
	case "none":
		form.Set("client_id", record.ClientID)
		req.Body = io.NopCloser(strings.NewReader(form.Encode()))
		req.ContentLength = int64(len(form.Encode()))
	default:
		return nil, nil, fmt.Errorf(
			"oauth token endpoint auth method %q is not supported: %w",
			tokenEndpointAuthMethod, errCredentialUnavailable,
		)
	}

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf(
			"refresh oauth token: %v: %w",
			err,
			errCredentialUnavailable,
		)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, nil, fmt.Errorf("read oauth refresh response: %w", errCredentialUnavailable)
	}

	var tokenResp tokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, nil, fmt.Errorf("decode oauth refresh response: %w", errCredentialUnavailable)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(tokenResp.ErrorDescription)
		if message == "" {
			message = strings.TrimSpace(tokenResp.Error)
		}
		if message == "" {
			message = resp.Status
		}
		return nil, nil, fmt.Errorf("oauth refresh failed: %s: %w", message, errCredentialUnavailable)
	}

	if strings.TrimSpace(tokenResp.AccessToken) == "" {
		return nil, nil, fmt.Errorf("oauth refresh response omitted access token: %w", errCredentialUnavailable)
	}

	token := &oauth2.Token{
		AccessToken:  tokenResp.AccessToken,
		TokenType:    tokenResp.TokenType,
		RefreshToken: tokenResp.RefreshToken,
	}
	if token.RefreshToken == "" {
		token.RefreshToken = record.Token.RefreshToken
	}
	if tokenResp.ExpiresIn > 0 {
		token.Expiry = time.Now().UTC().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	var scopes []string
	if trimmed := strings.TrimSpace(tokenResp.Scope); trimmed != "" {
		scopes = strings.Fields(trimmed)
	}

	return token, scopes, nil
}

func oauthConfig(auth *clawarmorv1alpha1.MCPConnectionOAuthAuth, record mcp.OAuthSecretRecord) (*oauth2.Config, error) {
	tokenEndpointAuthMethod := registrationString(record.Registration, "token_endpoint_auth_method")

	endpoint := oauth2.Endpoint{
		TokenURL: auth.TokenEndpoint,
	}

	switch tokenEndpointAuthMethod {
	case "", "client_secret_basic":
		endpoint.AuthStyle = oauth2.AuthStyleInHeader
	case "client_secret_post", "none":
		endpoint.AuthStyle = oauth2.AuthStyleInParams
	default:
		return nil, fmt.Errorf(
			"oauth token endpoint auth method %q is not supported: %w",
			tokenEndpointAuthMethod,
			errCredentialUnavailable,
		)
	}

	return &oauth2.Config{
		ClientID:     record.ClientID,
		ClientSecret: record.ClientSecret,
		Endpoint:     endpoint,
		Scopes:       oauthScopes(auth, record),
	}, nil
}

func oauthScopes(auth *clawarmorv1alpha1.MCPConnectionOAuthAuth, record mcp.OAuthSecretRecord) []string {
	if len(record.Scopes) > 0 {
		return record.Scopes
	}
	return auth.Scopes
}

func tokenScopes(token *oauth2.Token) []string {
	scope, _ := token.Extra("scope").(string)
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return nil
	}
	return strings.Fields(scope)
}

func oauthTokenUsable(token *oauth2.Token, now time.Time) bool {
	if token == nil {
		return false
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return false
	}
	if token.Expiry.IsZero() {
		return true
	}
	return token.Expiry.After(now.Add(oauthRefreshGrace))
}

func registrationString(registration map[string]any, key string) string {
	if len(registration) == 0 {
		return ""
	}
	value, ok := registration[key]
	if !ok {
		return ""
	}
	str, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(str)
}

func (s *Service) readBearerRecord(ctx context.Context, ref clawarmorv1alpha1.MCPConnectionSecretRef) (mcp.BearerSecretRecord, error) {
	var record mcp.BearerSecretRecord
	if err := s.readSecretRecord(ctx, ref.Path, ref.Key, &record); err != nil {
		return record, err
	}
	return record, nil
}

func (s *Service) readOAuthRecord(ctx context.Context, ref clawarmorv1alpha1.MCPConnectionSecretRef) (mcp.OAuthSecretRecord, error) {
	var record mcp.OAuthSecretRecord
	if err := s.readSecretRecord(ctx, ref.Path, ref.Key, &record); err != nil {
		return record, err
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

func (s *Service) readSecretRecord(ctx context.Context, path string, key string, out any) error {
	secretCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	secret, err := s.kv.Get(secretCtx, path)
	if err != nil {
		return fmt.Errorf("read openbao secret %q: %w", path, errCredentialUnavailable)
	}
	if secret == nil || secret.Data == nil {
		return fmt.Errorf("openbao secret %q is missing data: %w", path, errCredentialUnavailable)
	}

	raw, ok := secret.Data[key]
	if !ok {
		return fmt.Errorf("openbao secret %q is missing key %q: %w", path, key, errCredentialUnavailable)
	}

	payload, err := secretPayload(raw)
	if err != nil {
		return fmt.Errorf("decode openbao secret %q key %q: %w", path, key, errCredentialUnavailable)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("unmarshal openbao secret %q key %q: %w", path, key, errCredentialUnavailable)
	}
	return nil
}

func (s *Service) writeSecretRecord(ctx context.Context, path string, key string, record any) error {
	secretCtx, cancel := context.WithTimeout(ctx, kubeRequestTimeout)
	defer cancel()

	current, err := s.kv.Get(secretCtx, path)
	if err != nil {
		return fmt.Errorf("read openbao secret %q before write: %w", path, errCredentialUnavailable)
	}

	data := map[string]any{}
	if current != nil && current.Data != nil {
		maps.Copy(data, current.Data)
	}

	payload, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal openbao secret %q key %q: %w", path, key, errCredentialUnavailable)
	}
	data[key] = string(payload)

	if _, err := s.kv.Put(secretCtx, path, data); err != nil {
		return fmt.Errorf("write openbao secret %q: %w", path, errCredentialUnavailable)
	}
	return nil
}

func secretPayload(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		return []byte(value), nil
	case []byte:
		return value, nil
	case map[string]any:
		return json.Marshal(value)
	default:
		return nil, fmt.Errorf("unsupported secret payload type %T", raw)
	}
}
