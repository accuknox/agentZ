package gateway

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	baoapi "github.com/openbao/openbao/api/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type guardrailDiscoveryHTTP struct {
	calls   []*http.Request
	respond func(*http.Request) (*http.Response, error)
}

// RoundTrip records provider calls before returning the configured response.
func (u *guardrailDiscoveryHTTP) RoundTrip(request *http.Request) (*http.Response, error) {
	u.calls = append(u.calls, request)
	return u.respond(request)
}

type guardrailDiscoveryAccessCase struct {
	name      string
	inherited bool
	selected  bool
	permitted bool
	want      int
}

type guardrailDiscoveryGoogleCase struct {
	kind    string
	parent  string
	host    string
	path    string
	payload string
	id      string
}

type guardrailDiscoveryFixture struct {
	service     *Service
	router      http.Handler
	upstream    *guardrailDiscoveryHTTP
	credentials map[string]any
	secretPaths []string
}

func newGuardrailDiscoveryFixture(t *testing.T, provider api.GuardrailProvider, inherited, selected, permitted bool) *guardrailDiscoveryFixture {
	t.Helper()
	queries := &sandboxQueries{
		workspace: gatewaydb.Workspace{
			ID:             testWorkspaceID,
			OrganizationID: testOrganizationID,
			Namespace:      testWorkspaceNS,
			State:          gatewaydb.WorkspaceStateReady,
		},
	}
	if permitted {
		queries.permissions = []gatewaydb.GatewayResolvePermissionsRow{{
			Active:      true,
			WorkspaceID: pgtype.Text{String: testWorkspaceID, Valid: true},
			Resource: gatewaydb.NullPermissionResource{
				PermissionResource: gatewaydb.PermissionResourceGuardrailConnection,
				Valid:              true,
			},
			Action: gatewaydb.NullPermissionAction{
				PermissionAction: gatewaydb.PermissionActionRead,
				Valid:            true,
			},
		}}
	}
	fixture := &guardrailDiscoveryFixture{
		service: sandboxTestService(t, queries),
		credentials: map[string]any{
			"accessKey":    "saved-key",
			"secretKey":    "saved-secret",
			"sessionToken": "saved-session",
		},
		upstream: &guardrailDiscoveryHTTP{},
	}
	namespace := testWorkspaceNS
	if inherited {
		namespace = api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID)
	}
	connection := &api.GuardrailConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "saved", Namespace: namespace},
		Spec: api.GuardrailConnectionSpec{
			Provider:   provider,
			Region:     "us-east-1",
			SecretName: "saved-secret",
		},
	}
	if err := fixture.service.k8sClient.Create(t.Context(), connection); err != nil {
		t.Fatal(err)
	}
	if selected {
		workspace := &api.Workspace{}
		err := fixture.service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Name: testWorkspaceNS}, workspace)
		if err != nil {
			t.Fatal(err)
		}
		workspace.Spec.SelectedOrganizationResources.GuardrailConnections = []string{"saved"}
		if err := fixture.service.k8sClient.Update(t.Context(), workspace); err != nil {
			t.Fatal(err)
		}
	}
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.secretPaths = append(fixture.secretPaths, r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"data":     fixture.credentials,
				"metadata": map[string]any{"version": 1},
			},
		})
	}))
	t.Cleanup(store.Close)
	config := baoapi.DefaultConfig()
	config.Address = store.URL
	bao, err := baoapi.NewClient(config)
	if err != nil {
		t.Fatal(err)
	}
	fixture.service.baoKV = bao.KVv2("kv")
	fixture.service.outboundHTTP = &http.Client{Transport: fixture.upstream}
	fixture.upstream.respond = func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{},
			Body:       io.NopCloser(strings.NewReader(`{"guardrails":[]}`)),
		}, nil
	}
	router := chi.NewRouter()
	gatewayapi.HandlerWithOptions(fixture.service, gatewayapi.ChiServerOptions{
		BaseRouter:  router,
		Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
	})
	fixture.router = router
	return fixture
}

func (f *guardrailDiscoveryFixture) request(t *testing.T, body string) (*httptest.ResponseRecorder, gatewayapi.GuardrailResourceDiscovery) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/guardrails/connections/saved/resources", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	var result gatewayapi.GuardrailResourceDiscovery
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return response, result
}

