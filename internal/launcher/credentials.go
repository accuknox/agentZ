package launcher

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v5"
	"github.com/cli/browser"
	"github.com/gofrs/flock"
	"github.com/golang-jwt/jwt/v5"
	"github.com/urfave/cli/v3"
	"golang.org/x/oauth2"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

var errCredentialRequired = errors.New("AgentZ sign-in required")
var errInvalidOAuthResponse = errors.New("invalid AgentZ authentication response")

const (
	oauthRequestTimeout = 20 * time.Second
	oauthRefreshTimeout = 15 * time.Second
	oauthRefreshTries   = 3
	claudeRefreshPrefix = "azr_"
)

type profileCredential struct {
	oauth2.Token
	GatewayRefreshToken string `json:"gateway_refresh_token,omitempty"`
	Revoking            bool   `json:"revoking,omitempty"`
}

func (installed *installation) loginDevice(ctx context.Context, command *cli.Command, resource string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	scope := "inference:use"
	if resource == "mcp" {
		scope = "mcp:use"
	}
	config := oauth2.Config{
		ClientID: installed.ClientID,
		Scopes:   []string{"openid", "profile", "email", "offline_access", scope},
		Endpoint: oauth2.Endpoint{
			DeviceAuthURL: installed.upstream.String() + "/api/auth/device/code",
			TokenURL:      installed.upstream.String() + "/api/auth/oauth2/token",
			AuthStyle:     oauth2.AuthStyleInParams,
		},
	}
	resourceURL := installed.upstream.String() + "/api/inference/v1"
	if resource == "mcp" {
		resourceURL = installed.upstream.String() + "/api/mcp"
	}
	device, err := config.DeviceAuth(ctx, oauth2.SetAuthURLParam("resource", resourceURL))
	if err != nil {
		return errors.New("AgentZ sign-in is unavailable. Check the server and client ID")
	}
	fmt.Fprintf(command.ErrWriter, "Sign in for %s at %s\nCode: %s\n", resource, device.VerificationURI, device.UserCode)
	if device.VerificationURIComplete != "" {
		_ = browser.OpenURL(device.VerificationURIComplete)
	}
	token, err := config.DeviceAccessToken(ctx, device, oauth2.SetAuthURLParam("resource", resourceURL))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("AgentZ sign-in was denied or expired. Run agentz login %s again", installed.Provider)
	}
	if !token.Valid() || token.Expiry.IsZero() || !strings.EqualFold(token.TokenType, "Bearer") {
		return errors.New("AgentZ returned an invalid OAuth credential")
	}
	lock, err := installed.lockCredential(ctx, resource)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := installed.saveCredential(resource, profileCredential{Token: *token}); err != nil {
		return err
	}
	fmt.Fprintf(command.ErrWriter, "AgentZ %s connected.\n", resource)
	return nil
}

func (installed *installation) lockCredential(ctx context.Context, resource string) (*flock.Flock, error) {
	lock := flock.New(filepath.Join(installed.profile, resource+"-oauth.lock"))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil || !locked {
		lock.Close()
		return nil, fmt.Errorf("lock AgentZ credential: %w", errors.Join(err, ctx.Err()))
	}
	return lock, nil
}

func (installed *installation) saveCredential(resource string, credential profileCredential) error {
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	return writeProfileFile(filepath.Join(installed.profile, resource+"-oauth.json"), data)
}

func (installed *installation) readCredential(resource string) (profileCredential, error) {
	var credential profileCredential
	data, err := os.ReadFile(filepath.Join(installed.profile, resource+"-oauth.json"))
	if err != nil {
		return credential, err
	}
	err = json.Unmarshal(data, &credential)
	return credential, err
}

