package gateway

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestValidateWebOrigins(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		origins []string
		want    []string
		wantErr bool
	}{
		{
			name:    "one origin",
			origins: []string{"https://agentz.example.com"},
			want:    []string{"https://agentz.example.com"},
		},
		{
			name:    "multiple canonical origins",
			origins: []string{"https://agentz.example.com/", "http://localhost:3000", "https://agentz.example.com"},
			want:    []string{"https://agentz.example.com", "http://localhost:3000"},
		},
		{name: "missing", wantErr: true},
		{name: "wildcard", origins: []string{"*"}, wantErr: true},
		{name: "credentials", origins: []string{"https://user@example.com"}, wantErr: true},
		{name: "path", origins: []string{"https://example.com/app"}, wantErr: true},
		{name: "query", origins: []string{"https://example.com?tenant=one"}, wantErr: true},
		{name: "fragment", origins: []string{"https://example.com/#app"}, wantErr: true},
		{name: "wrong scheme", origins: []string{"ftp://example.com"}, wantErr: true},
		{name: "relative", origins: []string{"example.com"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := validateWebOrigins(tt.origins)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("validate web origins: %v", err)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("origins = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestGatewayCORS(t *testing.T) {
	t.Parallel()

	openAPI, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatalf("load OpenAPI: %v", err)
	}
	handler := (&Service{cfg: Config{
		AllowedWebOrigins: []string{"https://agentz.example.com", "http://localhost:3000"},
	}, openAPI: openAPI}).routes()

	tests := []struct {
		name        string
		origin      string
		wantAllowed bool
	}{
		{name: "first configured origin", origin: "https://agentz.example.com", wantAllowed: true},
		{name: "second configured origin", origin: "http://localhost:3000", wantAllowed: true},
		{name: "unknown origin", origin: "https://untrusted.example.com"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodOptions, "/api/agents", nil)
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Access-Control-Request-Method", http.MethodGet)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)

			got := res.Header().Get("Access-Control-Allow-Origin")
			if tt.wantAllowed && got != tt.origin {
				t.Fatalf("allow origin = %q, want %q", got, tt.origin)
			}
			if !tt.wantAllowed && got != "" {
				t.Fatalf("allow origin = %q, want no header", got)
			}
			if !strings.Contains(res.Header().Get("Vary"), "Origin") {
				t.Fatalf("Vary = %q, want Origin", res.Header().Get("Vary"))
			}
		})
	}
}

func TestGatewayCORSDoesNotAffectNonCORSRequests(t *testing.T) {
	t.Parallel()

	openAPI, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatalf("load OpenAPI: %v", err)
	}
	handler := (&Service{cfg: Config{
		AllowedWebOrigins: []string{"https://agentz.example.com"},
	}, openAPI: openAPI}).routes()

	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("allow origin = %q, want no header", got)
	}
}