func TestGuardrailDiscoveryScopeAndPermissionBeforeCredentials(t *testing.T) {
	tests := []guardrailDiscoveryAccessCase{
		{name: "owned", permitted: true, want: http.StatusOK},
		{
			name:      "selected inherited",
			inherited: true,
			selected:  true,
			permitted: true,
			want:      http.StatusOK,
		},
		{
			name:      "unselected inherited",
			inherited: true,
			permitted: true,
			want:      http.StatusForbidden,
		},
		{
			name:      "selected but missing read permission",
			inherited: true,
			selected:  true,
			want:      http.StatusForbidden,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newGuardrailDiscoveryFixture(t, "Bedrock", test.inherited, test.selected, test.permitted)
			resourceScope := "Workspace"
			if test.inherited {
				resourceScope = "Organisation"
			}
			response, _ := fixture.request(t, `{"scope":"`+resourceScope+`","kind":"guardrails"}`)
			if response.Code != test.want {
				t.Fatalf("HTTP %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			if test.want != http.StatusOK {
				if len(fixture.secretPaths) != 0 || len(fixture.upstream.calls) != 0 {
					t.Fatal("unauthorized discovery read a credential or called a provider")
				}
				return
			}
			namespace := testWorkspaceNS
			if test.inherited {
				namespace = api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID)
			}
			if len(fixture.secretPaths) != 1 || fixture.secretPaths[0] != "/v1/kv/data/"+namespace+"/guardrail-connections/saved" {
				t.Fatal("credential lookup did not use the selected connection owner's namespace")
			}
		})
	}
}

func TestGuardrailDiscoveryBedrockPagesUseSavedRegionAndCredentials(t *testing.T) {
	for _, kind := range []string{"guardrails", "versions"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newGuardrailDiscoveryFixture(t, "Bedrock", false, false, true)
			fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
				if request.URL.Host != "bedrock.us-east-1.amazonaws.com" || request.Method != http.MethodGet {
					t.Fatal("unexpected provider destination or method")
				}
				signedWithSavedKey := strings.Contains(request.Header.Get("Authorization"), "Credential=saved-key/")
				if !signedWithSavedKey || request.Header.Get("X-Amz-Security-Token") != "saved-session" {
					t.Fatal("request did not use the saved AWS key and session token")
				}
				query := request.URL.Query()
				if query.Get("maxResults") != "3" || query.Get("nextToken") != "opaque+page" {
					t.Fatal("provider pagination parameters changed")
				}
				if kind == "versions" && query.Get("guardrailIdentifier") != "abc123" {
					t.Fatal("version request did not use selected guardrail")
				}
				payload := `{"guardrails":[{"id":"abc123","arn":"arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123","name":"Company safety","description":"Published safety controls","version":"2","status":"READY"}],"nextToken":"next-page"}`
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{},
					Body:       io.NopCloser(strings.NewReader(payload)),
				}, nil
			}
			body := `{"scope":"Workspace","kind":"guardrails","pageSize":3,"pageToken":"opaque+page"}`
			if kind == "versions" {
				body = `{"scope":"Workspace","kind":"versions","parent":"abc123","pageSize":3,"pageToken":"opaque+page"}`
			}
			response, result := fixture.request(t, body)
			nextPage := result.NextPageToken != nil && *result.NextPageToken == "next-page"
			if response.Code != http.StatusOK || len(result.Items) != 1 || !nextPage || len(fixture.upstream.calls) != 1 {
				t.Fatalf("provider page was not preserved: HTTP %d, items=%d, calls=%d", response.Code, len(result.Items), len(fixture.upstream.calls))
			}
			wantID := "abc123"
			if kind == "versions" {
				wantID = "2"
			}
			if result.Items[0].Id != wantID {
				t.Fatal("selection did not retain provider resource/version identity")
			}
		})
	}
}

