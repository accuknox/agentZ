package gateway

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type delegationQueries struct {
	sandboxQueries
	grant   gatewaydb.GatewayGetDelegationGrantRow
	revoked bool
}

func (q *delegationQueries) GatewayGetDelegationGrant(_ context.Context, arg gatewaydb.GatewayGetDelegationGrantParams) (gatewaydb.GatewayGetDelegationGrantRow, error) {
	if q.revoked || arg.ID != q.grant.ID || arg.ClientID != q.grant.ClientID || arg.UserID != q.grant.UserID {
		return gatewaydb.GatewayGetDelegationGrantRow{}, pgx.ErrNoRows
	}
	return q.grant, nil
}

func (q *delegationQueries) GatewayListDelegationRedirects(context.Context) ([][]string, error) {
	return [][]string{{"https://app.example/callback"}}, nil
}

func (q *delegationQueries) GatewayCheckDelegationMCPSession(context.Context, gatewaydb.GatewayCheckDelegationMCPSessionParams) (bool, error) {
	return false, nil
}

type delegationTokenCase struct {
	name   string
	mutate func(*delegationClaims)
	typ    string
	want   int
}

func TestDelegatedAccessRequiresLiveGrantAndAccessToken(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{grant: gatewaydb.GatewayGetDelegationGrantRow{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		Scopes:    []string{"inference:use", "mcp:use"},
		Resources: []string{issuer + "/api/inference/v1", issuer + "/api/mcp"},
		Selection: []byte(`{"models":[],"mcp":[]}`),
	}}
	service := sandboxTestService(t, queries)
	service.cfg.ExternalJWTIssuer = issuer
	service.delegationRequests = make(chan struct{}, 64)
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	cases := []delegationTokenCase{
		{name: "access token", typ: "at+jwt", want: http.StatusOK},
		{name: "ID token", typ: "JWT", want: http.StatusUnauthorized},
		{name: "wrong issuer", typ: "at+jwt", mutate: func(c *delegationClaims) { c.Issuer = "https://other.example" }, want: http.StatusUnauthorized},
		{name: "MCP audience", typ: "at+jwt", mutate: func(c *delegationClaims) { c.Audience = jwt.ClaimStrings{issuer + "/api/mcp"} }, want: http.StatusUnauthorized},
		{name: "expired", typ: "at+jwt", mutate: func(c *delegationClaims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute)) }, want: http.StatusUnauthorized},
		{name: "no expiry", typ: "at+jwt", mutate: func(c *delegationClaims) { c.ExpiresAt = nil }, want: http.StatusUnauthorized},
		{name: "future issued", typ: "at+jwt", mutate: func(c *delegationClaims) { c.IssuedAt = jwt.NewNumericDate(time.Now().Add(time.Hour)) }, want: http.StatusUnauthorized},
		{name: "no grant", typ: "at+jwt", mutate: func(c *delegationClaims) { c.GrantID = "" }, want: http.StatusUnauthorized},
		{name: "other client", typ: "at+jwt", mutate: func(c *delegationClaims) { c.ClientID = "client-2" }, want: http.StatusForbidden},
		{name: "other user", typ: "at+jwt", mutate: func(c *delegationClaims) { c.Subject = "user-2" }, want: http.StatusForbidden},
		{name: "scope widening", typ: "at+jwt", mutate: func(c *delegationClaims) { c.Scope += " admin" }, want: http.StatusForbidden},
		{name: "missing scope", typ: "at+jwt", mutate: func(c *delegationClaims) { c.Scope = "openid" }, want: http.StatusForbidden},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			claims := delegationClaims{
				RegisteredClaims: jwt.RegisteredClaims{
					Issuer: issuer, Subject: testUserID, Audience: jwt.ClaimStrings{issuer + "/api/inference/v1"},
					ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)), IssuedAt: jwt.NewNumericDate(time.Now()),
				},
				ClientID: "client-1", GrantID: "grant-1", Scope: "inference:use",
			}
			if test.mutate != nil {
				test.mutate(&claims)
			}
			token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
			token.Header["typ"] = test.typ
			signed, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/api/inference/v1/models", nil)
			request.Header.Set("Authorization", "Bearer "+signed)
			response := httptest.NewRecorder()
			service.handleDelegatedRequest(response, request)
			if response.Code != test.want {
				t.Fatalf("status %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			if test.want == http.StatusOK {
				// ES256's final Base64 digit has four unused bits. Changing
				// those bits must not create a second accepted token string.
				alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
				last := strings.IndexByte(alphabet, signed[len(signed)-1])
				request.Header.Set("Authorization", "Bearer "+signed[:len(signed)-1]+string(alphabet[last+1]))
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				if response.Code != http.StatusUnauthorized {
					t.Fatalf("noncanonical token admitted: %d", response.Code)
				}
				request.Header.Set("Authorization", "Bearer "+signed)
				queries.revoked = true
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				queries.revoked = false
				if response.Code != http.StatusForbidden {
					t.Fatalf("revoked JWT admitted: %d", response.Code)
				}
			}
			if test.want != http.StatusOK {
				var body openAIError
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error.Message == "" {
					t.Fatalf("missing OpenAI error: %s", response.Body.String())
				}
			}
		})
	}
}

