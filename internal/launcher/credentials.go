package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cli/browser"
	"github.com/gofrs/flock"
	"github.com/urfave/cli/v3"
	"golang.org/x/oauth2"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

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
	lock := flock.New(filepath.Join(installed.profile, resource+"-oauth.lock"))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil || !locked {
		return fmt.Errorf("lock AgentZ credential: %w", errors.Join(err, ctx.Err()))
	}
	defer lock.Close()
	data, err := json.Marshal(token)
	if err != nil {
		return err
	}
	err = writeProfileFile(filepath.Join(installed.profile, resource+"-oauth.json"), data)
	if err != nil {
		return err
	}
	fmt.Fprintf(command.ErrWriter, "AgentZ %s connected.\n", resource)
	return nil
}

func (installed *installation) accessToken(ctx context.Context, resource string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	login := "agentz login " + installed.Provider + " --profile NAME"
	if resource == "mcp" {
		login += " --mcp"
	}
	lock := flock.New(filepath.Join(installed.profile, resource+"-oauth.lock"))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil || !locked {
		return "", fmt.Errorf("lock AgentZ credential: %w", errors.Join(err, ctx.Err()))
	}
	defer lock.Close()
	path := filepath.Join(installed.profile, resource+"-oauth.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("sign in for %s with %s", resource, login)
	}
	var stored oauth2.Token
	err = json.Unmarshal(data, &stored)
	invalid := err != nil || stored.Expiry.IsZero() || !strings.EqualFold(stored.TokenType, "Bearer")
	if invalid {
		return "", fmt.Errorf("invalid AgentZ OAuth credential. Reconnect with %s", login)
	}
	client := &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
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
	source := oauth2.ReuseTokenSourceWithExpiry(&stored, config.TokenSource(ctx, refresh), 30*time.Second)
	token, err := source.Token()
	if err != nil {
		return "", fmt.Errorf("AgentZ authorization expired or was revoked. Reconnect with %s", login)
	}
	changed := token.AccessToken != stored.AccessToken || token.RefreshToken != stored.RefreshToken
	if changed || !token.Expiry.Equal(stored.Expiry) {
		data, err := json.Marshal(token)
		if err != nil {
			return "", err
		}
		if err := writeProfileFile(path, data); err != nil {
			return "", err
		}
	}
	return token.AccessToken, nil
}

// modelCatalog loads the current grant so launchers never reuse revoked models.
func (installed *installation) modelCatalog(ctx context.Context) (*gatewayapi.DelegationCatalog, error) {
	token, err := installed.accessToken(ctx, "inference")
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