func TestGuardrailDiscoveryGoogleRefreshAndOnePage(t *testing.T) {
	tests := []guardrailDiscoveryGoogleCase{
		{
			kind:    "projects",
			host:    "cloudresourcemanager.googleapis.com",
			path:    "/v3/projects:search",
			payload: `{"projects":[{"projectId":"demo-project","displayName":"Demo","state":"ACTIVE"}],"nextPageToken":"next"}`,
			id:      "projects/demo-project",
		},
		{
			kind:    "locations",
			parent:  "projects/demo-project",
			host:    "modelarmor.googleapis.com",
			path:    "/v1/projects/demo-project/locations",
			payload: `{"locations":[{"name":"projects/demo-project/locations/us-central1","locationId":"us-central1","displayName":"Iowa"}],"nextPageToken":"next"}`,
			id:      "projects/demo-project/locations/us-central1",
		},
		{
			kind:    "templates",
			parent:  "projects/demo-project/locations/us-central1",
			host:    "modelarmor.us-central1.rep.googleapis.com",
			path:    "/v1/projects/demo-project/locations/us-central1/templates",
			payload: `{"templates":[{"name":"projects/demo-project/locations/us-central1/templates/company-safe","labels":{"team":"security"}}],"nextPageToken":"next","unreachable":["projects/demo-project/locations/europe-west1"]}`,
			id:      "projects/demo-project/locations/us-central1/templates/company-safe",
		},
		{
			kind:    "templates",
			parent:  "projects/demo-project/locations/eu",
			host:    "modelarmor.eu.rep.googleapis.com",
			path:    "/v1/projects/demo-project/locations/eu/templates",
			payload: `{"templates":[],"nextPageToken":"next","unreachable":["projects/demo-project/locations/eu"]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.kind+test.parent, func(t *testing.T) {
			fixture := newGuardrailDiscoveryFixture(t, "ModelArmor", false, false, true)
			fixture.credentials = map[string]any{
				"credentials.json": `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","token_uri":"https://oauth2.googleapis.com/token"}`,
			}
			tokenCalls := 0
			resourceCalls := 0
			fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
				payload := test.payload
				switch request.URL.Host {
				case "oauth2.googleapis.com":
					tokenCalls++
					if request.URL.Path != "/token" || request.Method != http.MethodPost || request.Header.Get("Authorization") != "" {
						t.Fatal("token exchange used the wrong destination, method, or recursive authorization")
					}
					if err := request.ParseForm(); err != nil || request.PostForm.Get("refresh_token") != "refresh" {
						t.Fatal("token exchange did not use saved authorized-user credentials")
					}
					payload = `{"access_token":"resource-token","token_type":"Bearer","expires_in":3600}`
				default:
					resourceCalls++
					canonicalEndpoint := request.URL.Host == test.host && request.URL.Path == test.path
					if !canonicalEndpoint || request.Method != http.MethodGet || request.Header.Get("Authorization") != "Bearer resource-token" {
						t.Fatal("resource request did not use the canonical provider endpoint and refreshed saved credentials")
					}
					if request.URL.Query().Get("pageSize") != "3" || request.URL.Query().Get("pageToken") != "opaque+page" {
						t.Fatal("Google page arguments were not preserved")
					}
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(payload)),
				}, nil
			}
			body, _ := json.Marshal(map[string]any{
				"scope":     "Workspace",
				"kind":      test.kind,
				"parent":    test.parent,
				"pageSize":  3,
				"pageToken": "opaque+page",
			})
			response, result := fixture.request(t, string(body))
			nextPage := result.NextPageToken != nil && *result.NextPageToken == "next"
			if response.Code != http.StatusOK || tokenCalls != 1 || resourceCalls != 1 || !nextPage {
				t.Fatalf(
					"one authenticated provider page failed: HTTP %d, tokenCalls=%d, resourceCalls=%d: %s",
					response.Code,
					tokenCalls,
					resourceCalls,
					response.Body.String(),
				)
			}
			if test.id != "" && (len(result.Items) != 1 || result.Items[0].Id != test.id) {
				t.Fatal("canonical resource identity changed")
			}
			if test.kind == "templates" && (result.Unreachable == nil || len(*result.Unreachable) != 1) {
				t.Fatal("partial provider availability was hidden")
			}
		})
	}
}

func TestGuardrailDiscoveryRejectsUnsafeCredentialConfigurations(t *testing.T) {
	payloads := []string{
		`{"type":"external_account","credential_source":{"url":"http://169.254.169.254/"}}`,
		`{"type":"impersonated_service_account","source_credentials":{}}`,
		`{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","token_uri":"http://127.0.0.1/steal"}`,
		`{"type":"service_account","client_email":"test@example.com","private_key":"secret","token_uri":"https://oauth2.googleapis.com/token?redirect=evil"}`,
		`{"type":"authorized_user","web":{"auth_uri":"https://evil.example/"}}`,
		`{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","universe_domain":"evil.example"}`,
	}
	for _, payload := range payloads {
		fixture := newGuardrailDiscoveryFixture(t, "ModelArmor", false, false, true)
		fixture.credentials = map[string]any{"credentials.json": payload}
		response, _ := fixture.request(t, `{"scope":"Workspace","kind":"projects"}`)
		unsupported := strings.Contains(response.Body.String(), "unsupported_credentials")
		if response.Code != http.StatusServiceUnavailable || len(fixture.upstream.calls) != 0 || !unsupported {
			t.Fatal("unsafe credentials were not rejected before network access")
		}
		if strings.Contains(response.Body.String(), "steal") || strings.Contains(response.Body.String(), "private_key") {
			t.Fatal("credential details leaked into the response")
		}
	}
}