// accessToken uses a verified session ID for Claude Code. Other launchers
// authenticate at the relay boundary with their local client key.
func (installed *installation) accessToken(ctx context.Context, resource, sessionID string) (string, error) {
	lockCtx, cancel := context.WithTimeout(ctx, oauthRequestTimeout)
	defer cancel()
	lock, err := installed.lockCredential(lockCtx, resource)
	if err != nil {
		return "", err
	}
	defer lock.Close()

	stored, err := installed.readCredential(resource)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read AgentZ credential: %w", err)
	}
	invalid := err != nil || stored.Revoking || stored.Expiry.IsZero() || !strings.EqualFold(stored.TokenType, "Bearer")
	claude := installed.Provider == "claude"
	login := "agentz login " + installed.Provider + " --profile NAME"
	switch {
	case claude:
		login = "/login in Claude Code"
		if !invalid {
			id := claudeSessionID(stored.GatewayRefreshToken)
			matches := hmac.Equal([]byte(id), []byte(sessionID))
			invalid = stored.GatewayRefreshToken == "" || !matches
		}
	case resource == "mcp":
		login += " --mcp"
	}
	if invalid {
		return "", fmt.Errorf("%w. Run %s", errCredentialRequired, login)
	}
	if stored.AccessToken != "" && time.Until(stored.Expiry) > 30*time.Second {
		return stored.AccessToken, nil
	}
	if stored.RefreshToken == "" {
		return "", fmt.Errorf("%w. Run %s", errCredentialRequired, login)
	}

	refreshCtx := lockCtx
	if claude {
		// Once committed to the exchange, save the rotation even if Claude exits.
		refreshCtx = context.WithoutCancel(ctx)
	}
	client := &http.Client{
		Timeout:       oauthRefreshTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	refreshCtx = context.WithValue(refreshCtx, oauth2.HTTPClient, client)
	config := oauth2.Config{
		ClientID: installed.ClientID,
		Endpoint: oauth2.Endpoint{
			TokenURL:  installed.upstream.String() + "/api/auth/oauth2/token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
	// Each grant contains exactly one resource. Better Auth retains that
	// resource on refresh when the OAuth client omits the resource parameter.
	refresh := &oauth2.Token{RefreshToken: stored.RefreshToken}
	// A lost response leaves the server rotated but this profile stale. Retry
	// transport failures at once so Better Auth replays the rotated grant
	// within its reuse interval instead of revoking the token family.
	token, err := backoff.Retry(
		refreshCtx,
		func() (*oauth2.Token, error) {
			token, err := config.TokenSource(refreshCtx, refresh).Token()
			if _, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
				return nil, backoff.Permanent(err)
			}
			return token, err
		},
		backoff.WithMaxTries(oauthRefreshTries),
	)
	if err != nil {
		oauthErr, ok := errors.AsType[*oauth2.RetrieveError](err)
		if ok && oauthErr.ErrorCode == "invalid_grant" {
			if claude {
				path := filepath.Join(installed.profile, resource+"-oauth.json")
				if err := os.Remove(path); err != nil {
					return "", fmt.Errorf("remove expired AgentZ credential: %w", err)
				}
			}
			return "", fmt.Errorf("%w. Run %s", errCredentialRequired, login)
		}
		if claude && stored.AccessToken != "" && time.Now().Before(stored.Expiry) {
			return stored.AccessToken, nil
		}
		return "", errors.New("AgentZ could not renew your authorization. Try again shortly")
	}
	stored.Token = *token
	if err := installed.saveCredential(resource, stored); err != nil {
		return "", fmt.Errorf("save renewed AgentZ credential: %w", err)
	}
	return token.AccessToken, nil
}

func claudeSessionID(refresh string) string {
	// The access token can identify the session without disclosing its renewal key.
	digest := sha256.Sum256([]byte(refresh))
	return hex.EncodeToString(digest[:])
}

func (installed *installation) acceptClaudeGrant(ctx context.Context, data []byte) (string, error) {
	var token oauth2.Token
	err := json.Unmarshal(data, &token)
	missingToken := token.AccessToken == "" || token.RefreshToken == ""
	validExpiry := token.ExpiresIn > 0 && token.ExpiresIn <= (1<<63-1)/int64(time.Second)
	if err != nil || missingToken || !validExpiry || !strings.EqualFold(token.TokenType, "Bearer") {
		return "", errInvalidOAuthResponse
	}
	token.Expiry = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
	lock, err := installed.lockCredential(ctx, "inference")
	if err != nil {
		return "", err
	}
	defer lock.Close()
	stored := profileCredential{Token: token, GatewayRefreshToken: claudeRefreshPrefix + rand.Text()}
	if err := installed.saveCredential("inference", stored); err != nil {
		return "", err
	}
	return stored.GatewayRefreshToken, nil
}

func (installed *installation) revokeClaudeGrant(ctx context.Context, client *http.Client, form url.Values) (*http.Response, []byte, error) {
	lock, err := installed.lockCredential(ctx, "inference")
	if err != nil {
		return nil, nil, err
	}
	defer lock.Close()

	stored, err := installed.readCredential("inference")
	token := form.Get("token")
	path := "/api/auth/oauth2/revoke"
	if errors.Is(err, os.ErrNotExist) && !strings.HasPrefix(token, claudeRefreshPrefix) {
		// Before the relay owned Claude sessions, Claude held the upstream token.
		return installed.requestOAuth(ctx, client, path, form)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	matches := hmac.Equal([]byte(token), []byte(stored.GatewayRefreshToken))
	if stored.GatewayRefreshToken == "" || !matches {
		return nil, nil, nil
	}

	// Close local sessions immediately and keep the upstream token for retries.
	if !stored.Revoking {
		stored.Revoking = true
		if err := installed.saveCredential("inference", stored); err != nil {
			return nil, nil, err
		}
	}
	form.Set("token", stored.RefreshToken)
	form.Set("token_type_hint", "refresh_token")
	response, data, err := installed.requestOAuth(ctx, client, path, form)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return response, data, err
	}
	err = os.Remove(filepath.Join(installed.profile, "inference-oauth.json"))
	return response, data, err
}

func (installed *installation) writeClaudeSession(w http.ResponseWriter, refresh string) {
	const lifetime = time.Hour
	claims := jwt.RegisteredClaims{
		Issuer:    installed.address,
		Subject:   installed.ClientID,
		ID:        claudeSessionID(refresh),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(lifetime)),
	}
	access, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(installed.ownerKey))
	if err != nil {
		http.Error(w, "Cannot issue Claude gateway session.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(oauth2.Token{
		AccessToken:  access,
		TokenType:    "Bearer",
		RefreshToken: refresh,
		ExpiresIn:    int64(lifetime / time.Second),
	})
}

// modelCatalog loads the current grant so launchers never reuse revoked models.
func (installed *installation) modelCatalog(ctx context.Context) (*gatewayapi.DelegationCatalog, error) {
	token, err := installed.accessToken(ctx, "inference", "")
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	client, err := gatewayapi.NewClientWithResponses(installed.upstream.String(), gatewayapi.WithHTTPClient(httpClient))
	if err != nil {
		return nil, err
	}
	catalog, err := client.GetDelegatedCatalogWithResponse(ctx, func(_ context.Context, r *http.Request) error {
		r.Header.Set("Authorization", "Bearer "+token)
		return nil
	})
	if err != nil {
		return nil, errors.New("AgentZ model catalog is unavailable")
	}
	if catalog.JSON200 == nil {
		if catalog.StatusCode() == http.StatusUnauthorized || catalog.StatusCode() == http.StatusForbidden {
			return nil, fmt.Errorf("AgentZ model access was revoked. Reconnect with agentz login %s using the same --profile", installed.Provider)
		}
		return nil, fmt.Errorf("AgentZ model discovery is unavailable (HTTP %d). Try launching again", catalog.StatusCode())
	}
	return catalog.JSON200, nil
}
