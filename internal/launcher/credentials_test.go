package launcher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

func testInstallation(t *testing.T, server string) *installation {
	t.Helper()
	upstream, err := url.Parse(server)
	if err != nil {
		t.Fatal(err)
	}
	return &installation{externalAgent: externalAgent{Provider: "github-copilot-cli", ClientID: "test-client"}, profile: t.TempDir(), upstream: upstream, ownerKey: "test-owner-key-with-enough-entropy"}
}

func saveTestToken(t *testing.T, installed *installation, resource string, expiry time.Time) {
	t.Helper()
	data, err := json.Marshal(&oauth2.Token{AccessToken: resource + "-access", RefreshToken: resource + "-refresh", TokenType: "Bearer", Expiry: expiry})
	if err != nil {
		t.Fatal(err)
	}
	if err := writeProfileFile(filepath.Join(installed.profile, resource+"-oauth.json"), data); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialRefreshSerializesAndPinsAudience(t *testing.T) {
	var calls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("client_id") != "test-client" || r.Form.Get("resource") != server.URL+"/api/inference/v1" || r.Form.Get("refresh_token") != "inference-refresh" {
			t.Errorf("incorrect refresh form: keys %v", r.Form.Has("resource"))
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"access_token":"renewed","refresh_token":"rotated","token_type":"Bearer","expires_in":300}`)
	}))
	defer server.Close()
	installed := testInstallation(t, server.URL)
	saveTestToken(t, installed, "inference", time.Now().Add(-time.Minute))
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			token, err := installed.accessToken(t.Context(), "inference")
			if err != nil || token != "renewed" {
				t.Errorf("refresh failed: %v", err)
			}
		})
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("refreshes=%d, want 1", calls.Load())
	}
	data, err := os.ReadFile(filepath.Join(installed.profile, "inference-oauth.json"))
	if err != nil {
		t.Fatal(err)
	}
	var token oauth2.Token
	if json.Unmarshal(data, &token) != nil || token.RefreshToken != "rotated" {
		t.Fatal("refresh rotation not persisted")
	}
	info, err := os.Stat(filepath.Join(installed.profile, "inference-oauth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("credential mode=%v", info.Mode())
	}
}

func TestCredentialFailureDoesNotLeakOrOverwrite(t *testing.T) {
	for _, body := range []string{`{"error":"invalid_grant","access_token":"secret-do-not-log"}`, `not-json-secret`, `{"access_token":"secret-do-not-log","expires_in":0,"token_type":"Bearer"}`} {
		t.Run(body[:8], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer server.Close()
			installed := testInstallation(t, server.URL)
			saveTestToken(t, installed, "mcp", time.Now().Add(-time.Minute))
			before, _ := os.ReadFile(filepath.Join(installed.profile, "mcp-oauth.json"))
			_, err := installed.accessToken(t.Context(), "mcp")
			if err == nil || strings.Contains(err.Error(), "secret-do-not-log") {
				t.Fatalf("unsafe failure: %v", err)
			}
			after, _ := os.ReadFile(filepath.Join(installed.profile, "mcp-oauth.json"))
			if string(before) != string(after) {
				t.Fatal("credential was overwritten on failure")
			}
		})
	}
}

func TestCredentialsStaySeparateAndRejectMalformedState(t *testing.T) {
	installed := testInstallation(t, "https://example.invalid")
	saveTestToken(t, installed, "inference", time.Now().Add(time.Hour))
	if _, err := installed.accessToken(t.Context(), "mcp"); err == nil {
		t.Fatal("inference credential authorized MCP")
	}
	if installed.clientKey() == installed.ownerKey {
		t.Fatal("data and control credentials must differ")
	}
	for _, data := range []string{"null", `{}`, `{"access_token":"x","token_type":"Basic"}`, `not json`} {
		if err := writeProfileFile(filepath.Join(installed.profile, "mcp-oauth.json"), []byte(data)); err != nil {
			t.Fatal(err)
		}
		if _, err := installed.accessToken(t.Context(), "mcp"); err == nil {
			t.Fatal("malformed state accepted")
		}
	}
}

func TestCredentialLockCancellation(t *testing.T) {
	installed := testInstallation(t, "https://example.invalid")
	unlock, err := installed.credentialLock(t.Context(), "mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := installed.credentialLock(ctx, "mcp"); err == nil {
		t.Fatal("canceled lock accepted")
	}
}

func TestCopilotEnvironmentIsolation(t *testing.T) {
	input := []string{"PATH=/bin", "COPILOT_HOME=other", "COPILOT_MODEL=other", "COPILOT_PROVIDER_HEADERS=Authorization: secret", "COPILOT_PROVIDER_API_KEY_COMMAND=bad", "COPILOT_PROVIDERS_CONFIG=other", "COPILOT_PROVIDER_TRANSPORT=websockets"}
	actual := copilotEnvironment(input)
	if len(actual) != 1 || actual[0] != "PATH=/bin" {
		t.Fatalf("unsafe environment: %q", actual)
	}
	if len(input) != 7 {
		t.Fatal("environment input mutated")
	}
}

func TestDeviceLoginPinsResourceAndPreservesCredentialOnDenial(t *testing.T) {
	for _, resource := range []string{"inference", "mcp"} {
		t.Run(resource, func(t *testing.T) {
			var denied atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseForm(); err != nil {
					t.Error(err)
				}
				want := "/api/inference/v1"
				if resource == "mcp" {
					want = "/api/mcp"
				}
				if !strings.HasSuffix(r.Form.Get("resource"), want) || r.Form.Get("client_id") != "test-client" {
					t.Error("device flow lost its audience or client binding")
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device/code" {
					fmt.Fprint(w, `{"device_code":"device","user_code":"CODE","verification_uri":"https://example.invalid/consent","expires_in":60,"interval":1}`)
					return
				}
				if denied.Load() {
					w.WriteHeader(400)
					fmt.Fprint(w, `{"error":"access_denied","error_description":"sensitive-server-response"}`)
					return
				}
				fmt.Fprint(w, `{"access_token":"device-access","token_type":"Bearer","refresh_token":"device-refresh","expires_in":300}`)
			}))
			defer server.Close()
			installed := testInstallation(t, server.URL)
			if err := installed.loginAdapter(t.Context(), io.Discard, resource); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(installed.profile, resource+"-oauth.json")
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			denied.Store(true)
			err = installed.loginAdapter(t.Context(), io.Discard, resource)
			if err == nil || !strings.Contains(err.Error(), "access_denied") || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("incorrect denial: %v", err)
			}
			after, _ := os.ReadFile(path)
			if string(original) != string(after) {
				t.Fatal("denied sign-in erased a working credential")
			}
		})
	}
}

func TestCanceledCredentialLockNeverAcquires(t *testing.T) {
	installed := testInstallation(t, "https://example.invalid")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if unlock, err := installed.credentialLock(ctx, "inference"); err == nil {
		unlock()
		t.Fatal("acquired a lock after cancellation")
	}
	if _, err := os.Stat(filepath.Join(installed.profile, "inference-oauth.lock")); !os.IsNotExist(err) {
		t.Fatal("left a lock after cancellation")
	}
}

func TestNativeHeadersUseExportedProfileAcrossXDGEnvironments(t *testing.T) {
	original := testInstallation(t, "https://example.invalid")
	original.ownerKey = strings.Repeat("ab", 26)
	if err := writeProfileFile(filepath.Join(original.profile, "relay.key"), []byte(original.ownerKey)); err != nil {
		t.Fatal(err)
	}
	unrelated := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", unrelated)
	var output strings.Builder
	if err := writeNativeHeaders(&output, original.profile); err != nil {
		t.Fatal(err)
	}
	var headers map[string]string
	if err := json.Unmarshal([]byte(output.String()), &headers); err != nil {
		t.Fatal(err)
	}
	if len(headers) != 1 || headers["Authorization"] != "Bearer "+original.clientKey() {
		t.Fatal("desktop helper used a different profile")
	}
	files, err := os.ReadDir(unrelated)
	if err != nil || len(files) != 0 {
		t.Fatal("helper created an unrelated default profile")
	}
	for _, key := range []string{"", "not-a-relay-identity", strings.Repeat("a", 258)} {
		if err := os.WriteFile(filepath.Join(original.profile, "relay.key"), []byte(key), 0600); err != nil {
			t.Fatal(err)
		}
		output.Reset()
		if err := writeNativeHeaders(&output, original.profile); err == nil || output.Len() != 0 {
			t.Fatal("helper emitted an invalid credential")
		}
	}
}