func TestGuardrailDiscoveryErrorsAreSanitizedAndNeverRetried(t *testing.T) {
	codes := []int{
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusTooManyRequests,
		http.StatusServiceUnavailable,
		http.StatusFound,
	}
	for _, code := range codes {
		fixture := newGuardrailDiscoveryFixture(t, "Bedrock", false, false, true)
		fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: code,
				Header:     http.Header{"Location": []string{"https://evil.example/steal"}},
				Body:       io.NopCloser(strings.NewReader(`{"message":"RAW_PROVIDER_SECRET"}`)),
			}, nil
		}
		response, _ := fixture.request(t, `{"scope":"Workspace","kind":"guardrails"}`)
		want := code
		if code == http.StatusServiceUnavailable || code == http.StatusFound {
			want = http.StatusBadGateway
		}
		if response.Code != want || len(fixture.upstream.calls) != 1 || strings.Contains(response.Body.String(), "RAW_PROVIDER_SECRET") {
			t.Fatalf("error mapping leaked or replayed: upstream=%d HTTP=%d calls=%d", code, response.Code, len(fixture.upstream.calls))
		}
	}
	fixture := newGuardrailDiscoveryFixture(t, "ModelArmor", false, false, true)
	fixture.credentials = map[string]any{
		"credentials.json": `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"revoked"}`,
	}
	fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadRequest,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"error":"invalid_grant","error_description":"RAW_PROVIDER_SECRET"}`)),
		}, nil
	}
	response, _ := fixture.request(t, `{"scope":"Workspace","kind":"projects"}`)
	authenticationFailed := strings.Contains(response.Body.String(), "provider_authentication_failed")
	leaked := strings.Contains(response.Body.String(), "RAW_PROVIDER_SECRET")
	if response.Code != http.StatusUnauthorized || len(fixture.upstream.calls) != 1 || !authenticationFailed || leaked {
		t.Fatalf("revoked OAuth credential was not safely identified: HTTP %d calls=%d", response.Code, len(fixture.upstream.calls))
	}
}

func TestGuardrailDiscoveryHonorsCallerDeadline(t *testing.T) {
	fixture := newGuardrailDiscoveryFixture(t, "Bedrock", false, false, true)
	fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
		deadline, ok := request.Context().Deadline()
		if !ok || time.Until(deadline) > 15*time.Second {
			t.Fatal("provider call has no bounded request deadline")
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	}
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/guardrails/connections/saved/resources",
		strings.NewReader(`{"scope":"Workspace","kind":"guardrails"}`),
	).WithContext(ctx)
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response := httptest.NewRecorder()
	fixture.router.ServeHTTP(response, request)
	if response.Code != http.StatusGatewayTimeout || len(fixture.upstream.calls) != 1 {
		t.Fatalf("caller cancellation was not propagated: HTTP %d calls=%d", response.Code, len(fixture.upstream.calls))
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("test did not reach caller deadline")
	}
}

func TestGuardrailDiscoveryServiceAccountSignsTokenBeforeResourceRequest(t *testing.T) {
	fixture := newGuardrailDiscoveryFixture(t, "ModelArmor", false, false, true)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	payload, err := json.Marshal(map[string]string{
		"type":         "service_account",
		"client_email": "guardrail-reader@demo-project.iam.gserviceaccount.com",
		"private_key":  string(privateKey),
		"token_uri":    "https://oauth2.googleapis.com/token",
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.credentials = map[string]any{"credentials.json": string(payload)}
	tokenCalls, resourceCalls := 0, 0
	fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
		body := `{"locations":[]}`
		switch request.URL.Host {
		case "oauth2.googleapis.com":
			tokenCalls++
			err := request.ParseForm()
			grantType := request.PostForm.Get("grant_type")
			if err != nil || grantType != "urn:ietf:params:oauth:grant-type:jwt-bearer" || request.PostForm.Get("assertion") == "" {
				t.Fatal("service account did not produce a signed JWT exchange")
			}
			body = `{"access_token":"service-token","token_type":"Bearer","expires_in":3600}`
		default:
			resourceCalls++
			if request.URL.Host != "modelarmor.googleapis.com" || request.Header.Get("Authorization") != "Bearer service-token" {
				t.Fatal("service account resource request used the wrong endpoint or token")
			}
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}
	response, _ := fixture.request(t, `{"scope":"Workspace","kind":"locations","parent":"projects/demo-project"}`)
	if response.Code != http.StatusOK || tokenCalls != 1 || resourceCalls != 1 {
		t.Fatalf("service account discovery failed: HTTP %d tokenCalls=%d resourceCalls=%d", response.Code, tokenCalls, resourceCalls)
	}
}

func TestGuardrailDiscoveryRejectsUnsupportedOrInjectedParentsBeforeSecrets(t *testing.T) {
	for _, provider := range []api.GuardrailProvider{"ModelArmor", "Bedrock", "Webhook", "OpenAI"} {
		bodies := []string{
			`{"scope":"Workspace","kind":"locations","parent":"https://evil.example/"}`,
			`{"scope":"Workspace","kind":"templates","parent":"projects/demo-project/locations/us-central1?host=evil"}`,
			`{"scope":"Workspace","kind":"locations","parent":"projects/../../metadata"}`,
			`{"scope":"Workspace","kind":"versions","parent":"http://169.254.169.254/"}`,
		}
		for _, body := range bodies {
			fixture := newGuardrailDiscoveryFixture(t, provider, false, false, true)
			response, _ := fixture.request(t, body)
			if response.Code != http.StatusBadRequest || len(fixture.secretPaths) != 0 || len(fixture.upstream.calls) != 0 {
				t.Fatalf("invalid parent/provider reached secrets or network: provider=%s HTTP=%d", provider, response.Code)
			}
		}
	}
}

func TestGuardrailDiscoveryMissingAWSKeysNeverUsesAmbientIdentity(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "ambient-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
	fixture := newGuardrailDiscoveryFixture(t, "Bedrock", false, false, true)
	fixture.credentials = map[string]any{}
	response, _ := fixture.request(t, `{"scope":"Workspace","kind":"guardrails"}`)
	missingCredentials := strings.Contains(response.Body.String(), "credentials_unavailable")
	if response.Code != http.StatusServiceUnavailable || len(fixture.upstream.calls) != 0 || !missingCredentials {
		t.Fatal("missing saved AWS credentials did not stop before ambient discovery")
	}
}

func TestGuardrailDiscoveryRejectsMalformedProviderProjects(t *testing.T) {
	payloads := []string{
		`null`,
		`{"projects":[null]}`,
		`{"projects":[{"state":"ACTIVE","projectId":"../secret"}]}`,
		`not-json`,
	}
	for _, payload := range payloads {
		fixture := newGuardrailDiscoveryFixture(t, "ModelArmor", false, false, true)
		fixture.upstream.respond = func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{},
				Body:       io.NopCloser(strings.NewReader(payload)),
			}, nil
		}
		result := gatewayapi.GuardrailResourceDiscovery{
			Items: []gatewayapi.GuardrailDiscoveredResource{},
		}
		apiErr := discoverGoogleProjects(t.Context(), fixture.service.outboundHTTP, gatewayapi.GuardrailResourceDiscoveryInput{
			Kind: gatewayapi.GuardrailResourceDiscoveryInputKindProjects,
		}, 50, &result)
		if apiErr == nil || apiErr.Status != http.StatusBadGateway || len(fixture.upstream.calls) != 1 {
			t.Fatal("malformed provider projects were not safely rejected")
		}
	}
}

func TestGuardrailDiscoveryWorkspaceHeaderMustMatchClaims(t *testing.T) {
	fixture := newGuardrailDiscoveryFixture(t, "Bedrock", false, false, true)
	ctx := context.WithValue(t.Context(), authContextKey{}, requestAuth{
		claims: &gatewayClaims{
			UserID:         testUserID,
			OrganizationID: testOrganizationID,
			WorkspaceID:    "different-workspace",
		},
	})
	ctx = context.WithValue(ctx, gatewayapi.GatewayBearerScopes, []string{"guardrail_connection.read"}) //nolint:staticcheck
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/guardrails/connections/saved/resources",
		strings.NewReader(`{"scope":"Workspace","kind":"guardrails"}`),
	).WithContext(ctx)
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response := httptest.NewRecorder()
	fixture.service.DiscoverGuardrailConnectionResources(response, request, "saved", gatewayapi.DiscoverGuardrailConnectionResourcesParams{})
	if response.Code != http.StatusForbidden || len(fixture.secretPaths) != 0 || len(fixture.upstream.calls) != 0 {
		t.Fatal("mismatched bearer and header scope reached saved credentials")
	}
}
