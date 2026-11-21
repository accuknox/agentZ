package inference

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"golang.org/x/oauth2"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	claudeClientID      = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeResponseLimit = 1 << 20
	// ClaudeTokenEndpoint exchanges and refreshes Claude subscription credentials.
	ClaudeTokenEndpoint = "https://platform.claude.com/v1/oauth/token"
)

type claudeProfile struct {
	Account claudeAccount `json:"account"`
}

type claudeAccount struct {
	UUID string `json:"uuid"`
}

// Claude's token and control-plane requests use the Axios profile captured by
// CLIProxyAPI. Keep it separate from native client inference headers.
type claudeTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

func refreshClaudeSubscription(ctx context.Context, client *http.Client, record SubscriptionRecord, now time.Time) (SubscriptionRecord, error) {
	if record.Token == nil || record.Token.RefreshToken == "" {
		return SubscriptionRecord{}, errors.New("claude refresh token is unavailable")
	}
	body, err := json.Marshal(map[string]string{
		"client_id":     claudeClientID,
		"grant_type":    "refresh_token",
		"refresh_token": record.Token.RefreshToken,
		"scope":         "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
	})
	if err != nil {
		return SubscriptionRecord{}, err
	}
	payload, err := claudeOAuthRequest(ctx, client, http.MethodPost, ClaudeTokenEndpoint, "", body)
	if err != nil {
		return SubscriptionRecord{}, fmt.Errorf("refresh Claude token: %w", err)
	}
	var token claudeTokens
	if err := json.Unmarshal(payload, &token); err != nil {
		return SubscriptionRecord{}, fmt.Errorf("decode Claude refresh response: %w", err)
	}
	if token.AccessToken == "" || token.ExpiresIn <= 0 || token.ExpiresIn > 31536000 {
		return SubscriptionRecord{}, errors.New("invalid Claude refresh response")
	}
	refreshToken := token.RefreshToken
	if refreshToken == "" {
		refreshToken = record.Token.RefreshToken
	}
	record.Token = &oauth2.Token{
		AccessToken:  token.AccessToken,
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		Expiry:       now.Add(time.Duration(token.ExpiresIn) * time.Second),
	}
	record.UpdatedAt = now
	return record, nil
}

func claudeOAuthRequest(ctx context.Context, client *http.Client, method, endpoint, accessToken string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "axios/1.15.2")
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	req.Close = true
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Cache-Control", "no-cache")
	}
	oauthClient := *client
	oauthClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := oauthClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claude OAuth upstream returned %s", resp.Status)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, claudeResponseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > claudeResponseLimit {
		return nil, errors.New("claude OAuth response exceeds 1 MiB")
	}
	encodings := strings.Split(strings.Join(resp.Header.Values("Content-Encoding"), ","), ",")
	for i := len(encodings) - 1; i >= 0; i-- {
		var reader io.ReadCloser
		switch strings.TrimSpace(strings.ToLower(encodings[i])) {
		case "", "identity":
			continue
		case "gzip":
			reader, err = gzip.NewReader(bytes.NewReader(payload))
		case "deflate":
			reader, err = zlib.NewReader(bytes.NewReader(payload))
			if err != nil {
				reader = flate.NewReader(bytes.NewReader(payload))
				err = nil
			}
		case "br":
			reader = io.NopCloser(brotli.NewReader(bytes.NewReader(payload)))
		default:
			return nil, errors.New("unsupported Claude OAuth content encoding")
		}
		if err != nil {
			return nil, err
		}
		payload, err = io.ReadAll(io.LimitReader(reader, claudeResponseLimit+1))
		closeErr := reader.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if len(payload) > claudeResponseLimit {
			return nil, errors.New("decoded Claude OAuth response exceeds 1 MiB")
		}
	}
	return payload, nil
}

// AuthorizeClaudeSubscription checks the owning tenant on every use so disabling
// the flag revokes existing grants without copying policy into credentials.
func AuthorizeClaudeSubscription(ctx context.Context, reader client.Reader, namespace string) error {
	organization, err := scope.Namespace(ctx, reader, namespace, agentzv1alpha1.ResourceScopeOrganisation)
	if err != nil {
		return err
	}
	var tenant agentzv1alpha1.Tenant
	if err := reader.Get(ctx, client.ObjectKey{Name: organization}, &tenant); err != nil {
		return fmt.Errorf("get Claude subscription policy: %w", err)
	}
	if !tenant.Spec.AllowClaudeSubscription {
		return errors.New("claude subscriptions are disabled for this tenant")
	}
	return nil
}