func TestDelegationRechecksResourceIdentityAndPermissions(t *testing.T) {
	ctx := context.Background()
	namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, testWorkspaceID)
	queries := &delegationQueries{sandboxQueries: sandboxQueries{
		workspace:   gatewaydb.Workspace{ID: testWorkspaceID, OrganizationID: testOrganizationID, State: gatewaydb.WorkspaceStateReady},
		permissions: []gatewaydb.GatewayResolvePermissionsRow{{Active: true, Superadmin: true}},
	}}
	service := sandboxTestService(t, queries)
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: namespace, UID: types.UID("provider-original")},
		Spec:       agentzv1alpha1.InferenceProviderSpec{Models: []agentzv1alpha1.InferenceModel{{ID: "model"}}},
		Status:     agentzv1alpha1.InferenceProviderStatus{State: agentzv1alpha1.InferenceProviderStateReady},
	}
	objects := []ctrlclient.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace, Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: namespace}}},
		provider,
	}
	for _, object := range objects {
		if err := service.k8sClient.Create(ctx, object); err != nil {
			t.Fatal(err)
		}
	}
	catalog, err := service.delegationCatalog(ctx, testUserID, testOrganizationID, testWorkspaceID)
	if err != nil || len(catalog.Models) != 1 {
		t.Fatalf("catalog: %#v, %v", catalog, err)
	}
	selection, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	queries.grant = gatewaydb.GatewayGetDelegationGrantRow{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		OrganizationID: pgtype.Text{String: testOrganizationID, Valid: true}, Selection: selection,
	}
	claims := delegationClaims{ClientID: "client-1", GrantID: "grant-1"}
	claims.Subject = testUserID
	if _, _, err := service.checkDelegation(ctx, claims); err != nil {
		t.Fatal(err)
	}
	queries.permissions[0].Superadmin = false
	if _, _, err := service.checkDelegation(ctx, claims); err == nil {
		t.Fatal("permission removal did not invalidate the grant")
	}
	queries.permissions[0].Superadmin = true
	if err := service.k8sClient.Delete(ctx, provider); err != nil {
		t.Fatal(err)
	}
	provider.ResourceVersion = ""
	provider.UID = "provider-replacement"
	if err := service.k8sClient.Create(ctx, provider); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.checkDelegation(ctx, claims); err == nil {
		t.Fatal("replacement provider inherited old consent")
	}
}

func TestDelegationReadinessRequiresCurrentAcceptedProjection(t *testing.T) {
	ctx := context.Background()
	service := sandboxTestService(t, &delegationQueries{})
	for _, add := range []func(*runtime.Scheme) error{gwv1.Install, agw.Install} {
		if err := add(service.k8sClient.Scheme()); err != nil {
			t.Fatal(err)
		}
	}
	service.cfg.DelegationNamespace = "private"
	grant := gatewaydb.GatewayGetDelegationGrantRow{ID: "grant-1", Selection: []byte(`{"models":[],"mcp":[]}`)}
	hash := sha256.Sum256(grant.Selection)
	metadata := metav1.ObjectMeta{Name: "d-grant-1-model-0", Namespace: "private", Generation: 2, Annotations: map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", hash)}}
	route := &gwv1.HTTPRoute{ObjectMeta: metadata, Status: gwv1.HTTPRouteStatus{RouteStatus: gwv1.RouteStatus{Parents: []gwv1.RouteParentStatus{{
		ParentRef: gwv1.ParentReference{Name: "delegations"}, ControllerName: "agentgateway.dev/agentgateway",
		Conditions: []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 2}, {Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 2}},
	}}}}}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata, Status: agw.AgentgatewayBackendStatus{Conditions: []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 1}}}}
	for _, object := range []ctrlclient.Object{route, backend} {
		if err := service.k8sClient.Create(ctx, object); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.delegationReady(ctx, grant, route.Name, false, 0); err == nil {
		t.Fatal("stale backend status was accepted")
	}
	backend.Status.Conditions[0].ObservedGeneration = 2
	if err := service.k8sClient.Update(ctx, backend); err != nil {
		t.Fatal(err)
	}
	if err := service.delegationReady(ctx, grant, route.Name, false, 0); err != nil {
		t.Fatal(err)
	}
	grant.Selection = []byte(`{"models":[{}],"mcp":[]}`)
	if err := service.delegationReady(ctx, grant, route.Name, false, 0); err == nil {
		t.Fatal("different selection was accepted")
	}
}

