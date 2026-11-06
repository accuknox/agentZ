package launcher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// The relay's local capability is separate from its control-plane HMAC key.
// It is never sent upstream. Upstream tokens remain audience-bound OAuth tokens.
func (installed *installation) clientKey() string {
	sum := sha256.Sum256([]byte("agentz-local-client\x00" + installed.ownerKey))
	return hex.EncodeToString(sum[:])
}

// A desktop helper must not resolve XDG_CONFIG_HOME again: the application can
// have a different environment from the terminal that exported its connection.
// Read only the explicitly exported local relay identity, never OAuth tokens.
func writeNativeHeaders(output io.Writer, profile string) error {
	if !filepath.IsAbs(profile) {
		return errors.New("the native helper requires an absolute profile directory")
	}
	file, err := os.Open(filepath.Join(profile, "relay.key"))
	if err != nil {
		return errors.New("native helper cannot read this AgentZ profile")
	}
	defer file.Close()
	key, err := io.ReadAll(io.LimitReader(file, 257))
	if err != nil || len(key) < 32 || len(key) > 256 {
		return errors.New("native helper found an invalid relay identity")
	}
	if _, err := hex.DecodeString(string(key)); err != nil {
		return errors.New("native helper found an invalid relay identity")
	}
	installed := installation{ownerKey: string(key)}
	return json.NewEncoder(output).Encode(map[string]string{"Authorization": "Bearer " + installed.clientKey()})
}

func (installed *installation) oauthConfig(resource string) *oauth2.Config {
	scope := "inference:use"
	if resource == "mcp" {
		scope = "mcp:use"
	}
	return &oauth2.Config{
		ClientID: installed.ClientID,
		Scopes:   []string{"openid", "profile", "email", "offline_access", scope},
		Endpoint: oauth2.Endpoint{
			DeviceAuthURL: installed.upstream.String() + "/api/auth/device/code",
			TokenURL:      installed.upstream.String() + "/api/auth/oauth2/token",
			AuthStyle:     oauth2.AuthStyleInParams,
		},
	}
}

func (installed *installation) resourceURL(resource string) string {
	if resource == "mcp" {
		return installed.upstream.String() + "/api/mcp"
	}
	return installed.upstream.String() + "/api/inference/v1"
}

func oauthContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	})
}

// A directory lock serializes login and rotating refresh tokens across CLI and
// persistent relay processes. A crashed holder fails closed with recovery advice.
func (installed *installation) credentialLock(ctx context.Context, resource string) (func(), error) {
	path := filepath.Join(installed.profile, resource+"-oauth.lock")
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		err := os.Mkdir(path, 0o700)
		if err == nil {
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("OAuth credential is busy; if no AgentZ login or relay is running, remove %s: %w", path, ctx.Err())
		case <-timer.C:
		}
	}
}

func (installed *installation) loginAdapter(ctx context.Context, output io.Writer, resource string) error {
	// The OAuth device request expires independently of the CLI. Cancellation
	// stops polling; terminal OAuth failures never erase an earlier credential.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	ctx = oauthContext(ctx)
	config := installed.oauthConfig(resource)
	device, err := config.DeviceAuth(ctx, oauth2.SetAuthURLParam("resource", installed.resourceURL(resource)))
	if err != nil {
		return oauthFailure("start sign-in", err)
	}
	if device.VerificationURI == "" || device.UserCode == "" {
		return errors.New("AgentZ returned incomplete device sign-in instructions")
	}
	fmt.Fprintf(output, "Sign in for %s at %s\nCode: %s\n", resource, device.VerificationURI, device.UserCode)
	token, err := config.DeviceAccessToken(ctx, device, oauth2.SetAuthURLParam("resource", installed.resourceURL(resource)))
	if err != nil {
		return oauthFailure("complete sign-in", err)
	}
	if token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") || token.Expiry.IsZero() {
		return errors.New("AgentZ returned an invalid OAuth access token")
	}
	unlock, err := installed.credentialLock(ctx, resource)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := json.Marshal(token)
	if err != nil {
		return err
	}
	if err := writeProfileFile(filepath.Join(installed.profile, resource+"-oauth.json"), data); err != nil {
		return err
	}
	fmt.Fprintf(output, "AgentZ %s connected.\n", resource)
	return nil
}

func oauthFailure(operation string, err error) error {
	var response *oauth2.RetrieveError
	if errors.As(err, &response) {
		// OAuth response bodies can contain credentials. Report only the standard
		// error code, never descriptions, URLs, or arbitrary server response bodies.
		code := response.ErrorCode
		if !slices.Contains([]string{"access_denied", "expired_token", "invalid_grant", "invalid_client", "invalid_scope", "authorization_pending", "slow_down"}, code) {
			code = "authorization_failed"
		}
		return fmt.Errorf("%s: %s; sign in again with agentz login", operation, code)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return fmt.Errorf("%s: AgentZ authentication is unavailable", operation)
}

func (installed *installation) accessToken(ctx context.Context, resource string) (string, error) {
	unlock, err := installed.credentialLock(ctx, resource)
	if err != nil {
		return "", err
	}
	defer unlock()
	path := filepath.Join(installed.profile, resource+"-oauth.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("sign in with agentz login for this profile and resource")
	}
	var token oauth2.Token
	if err := json.Unmarshal(data, &token); err != nil {
		return "", errors.New("invalid stored OAuth credential; sign in again")
	}
	if token.AccessToken == "" || token.Expiry.IsZero() || !strings.EqualFold(token.TokenType, "bearer") {
		return "", errors.New("invalid stored OAuth credential; sign in again")
	}
	// Refresh before expiry; token refresh keeps the exact original audience.
	if token.Expiry.After(time.Now().Add(30 * time.Second)) {
		return token.AccessToken, nil
	}
	if token.RefreshToken == "" {
		return "", errors.New("OAuth credential expired; sign in again")
	}
	token.Expiry = time.Now().Add(-time.Minute)
	config := installed.oauthConfig(resource)
	// oauth2.Config's refresh flow does not expose resource parameters; make the
	// bounded form request explicitly so a multi-resource client cannot switch audiences.
	form := strings.NewReader(url.Values{"grant_type": {"refresh_token"}, "client_id": {installed.ClientID}, "refresh_token": {token.RefreshToken}, "resource": {installed.resourceURL(resource)}}.Encode())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Endpoint.TokenURL, form)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := oauthContext(ctx).Value(oauth2.HTTPClient).(*http.Client)
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("AgentZ token refresh is unavailable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return "", errors.New("invalid token refresh response")
	}
	if response.StatusCode != http.StatusOK {
		return "", errors.New("AgentZ rejected token refresh; sign in again")
	}
	var renewed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if json.Unmarshal(body, &renewed) != nil || renewed.AccessToken == "" || !strings.EqualFold(renewed.TokenType, "bearer") || renewed.ExpiresIn <= 0 || renewed.ExpiresIn > 86400 {
		return "", errors.New("invalid token refresh response")
	}
	token.AccessToken, token.TokenType, token.Expiry = renewed.AccessToken, renewed.TokenType, time.Now().Add(time.Duration(renewed.ExpiresIn)*time.Second)
	if renewed.RefreshToken != "" {
		token.RefreshToken = renewed.RefreshToken
	}
	data, err = json.Marshal(&token)
	if err != nil {
		return "", err
	}
	if err := writeProfileFile(path, data); err != nil {
		return "", err
	}
	return token.AccessToken, nil
}
