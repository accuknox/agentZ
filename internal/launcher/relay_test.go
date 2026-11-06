package launcher

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func startTestRelay(t *testing.T, installed *installation) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	installed.address = "http://" + listener.Addr().String()
	listener.Close()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- installed.serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(7 * time.Second):
			t.Error("relay did not stop")
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := installed.controlRelay(t.Context(), "status")
		if err == nil {
			r.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("relay failed to start")
}

func TestAdapterRelayRoutesAndProtectsResources(t *testing.T) {
	type received struct{ path, auth, cookie, alternate, apiKey, body string }
	requests := make(chan received, 20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- received{r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.Header.Get("X-AgentZ-Authorization"), r.Header.Get("X-Api-Key"), string(body)}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	installed := testInstallation(t, server.URL)
	saveTestToken(t, installed, "inference", time.Now().Add(time.Hour))
	saveTestToken(t, installed, "mcp", time.Now().Add(time.Hour))
	startTestRelay(t, installed)
	for _, path := range []string{"/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/mcp"} {
		t.Run(path, func(t *testing.T) {
			method := http.MethodPost
			if path == "/v1/models" {
				method = http.MethodGet
			}
			request, _ := http.NewRequest(method, installed.address+path, strings.NewReader(`{"model":"approved","stream":true}`))
			request.Header.Set("Authorization", "Bearer "+installed.clientKey())
			request.Header.Set("Cookie", "secret-cookie")
			request.Header.Set("X-AgentZ-Authorization", "Bearer attacker")
			request.Header.Set("X-Api-Key", "secret-api-key")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("status=%d", response.StatusCode)
			}
			actual := <-requests
			wantPath := "/api/inference" + path
			wantAuth := "Bearer inference-access"
			if path == "/mcp" {
				wantPath = "/api/mcp"
				wantAuth = "Bearer mcp-access"
			}
			if actual.path != wantPath || actual.auth != wantAuth || actual.cookie != "" || actual.alternate != "" || actual.apiKey != "" || !strings.Contains(actual.body, `"stream":true`) {
				t.Errorf("incorrect routing: %+v", actual)
			}
		})
	}
	for _, test := range []struct {
		name, key, origin, host string
		status                  int
	}{
		{name: "no credential", status: 401}, {name: "wrong key", key: "wrong", status: 401},
		{name: "browser origin", key: installed.clientKey(), origin: "https://attacker.invalid", status: 403},
		{name: "host rebinding", key: installed.clientKey(), host: "attacker.invalid", status: 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodPost, installed.address+"/mcp", nil)
			request.Header.Set("Authorization", "Bearer "+test.key)
			request.Header.Set("Origin", test.origin)
			if test.host != "" {
				request.Host = test.host
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != test.status {
				t.Errorf("status=%d", response.StatusCode)
			}
			select {
			case <-requests:
				t.Fatal("unauthorized request reached upstream")
			default:
			}
		})
	}
}

func TestAdapterStreamFlushAndUpstreamFailures(t *testing.T) {
	continueStream := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Failure") != "" {
			w.WriteHeader(429)
			fmt.Fprint(w, "rate limited")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-continueStream:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: last\n\n")
	}))
	defer server.Close()
	installed := testInstallation(t, server.URL)
	saveTestToken(t, installed, "inference", time.Now().Add(time.Hour))
	startTestRelay(t, installed)
	request, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, installed.address+"/v1/chat/completions", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer "+installed.clientKey())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(response.Body, first); err != nil {
		t.Fatal(err)
	}
	if string(first) != "data: first\n\n" {
		t.Fatal("stream buffered or changed")
	}
	close(continueStream)
	rest, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(rest) != "data: last\n\n" {
		t.Fatalf("stream ended incorrectly: %q", rest)
	}
	request, _ = http.NewRequest(http.MethodPost, installed.address+"/v1/chat/completions", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer "+installed.clientKey())
	request.Header.Set("X-Test-Failure", "yes")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 429 {
		t.Fatalf("upstream status changed: %d", response.StatusCode)
	}
}

func TestAdapterAcceptsNativeAPIKeyHeadersWithoutForwardingThem(t *testing.T) {
	for _, header := range []string{"X-Api-Key", "Api-Key"} {
		t.Run(header, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer inference-access" || r.Header.Get(header) != "" {
					t.Error("native credential leaked or OAuth audience lost")
				}
				w.WriteHeader(204)
			}))
			defer server.Close()
			installed := testInstallation(t, server.URL)
			saveTestToken(t, installed, "inference", time.Now().Add(time.Hour))
			startTestRelay(t, installed)
			request, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, installed.address+"/v1/messages", strings.NewReader(`{}`))
			request.Header.Set(header, installed.clientKey())
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 204 {
				t.Fatalf("native authentication rejected: %d", response.StatusCode)
			}
		})
	}
}
