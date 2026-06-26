package extauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
	"golang.org/x/oauth2"
)

const oauthRefreshGrace = time.Minute

var blockedOAuthTokenEndpointPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int64  `json:"expires_in"`
	Scope            string `json:"scope"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (s *Service) resolveOAuthRequest(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection, attrs *requestAttrs) (injectedRequest, error) {
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

func (s *Service) resolveOAuthAccessToken(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection) (string, *clawarmorv1alpha1.MCPConnectionAuthLocation, bool, error) {
	auth := conn.Spec.Auth.OAuth
	if auth == nil || auth.SecretRef == nil {
		return "", nil, false, fmt.Errorf("oauth secret ref is missing: %w", errCredentialUnavailable)
	}

	record, err := s.readOAuthRecord(ctx, *auth.SecretRef)
	if err != nil {
		return "", nil, false, err
	}

	now := time.Now().UTC()
	if oauthTokenUsable(record.Token, now) {
		return record.Token.AccessToken, auth.Location, false, nil
	}

	result, err, _ := s.sf.Do(conn.Namespace+"/"+conn.Name, func() (any, error) {
		return s.refreshOAuthToken(ctx, conn)
	})
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
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", record.Token.RefreshToken)
	scopes := auth.Scopes
	if len(record.Scopes) > 0 {
		scopes = record.Scopes
	}
	scopeValue := strings.Join(scopes, " ")
	if scopeValue != "" {
		form.Set("scope", scopeValue)
	}
	if strings.TrimSpace(auth.Resource) != "" {
		form.Set("resource", auth.Resource)
	}

	tokenEndpointAuthMethod := "client_secret_basic"
	if value, ok := record.Registration["token_endpoint_auth_method"].(string); ok {
		if method := strings.TrimSpace(value); method != "" {
			tokenEndpointAuthMethod = method
		}
	}

	tokenEndpoint, err := requirePublicOAuthTokenEndpoint(ctx, auth.TokenEndpoint)
	if err != nil {
		return nil, nil, err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		tokenEndpoint,
		bytes.NewBufferString(form.Encode()),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("build oauth refresh request: %w", err)
	}

	req.Header.Set("content-type", "application/x-www-form-urlencoded")

	switch tokenEndpointAuthMethod {
	case "client_secret_basic":
		req.SetBasicAuth(record.ClientID, record.ClientSecret)
	case "client_secret_post", "none":
		form.Set("client_id", record.ClientID)
		if tokenEndpointAuthMethod == "client_secret_post" {
			form.Set("client_secret", record.ClientSecret)
		}
		encoded := form.Encode()
		req.Body = io.NopCloser(strings.NewReader(encoded))
		req.ContentLength = int64(len(encoded))
	default:
		return nil, nil, fmt.Errorf(
			"oauth token endpoint auth method %q is not supported: %w",
			tokenEndpointAuthMethod, errCredentialUnavailable,
		)
	}

	oauthClient := *s.http
	oauthClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}

	resp, err := oauthClient.Do(req)
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
		return nil, nil, fmt.Errorf(
			"read oauth refresh response: %v: %w",
			err,
			errCredentialUnavailable,
		)
	}

	var tokenResp tokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, nil, fmt.Errorf(
			"decode oauth refresh response: %v: %w",
			err,
			errCredentialUnavailable,
		)
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

	scope := strings.TrimSpace(tokenResp.Scope)
	if scope == "" {
		return token, nil, nil
	}
	return token, strings.Fields(scope), nil
}

func requirePublicOAuthTokenEndpoint(ctx context.Context, raw string) (string, error) {
	endpoint := strings.TrimSpace(raw)
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("parse oauth token endpoint: %v: %w", err, errCredentialUnavailable)
	}
	if u.Scheme != "https" {
		return "", fmt.Errorf("oauth token endpoint must use https: %w", errCredentialUnavailable)
	}
	if u.User != nil {
		return "", fmt.Errorf("oauth token endpoint must not include credentials: %w", errCredentialUnavailable)
	}

	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(u.Hostname()), "."))
	if host == "" {
		return "", fmt.Errorf("oauth token endpoint must include a host: %w", errCredentialUnavailable)
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "", fmt.Errorf("oauth token endpoint must resolve to a public address: %w", errCredentialUnavailable)
	}

	if addr, err := netip.ParseAddr(host); err == nil {
		if !publicOAuthTokenEndpointAddr(addr) {
			return "", fmt.Errorf("oauth token endpoint must resolve to a public address: %w", errCredentialUnavailable)
		}
		return u.String(), nil
	}

	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return "", fmt.Errorf("resolve oauth token endpoint host: %v: %w", err, errCredentialUnavailable)
	}
	if len(addrs) == 0 {
		return "", fmt.Errorf("oauth token endpoint host has no addresses: %w", errCredentialUnavailable)
	}
	for _, addr := range addrs {
		if !publicOAuthTokenEndpointAddr(addr) {
			return "", fmt.Errorf("oauth token endpoint must resolve to a public address: %w", errCredentialUnavailable)
		}
	}

	return u.String(), nil
}

func publicOAuthTokenEndpointAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range blockedOAuthTokenEndpointPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
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
		return fmt.Errorf(
			"read openbao secret %q: %v: %w",
			path,
			err,
			errCredentialUnavailable,
		)
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
		return fmt.Errorf(
			"read openbao secret %q before write: %v: %w",
			path,
			err,
			errCredentialUnavailable,
		)
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
		return fmt.Errorf(
			"write openbao secret %q: %v: %w",
			path,
			err,
			errCredentialUnavailable,
		)
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