func TestDelegationCORSRejectsUnregisteredOrigins(t *testing.T) {
	service := sandboxTestService(t, &delegationQueries{})
	service.delegationRequests = make(chan struct{}, 64)
	called := false
	handler := service.delegationCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusOK) }))
	for _, origin := range []string{"https://app.example", "https://app.example.evil", "null"} {
		called = false
		request := httptest.NewRequest(http.MethodOptions, "/api/inference/v1/models", strings.NewReader(""))
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if origin == "https://app.example" {
			if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != origin || response.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatalf("invalid browser CORS response: %#v", response.Result())
			}
		} else if response.Code != http.StatusForbidden || called {
			t.Fatalf("unregistered origin admitted: %q", origin)
		}
	}
}

type delegationInferenceCase struct {
	name, body string
	responses  bool
	allowed    bool
}

func TestDelegatedInferenceRejectsProviderResourceBypasses(t *testing.T) {
	for _, test := range []delegationInferenceCase{
		{"chat", `{"model":"selected","messages":[{"role":"user","content":"hi"}]}`, false, true},
		{"responses", `{"model":"selected","store":false,"input":"hi"}`, true, true},
		{"explicit previous message", `{"model":"selected","store":false,"input":[{"type":"message","id":"msg-inline","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`, true, true},
		{"implicit item reference", `{"model":"selected","store":false,"input":[{"id":"msg-private"}]}`, true, false},
		{"case sensitive implicit reference", `{"model":"selected","store":false,"input":[{"id":"msg-private","ID":""}]}`, true, false},
		{"inline audio", `{"model":"selected","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"YQ==","format":"wav"}}]}],"audio":{"voice":"alloy","format":"wav"}}`, false, true},
		{"hosted chat search", `{"model":"selected","web_search_options":{}}`, false, false},
		{"case sensitive hosted search", `{"model":"selected","web_search_options":{},"WEB_SEARCH_OPTIONS":null}`, false, false},
		{"stored chat audio", `{"model":"selected","messages":[{"role":"assistant","audio":{"id":"audio-private"}}]}`, false, false},
		{"case sensitive stored audio", `{"model":"selected","messages":[{"role":"assistant","audio":{"id":"audio-private"},"AUDIO":null}]}`, false, false},
		{"inline function file", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_file","file_data":"data:application/pdf;base64,YQ=="}]}]}`, true, true},
		{"case sensitive store", `{"model":"selected","store":true,"STORE":false}`, false, false},
		{"case sensitive background", `{"model":"selected","store":false,"background":true,"BACKGROUND":false}`, true, false},
		{"duplicate store", `{"model":"selected","store":true,"store":false}`, false, false},
		{"escaped duplicate store", `{"model":"selected","store":true,"\u0073tore":false}`, false, false},
		{"case sensitive hosted tool", `{"model":"selected","tools":[{"type":"file_search","TYPE":"function"}]}`, false, false},
		{"chat unrelated input", `{"model":"selected","messages":[{"content":[{"type":"file","file":{"file_id":"file-private"}}]}],"input":[]}`, false, false},
		{"case sensitive message content", `{"model":"selected","messages":[{"content":[{"file":{"file_id":"file-private","FILE_ID":""}}],"CONTENT":"ignored"}]}`, false, false},
		{"duplicate nested file", `{"model":"selected","messages":[{"content":[{"file":{"file_id":"file-private","file_id":""}}]}]}`, false, false},
		{"duplicate response content", `{"model":"selected","store":false,"input":[{"content":[{"file_id":"file-private"}],"content":[]}]}`, true, false},
		{"response function file", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_file","file_id":"file-private"}]}]}`, true, false},
		{"response function image", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_image","file_id":"file-private"}]}]}`, true, false},
		{"response screenshot", `{"model":"selected","store":false,"input":[{"type":"computer_call_output","output":{"type":"computer_screenshot","file_id":"file-private"}}]}`, true, false},
		{"case sensitive reference", `{"model":"selected","store":false,"input":[{"type":"item_reference","TYPE":"message","id":"msg-private"}]}`, true, false},
		{"duplicate response input", `{"model":"selected","store":false,"input":[{"type":"item_reference","id":"msg-private"}],"input":[]}`, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			model, err := delegatedInferenceModel([]byte(test.body), test.responses)
			if (err == nil) != test.allowed {
				t.Fatalf("allowed %v, want %v: %v", err == nil, test.allowed, err)
			}
			if test.allowed && model != "selected" {
				t.Fatalf("model %q", model)
			}
		})
	}
}

func TestDelegationMCPExpressionsFitNativeLimits(t *testing.T) {
	selected := gatewayapi.DelegationMCP{Id: "mcp-selected", Prompts: []string{"explain"}, Resources: []string{"test://resource"}}
	for index := range 2000 {
		selected.Tools = append(selected.Tools, fmt.Sprintf("tool-%04d-%s", index, strings.Repeat("x", 40)))
	}
	expressions, err := delegationMCPExpressions(selected)
	if err != nil {
		t.Fatal(err)
	}
	if len(expressions) < 3 || len(expressions) > 256 {
		t.Fatalf("native expression count: %d", len(expressions))
	}
	var tools []string
	for _, expression := range expressions {
		if len(expression) > 16384 {
			t.Fatalf("native expression length: %d", len(expression))
		}
		if !strings.HasPrefix(string(expression), "has(mcp.tool)") {
			continue
		}
		_, list, ok := strings.Cut(string(expression), " in ")
		if !ok {
			t.Fatalf("missing allowlist: %s", expression)
		}
		var values []string
		if err := json.Unmarshal([]byte(list), &values); err != nil {
			t.Fatal(err)
		}
		tools = append(tools, values...)
	}
	if !slices.Equal(tools, selected.Tools) {
		t.Fatal("splitting lost, widened, or reordered capabilities")
	}
	selected.Resources = []string{strings.Repeat("x", 2501)}
	if _, err := delegationMCPExpressions(selected); err == nil {
		t.Fatal("unprojectable capability admitted")
	}
}

func TestDelegationCORSIsBoundedBeforeOriginLookup(t *testing.T) {
	service := sandboxTestService(t, &delegationQueries{})
	service.delegationRequests = make(chan struct{}, 1)
	service.delegationRequests <- struct{}{}
	handler := service.delegationCORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("request admitted while busy")
	}))
	request := httptest.NewRequest(http.MethodOptions, "/api/mcp", nil)
	request.Header.Set("Origin", "https://app.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d", response.Code)
	}
}

func TestDelegatedMCPUsesExactMethodAndRejectsDuplicates(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{grant: gatewaydb.GatewayGetDelegationGrantRow{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		Scopes: []string{"mcp:use"}, Resources: []string{issuer + "/api/mcp"},
		Selection: []byte(`{"models":[],"mcp":[]}`),
	}}
	service := sandboxTestService(t, queries)
	service.cfg.ExternalJWTIssuer = issuer
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	claims := delegationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: testUserID, Audience: jwt.ClaimStrings{issuer + "/api/mcp"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)), IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		ClientID: "client-1", GrantID: "grant-1", Scope: "mcp:use",
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["typ"] = "at+jwt"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","METHOD":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tasks/get","METHOD":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","method":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","\u006dethod":"ping"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+signed)
		response := httptest.NewRecorder()
		service.handleDelegatedRequest(response, request)
		if strings.Contains(body, `"METHOD"`) {
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":-32601`) {
				t.Fatalf("restricted method passed: %d %s", response.Code, response.Body.String())
			}
		} else if response.Code != http.StatusBadRequest {
			t.Fatalf("duplicate method passed: %d %s", response.Code, response.Body.String())
		}
	}
}
