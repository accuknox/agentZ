package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// RefreshGrace is the safety window before expiry where tokens are refreshed.
const RefreshGrace = time.Minute

var blockedTokenEndpointPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
}

// AuthConfig describes the non-sensitive OAuth metadata needed for refresh.
type AuthConfig struct {
	TokenEndpoint           string
	TokenEndpointAuthMethod string
	Resource                string
	Scopes                  []string
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

// TokenUsable reports whether one access token is still safe to inject.
func TokenUsable(token *oauth2.Token, now time.Time) bool {
	if token == nil {
		return false
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return false
	}
	if token.Expiry.IsZero() {
		return true
	}
	return token.Expiry.After(now.Add(RefreshGrace))
}

// Refresh exchanges one refresh token for a fresh access token.
func Refresh(ctx context.Context, client *http.Client, cfg AuthConfig, record Record) (*oauth2.Token, []string, error) {
	if strings.TrimSpace(cfg.TokenEndpoint) == "" {
		return nil, nil, fmt.Errorf("oauth token endpoint is required")
	}
	if strings.TrimSpace(record.ClientID) == "" {
		return nil, nil, fmt.Errorf("oauth client id is required")
	}
	if record.Token == nil || strings.TrimSpace(record.Token.RefreshToken) == "" {
		return nil, nil, fmt.Errorf("oauth refresh token is required")
	}

	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", record.Token.RefreshToken)

	scopes := cfg.Scopes
	if len(record.Scopes) > 0 {
		scopes = record.Scopes
	}
	if scopeValue := strings.Join(scopes, " "); scopeValue != "" {
		form.Set("scope", scopeValue)
	}
	if strings.TrimSpace(cfg.Resource) != "" {
		form.Set("resource", cfg.Resource)
	}

	authMethod := strings.TrimSpace(cfg.TokenEndpointAuthMethod)
	if authMethod == "" {
		authMethod = "client_secret_basic"
		if raw, ok := record.Registration["token_endpoint_auth_method"].(string); ok {
			if value := strings.TrimSpace(raw); value != "" {
				authMethod = value
			}
		}
	}

	tokenEndpoint, err := PublicHTTPSURL(ctx, cfg.TokenEndpoint)
	if err != nil {
		return nil, nil, err
	}

	body := form.Encode()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		tokenEndpoint,
		bytes.NewBufferString(body),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("build oauth refresh request: %w", err)
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")

	switch authMethod {
	case "client_secret_basic":
		req.SetBasicAuth(record.ClientID, record.ClientSecret)
	case "client_secret_post", "none":
		form.Set("client_id", record.ClientID)
		if authMethod == "client_secret_post" {
			form.Set("client_secret", record.ClientSecret)
		}
		body = form.Encode()
		req.Body = io.NopCloser(strings.NewReader(body))
		req.ContentLength = int64(len(body))
	default:
		return nil, nil, fmt.Errorf("oauth token endpoint auth method %q is not supported", authMethod)
	}

	refreshClient := *client
	refreshClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}

	resp, err := refreshClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("refresh oauth token: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return nil, nil, fmt.Errorf("read oauth refresh response: %w", err)
	}
	if len(payload) > 1<<20 {
		return nil, nil, fmt.Errorf("oauth refresh response exceeds 1 MiB")
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, nil, fmt.Errorf("oauth refresh failed: upstream returned %s", resp.Status)
	}

	var tokenResp tokenResponse
	if err := json.Unmarshal(payload, &tokenResp); err != nil {
		return nil, nil, fmt.Errorf("decode oauth refresh response: %w", err)
	}
	if strings.TrimSpace(tokenResp.AccessToken) == "" {
		return nil, nil, fmt.Errorf("oauth refresh response is missing an access token")
	}

	refreshToken := record.Token.RefreshToken
	if value := strings.TrimSpace(tokenResp.RefreshToken); value != "" {
		refreshToken = value
	}

	token := &oauth2.Token{
		AccessToken:  tokenResp.AccessToken,
		TokenType:    tokenResp.TokenType,
		RefreshToken: refreshToken,
	}
	if tokenResp.ExpiresIn > 0 {
		token.Expiry = time.Now().UTC().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	nextScopes := []string{}
	if raw := strings.TrimSpace(tokenResp.Scope); raw != "" {
		nextScopes = strings.Fields(raw)
	}
	return token, nextScopes, nil
}

// PublicHTTPSURL canonicalizes one HTTPS endpoint and rejects non-public
// addresses so OAuth exchanges cannot target local or reserved networks.
func PublicHTTPSURL(ctx context.Context, raw string) (string, error) {
	value := strings.TrimSpace(raw)
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("parse oauth endpoint: %w", err)
	}
	if parsed.Scheme != "https" {
		return "", fmt.Errorf("oauth endpoint must use https")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("oauth endpoint must not include credentials")
	}

	host := parsed.Hostname()
	if host == "" {
		return "", fmt.Errorf("oauth endpoint host is required")
	}

	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return "", fmt.Errorf("resolve oauth endpoint: %w", err)
	}
	if len(addrs) == 0 {
		return "", fmt.Errorf("resolve oauth endpoint: no addresses found")
	}

	for _, addr := range addrs {
		isLocal := addr.IsLoopback() || addr.IsPrivate()
		isLinkLocal := addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast()
		isInvalid := isLocal || isLinkLocal || addr.IsMulticast() || addr.IsUnspecified()
		if isInvalid {
			return "", fmt.Errorf("oauth endpoint must resolve to a public address")
		}
		for _, prefix := range blockedTokenEndpointPrefixes {
			if prefix.Contains(addr) {
				return "", fmt.Errorf("oauth endpoint must resolve to a public address")
			}
		}
	}

	return parsed.String(), nil
}
