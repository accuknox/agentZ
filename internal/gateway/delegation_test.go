package gateway

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
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
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/sync/semaphore"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type delegationQueries struct {
	sandboxQueries
	grant          gatewaydb.DelegationGrant
	revoked        bool
	err            error
	sessionErr     error
	mcpSession     string
	permissionsErr error
}

func (q *delegationQueries) GatewayGetDelegationGrant(_ context.Context, arg gatewaydb.GatewayGetDelegationGrantParams) (gatewaydb.DelegationGrant, error) {
	if q.revoked || arg.ID != q.grant.ID || arg.ClientID != q.grant.ClientID || arg.UserID != q.grant.UserID {
		return gatewaydb.DelegationGrant{}, pgx.ErrNoRows
	}
	if arg.Origin != "" && arg.Origin != "https://app.example" {
		return gatewaydb.DelegationGrant{}, pgx.ErrNoRows
	}
	return q.grant, q.err
}

func (q *delegationQueries) GatewayCheckDelegationOrigin(_ context.Context, origin string) (bool, error) {
	return origin == "https://app.example" || origin == "https://other.example", q.err
}

func (q *delegationQueries) GatewayCheckDelegationSession(context.Context, gatewaydb.GatewayCheckDelegationSessionParams) (bool, error) {
	return false, q.sessionErr
}

func (q *delegationQueries) GatewayCheckDelegationMCPSession(_ context.Context, arg gatewaydb.GatewayCheckDelegationMCPSessionParams) (bool, error) {
	return q.mcpSession != "" && q.mcpSession == arg.ID && arg.GrantID == q.grant.ID, q.sessionErr
}

func (q *delegationQueries) GatewaySaveDelegationMCPSession(_ context.Context, arg gatewaydb.GatewaySaveDelegationMCPSessionParams) (int64, error) {
	q.mcpSession = arg.ID
	return 1, nil
}

func (q *delegationQueries) GatewayDeleteDelegationMCPSession(_ context.Context, arg gatewaydb.GatewayDeleteDelegationMCPSessionParams) error {
	if q.mcpSession == arg.ID && arg.GrantID == q.grant.ID {
		q.mcpSession = ""
	}
	return nil
}

func (q *delegationQueries) GatewayResolvePermissions(context.Context, gatewaydb.GatewayResolvePermissionsParams) ([]gatewaydb.GatewayResolvePermissionsRow, error) {
	return q.permissions, q.permissionsErr
}

type delegationUpstream struct {
	response *http.Response
	request  *http.Request
}

func (u *delegationUpstream) RoundTrip(r *http.Request) (*http.Response, error) {
	u.request = r
	return u.response, nil
}

type delegationTokenCase struct {
	name   string
	origin string
	mutate func(*authorization.DelegationClaims)
	typ    string
	want   int
}

type delegationCORSCase struct {
	name    string
	path    string
	origins []string
	method  string
	headers string
	want    int
}

type delegationMCPSessionStep struct {
	method, body, session string
	upstreamStatus, want  int
}

func TestDelegatedAccessRequiresLiveGrantAndAccessToken(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{grant: gatewaydb.DelegationGrant{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		Scopes:    []string{"inference:use", "mcp:use", "offline_access"},
		Resources: []string{issuer + "/api/inference/v1", issuer + "/api/mcp"},
		Selection: []byte(`{"models":[],"mcp":[]}`),
	}}
	service := sandboxTestService(t, queries)
	service.cfg.ExternalJWTIssuer = issuer
	service.delegationBodies = semaphore.NewWeighted(128 << 20)
	service.delegationRequests = make(chan struct{}, 64)
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	cases := []delegationTokenCase{
		{name: "access token", typ: "at+jwt", want: http.StatusOK},
		{name: "client origin", origin: "https://app.example", typ: "at+jwt", want: http.StatusOK},
		{name: "another registered client's origin", origin: "https://other.example", typ: "at+jwt", want: http.StatusForbidden},
		{name: "expired online session", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.SessionID = "expired" }, want: http.StatusForbidden},
		{name: "offline access survives browser expiry", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.SessionID = "expired"; c.Scope += " offline_access" }, want: http.StatusOK},
		{name: "ID token", typ: "JWT", want: http.StatusUnauthorized},
		{name: "wrong issuer", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.Issuer = "https://other.example" }, want: http.StatusUnauthorized},
		{name: "MCP audience", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.Audience = jwt.ClaimStrings{issuer + "/api/mcp"} }, want: http.StatusUnauthorized},
		{name: "expired", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) {
			c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
		}, want: http.StatusUnauthorized},
		{name: "no expiry", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.ExpiresAt = nil }, want: http.StatusUnauthorized},
		{name: "future issued", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.IssuedAt = jwt.NewNumericDate(time.Now().Add(time.Hour)) }, want: http.StatusUnauthorized},
		{name: "no grant", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.GrantID = "" }, want: http.StatusUnauthorized},
		{name: "other client", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.ClientID = "client-2" }, want: http.StatusForbidden},
		{name: "other user", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.Subject = "user-2" }, want: http.StatusForbidden},
		{name: "scope widening", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.Scope += " admin" }, want: http.StatusForbidden},
		{name: "missing scope", typ: "at+jwt", mutate: func(c *authorization.DelegationClaims) { c.Scope = "openid" }, want: http.StatusForbidden},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			claims := authorization.DelegationClaims{
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
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
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
				request.Header.Set("Authorization", "bearer "+signed)
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				if response.Code != http.StatusOK {
					t.Fatalf("case-insensitive bearer scheme rejected: %d", response.Code)
				}
				request.Header.Set("Authorization", "Bearer "+signed)
				queries.revoked = true
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				queries.revoked = false
				if response.Code != http.StatusForbidden {
					t.Fatalf("revoked JWT admitted: %d", response.Code)
				}
				// A dropped database connection is retryable, not revoked consent.
				queries.err = io.ErrUnexpectedEOF
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				queries.err = nil
				if response.Code != http.StatusServiceUnavailable {
					t.Fatalf("database outage reported as %d", response.Code)
				}
				queries.permissionsErr = io.ErrUnexpectedEOF
				response = httptest.NewRecorder()
				service.handleDelegatedRequest(response, request)
				queries.permissionsErr = nil
				if response.Code != http.StatusOK {
					t.Fatalf("empty grant depended on resource permissions: %d", response.Code)
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
		Spec:       agentzv1alpha1.InferenceProviderSpec{Kind: agentzv1alpha1.InferenceProviderKindOpenAI, OpenAI: &agentzv1alpha1.OpenAIProviderConfig{}, Models: []agentzv1alpha1.InferenceModel{{ID: "model"}}},
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
	catalog, err := service.delegationCatalog(ctx, testUserID, testOrganizationID, testWorkspaceID, false)
	if err != nil || len(catalog.Models) != 1 {
		t.Fatalf("catalog: %#v, %v", catalog, err)
	}
	connection := &agentzv1alpha1.MCPConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: namespace, UID: "mcp-original", Generation: 2},
		Spec:       agentzv1alpha1.MCPConnectionSpec{Endpoint: agentzv1alpha1.MCPConnectionEndpoint{URL: "https://mcp.example/mcp"}},
		Status: agentzv1alpha1.MCPConnectionStatus{
			ToolCatalogReady: true,
			Tools:            []agentzv1alpha1.MCPConnectionTool{{Name: "echo"}},
			Conditions:       []metav1.Condition{{Type: mcp.ConditionProbeHealthy, Status: metav1.ConditionTrue, ObservedGeneration: 1}},
		},
	}
	if err := service.k8sClient.Create(ctx, connection); err != nil {
		t.Fatal(err)
	}
	readinessChecks := []bool{false, true}
	for _, includeUnavailable := range readinessChecks {
		stale, err := service.delegationCatalog(ctx, testUserID, testOrganizationID, testWorkspaceID, includeUnavailable)
		if err != nil {
			t.Fatal(err)
		}
		if (len(stale.Mcp) == 1) != includeUnavailable {
			t.Fatalf("stale catalog included for new consent: includeUnavailable=%v, targets=%d", includeUnavailable, len(stale.Mcp))
		}
	}
	connection.Status.Conditions[0].ObservedGeneration = connection.Generation
	if err := service.k8sClient.Update(ctx, connection); err != nil {
		t.Fatal(err)
	}
	current, err := service.delegationCatalog(ctx, testUserID, testOrganizationID, testWorkspaceID, false)
	if err != nil || len(current.Mcp) != 1 {
		t.Fatalf("current MCP catalog: %v, %v", current.Mcp, err)
	}
	selection, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	queries.grant = gatewaydb.DelegationGrant{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		OrganizationID: pgtype.Text{String: testOrganizationID, Valid: true}, Selection: selection,
	}
	if err := service.checkDelegation(ctx, queries.grant, catalog); err != nil {
		t.Fatal(err)
	}
	queries.permissions[0].Superadmin = false
	if err := service.checkDelegation(ctx, queries.grant, catalog); err == nil {
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
	if err := service.checkDelegation(ctx, queries.grant, catalog); err == nil {
		t.Fatal("replacement provider inherited old consent")
	}
}

func TestDelegationReadinessRequiresCurrentAcceptedProjection(t *testing.T) {
	ctx := context.Background()
	service := sandboxTestService(t, &delegationQueries{})
	registrations := []func(*runtime.Scheme) error{gwv1.Install, agw.Install}
	for _, add := range registrations {
		if err := add(service.k8sClient.Scheme()); err != nil {
			t.Fatal(err)
		}
	}
	service.cfg.DelegationNamespace = "private"
	grant := gatewaydb.DelegationGrant{ID: "grant-1", Selection: []byte(`{"models":[],"mcp":[]}`)}
	hash := sha256.Sum256(grant.Selection)
	metadata := metav1.ObjectMeta{Name: "d-grant-1-model-0", Namespace: "private", Generation: 2, Annotations: map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", hash)}}
	route := &gwv1.HTTPRoute{ObjectMeta: metadata, Status: gwv1.HTTPRouteStatus{RouteStatus: gwv1.RouteStatus{Parents: []gwv1.RouteParentStatus{{
		ParentRef: gwv1.ParentReference{Name: "delegations"}, ControllerName: "agentgateway.dev/agentgateway",
		Conditions: []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 2}, {Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 2}},
	}}}}}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata, Status: agw.AgentgatewayBackendStatus{Conditions: []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 1}}}}
	objects := []ctrlclient.Object{route, backend}
	for _, object := range objects {
		if err := service.k8sClient.Create(ctx, object); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.delegationReady(ctx, grant, "private", "delegations", route.Name); err == nil {
		t.Fatal("stale backend status was accepted")
	}
	backend.Status.Conditions[0].ObservedGeneration = 2
	if err := service.k8sClient.Update(ctx, backend); err != nil {
		t.Fatal(err)
	}
	if err := service.delegationReady(ctx, grant, "private", "delegations", route.Name); err != nil {
		t.Fatal(err)
	}
	grant.Selection = []byte(`{"models":[{}],"mcp":[]}`)
	if err := service.delegationReady(ctx, grant, "private", "delegations", route.Name); err == nil {
		t.Fatal("different selection was accepted")
	}
}

func TestDelegatedInferenceUsesPrivateGateway(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{sandboxQueries: sandboxQueries{
		workspace:   gatewaydb.Workspace{ID: testWorkspaceID, OrganizationID: testOrganizationID, State: gatewaydb.WorkspaceStateReady},
		permissions: []gatewaydb.GatewayResolvePermissionsRow{{Active: true, Superadmin: true}},
	}}
	service := sandboxTestService(t, queries)
	registrations := []func(*runtime.Scheme) error{gwv1.Install, agw.Install}
	for _, add := range registrations {
		if err := add(service.k8sClient.Scheme()); err != nil {
			t.Fatal(err)
		}
	}
	namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, testWorkspaceID)
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: namespace, UID: "original"},
		Spec: agentzv1alpha1.InferenceProviderSpec{
			Kind: agentzv1alpha1.InferenceProviderKindOpenAI, OpenAI: &agentzv1alpha1.OpenAIProviderConfig{},
			Models: []agentzv1alpha1.InferenceModel{{ID: "model"}},
		},
		Status: agentzv1alpha1.InferenceProviderStatus{State: agentzv1alpha1.InferenceProviderStateReady},
	}
	objects := []ctrlclient.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace, Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: namespace}}},
		provider,
	}
	for _, object := range objects {
		if err := service.k8sClient.Create(t.Context(), object); err != nil {
			t.Fatal(err)
		}
	}
	selection, err := service.delegationCatalog(t.Context(), testUserID, testOrganizationID, testWorkspaceID, false)
	if err != nil || len(selection.Models) != 1 {
		t.Fatalf("catalog: %v, %v", selection, err)
	}
	encoded, err := json.Marshal(selection)
	if err != nil {
		t.Fatal(err)
	}
	queries.grant = gatewaydb.DelegationGrant{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		OrganizationID: pgtype.Text{String: testOrganizationID, Valid: true},
		Scopes:         []string{"inference:use"}, Resources: []string{issuer + "/api/inference/v1"}, Selection: encoded,
	}
	service.cfg.ExternalJWTIssuer = issuer
	service.cfg.DelegationNamespace = "private"
	service.cfg.DelegationGatewayURL = "http://private.example:8080"
	service.delegationBodies = semaphore.NewWeighted(128 << 20)
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	claims := authorization.DelegationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: testUserID, Audience: jwt.ClaimStrings{issuer + "/api/inference/v1"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)), IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		ClientID: "client-1", GrantID: "grant-1", Scope: "inference:use",
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["typ"] = "at+jwt"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	namespaces := []string{namespace, "private"}
	for _, ns := range namespaces {
		gateway := inference.GatewayName
		if ns == "private" {
			gateway = "delegations"
		}
		metadata := metav1.ObjectMeta{Name: "d-grant-1-model-0", Namespace: ns, Generation: 1,
			Annotations: map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", sha256.Sum256(encoded))}}
		conditions := []metav1.Condition{
			{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 1},
			{Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 1},
		}
		objects := []ctrlclient.Object{
			&gwv1.HTTPRoute{ObjectMeta: metadata, Status: gwv1.HTTPRouteStatus{RouteStatus: gwv1.RouteStatus{Parents: []gwv1.RouteParentStatus{{
				ParentRef: gwv1.ParentReference{Name: gwv1.ObjectName(gateway)}, ControllerName: "agentgateway.dev/agentgateway", Conditions: conditions,
			}}}}},
			&agw.AgentgatewayBackend{ObjectMeta: metadata, Status: agw.AgentgatewayBackendStatus{Conditions: conditions}},
		}
		for _, object := range objects {
			if err := service.k8sClient.Create(t.Context(), object); err != nil {
				t.Fatal(err)
			}
		}
	}
	upstream := &delegationUpstream{response: &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Access-Control-Allow-Origin":      {"*"},
			"Access-Control-Allow-Credentials": {"true"},
			"Access-Control-Expose-Headers":    {"X-Private-Header"},
		},
		Body: io.NopCloser(strings.NewReader(`{"choices":[]}`)),
	}}
	service.delegationTransport = upstream
	body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"Hello!"}]}`, selection.Models[0].Id)
	request := httptest.NewRequest(http.MethodPost, "/api/inference/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+signed)
	response := httptest.NewRecorder()
	response.Header().Set("Access-Control-Allow-Origin", "https://app.example")
	service.handleDelegatedRequest(response, request)
	if response.Code != http.StatusOK || upstream.request == nil {
		t.Fatalf("inference returned %d: %s", response.Code, response.Body.String())
	}
	expectedHeaders := map[string]string{
		"Access-Control-Allow-Origin":      "https://app.example",
		"Access-Control-Allow-Credentials": "",
		"Access-Control-Expose-Headers":    "",
	}
	for header, want := range expectedHeaders {
		if got := response.Header().Get(header); got != want {
			t.Errorf("upstream CORS header %s: got %q, want %q", header, got, want)
		}
	}
	if upstream.request.URL.Host != "private.example:8080" || upstream.request.URL.Path != "/delegations/grant-1/models/0/chat/completions" {
		t.Fatalf("inference bypassed the configured private gateway: %s", upstream.request.URL)
	}
	if err := service.k8sClient.Delete(t.Context(), &gwv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: "d-grant-1-model-0", Namespace: "private"}}); err != nil {
		t.Fatal(err)
	}
	upstream.request = nil
	request.Body = io.NopCloser(strings.NewReader(body))
	response = httptest.NewRecorder()
	service.handleDelegatedRequest(response, request)
	if response.Code != http.StatusServiceUnavailable || upstream.request != nil {
		t.Fatal("inference was forwarded before the private route was ready")
	}
}

func TestDelegationCORSMethodsHeadersAndMissingOrigins(t *testing.T) {
	queries := &delegationQueries{}
	service := sandboxTestService(t, queries)
	service.delegationRequests = make(chan struct{}, 64)
	called := false
	handler := service.delegationCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusUnauthorized)
	}))
	cases := []delegationCORSCase{
		{name: "native request", path: "/api/mcp", want: http.StatusUnauthorized},
		{name: "empty origin", path: "/api/mcp", origins: []string{""}, want: http.StatusForbidden},
		{name: "prefix spoof", path: "/api/inference/v1/models", origins: []string{"https://app.example.evil"}, method: "GET", want: http.StatusForbidden},
		{name: "opaque origin", path: "/api/mcp", origins: []string{"null"}, method: "POST", want: http.StatusForbidden},
		{name: "multiple origins", path: "/api/mcp", origins: []string{"https://app.example", "https://other.example"}, want: http.StatusForbidden},
		{name: "readable auth error", path: "/api/mcp", origins: []string{"https://app.example"}, want: http.StatusUnauthorized},
		{name: "MCP GET", path: "/api/mcp", origins: []string{"https://app.example"}, method: "GET", want: http.StatusNoContent},
		{name: "MCP DELETE", path: "/api/mcp", origins: []string{"https://app.example"}, method: "DELETE", want: http.StatusNoContent},
		{name: "MCP headers", path: "/api/mcp", origins: []string{"https://app.example"}, method: "POST", headers: "mcp-session-id,mcp-protocol-version,last-event-id", want: http.StatusNoContent},
		{name: "SDK headers", path: "/api/inference/v1/responses", origins: []string{"https://app.example"}, method: "POST", headers: "authorization,content-type,x-stainless-lang", want: http.StatusNoContent},
		{name: "models POST", path: "/api/inference/v1/models", origins: []string{"https://app.example"}, method: "POST", want: http.StatusForbidden},
		{name: "unknown route", path: "/api/inference/v1/unknown", origins: []string{"https://app.example"}, method: "POST", want: http.StatusForbidden},
		{name: "invalid header", path: "/api/mcp", origins: []string{"https://app.example"}, method: "POST", headers: "x bad", want: http.StatusForbidden},
		{name: "empty header entry", path: "/api/mcp", origins: []string{"https://app.example"}, method: "POST", headers: "authorization,", want: http.StatusForbidden},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			called = false
			method := http.MethodGet
			if test.method != "" {
				method = http.MethodOptions
			}
			request := httptest.NewRequest(method, test.path, nil)
			if test.origins != nil {
				request.Header["Origin"] = test.origins
			}
			request.Header.Set("Access-Control-Request-Method", test.method)
			request.Header.Set("Access-Control-Request-Headers", test.headers)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status %d, want %d", response.Code, test.want)
			}
			if called != (test.want == http.StatusUnauthorized) {
				t.Fatalf("resource handler called = %v", called)
			}
			if response.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("delegated access admitted browser credentials")
			}
			origin := ""
			if len(test.origins) == 1 && test.origins[0] == "https://app.example" {
				origin = test.origins[0]
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != origin {
				t.Fatalf("allowed origin = %q, want %q", got, origin)
			}
			if !strings.Contains(response.Header().Get("Vary"), "Origin") {
				t.Fatal("dynamic response did not vary on Origin")
			}
			if response.Code == http.StatusNoContent {
				allowed := response.Header().Get("Access-Control-Allow-Headers")
				if !strings.Contains(allowed, "Authorization") || strings.Contains(allowed, "*") {
					t.Fatalf("authorization must be explicitly allowed: %s", allowed)
				}
			}
		})
	}
	queries.err = pgx.ErrTxClosed
	request := httptest.NewRequest(http.MethodGet, "/api/mcp", nil)
	request.Header.Set("Origin", "https://app.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unavailable origin registry did not fail closed")
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

func TestEmptyDelegatedMCPDiscoveryAndRevocation(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{grant: gatewaydb.DelegationGrant{
		ID: "empty-grant", ClientID: "client", UserID: testUserID,
		Scopes: []string{"mcp:use"}, Resources: []string{issuer + "/api/mcp"},
		Selection: []byte(`{"models":[],"mcp":[]}`),
	}}
	service := sandboxTestService(t, queries)
	service.cfg.ExternalJWTIssuer = issuer
	service.delegationBodies = semaphore.NewWeighted(128 << 20)
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	token := jwt.NewWithClaims(jwt.SigningMethodES256, authorization.DelegationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: testUserID, Audience: jwt.ClaimStrings{issuer + "/api/mcp"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)), IssuedAt: jwt.NewNumericDate(time.Now()),
		}, ClientID: "client", GrantID: "empty-grant", Scope: "mcp:use",
	})
	token.Header["typ"] = "at+jwt"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+signed)
		service.handleDelegatedRequest(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "empty-grant-test", Version: "test"}, nil)
	session, err := client.Connect(ctx, &mcpsdk.StreamableClientTransport{Endpoint: server.URL + "/api/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if session.ID() != "" {
		t.Fatal("empty grant created MCP session state")
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil || tools == nil || len(tools.Tools) != 0 {
		t.Fatalf("tools: %v, %v", tools, err)
	}
	prompts, err := session.ListPrompts(ctx, nil)
	if err != nil || prompts == nil || len(prompts.Prompts) != 0 {
		t.Fatalf("prompts: %v, %v", prompts, err)
	}
	resources, err := session.ListResources(ctx, nil)
	if err != nil || resources == nil || len(resources.Resources) != 0 {
		t.Fatalf("resources: %v, %v", resources, err)
	}
	templates, err := session.ListResourceTemplates(ctx, nil)
	if err != nil || templates == nil || len(templates.ResourceTemplates) != 0 {
		t.Fatalf("templates: %v, %v", templates, err)
	}
	_, err = session.CallTool(ctx, &mcpsdk.CallToolParams{Name: "unselected", Arguments: map[string]any{}})
	if err == nil {
		t.Fatal("empty grant executed an unselected tool")
	}
	queries.revoked = true
	_, err = session.ListTools(ctx, nil)
	if err == nil || !strings.Contains(err.Error(), "Forbidden") {
		t.Fatalf("revoked discovery: %v", err)
	}
}

func TestDelegatedMCPTransportBoundary(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer := "https://agentz.example"
	queries := &delegationQueries{grant: gatewaydb.DelegationGrant{
		ID: "grant-1", ClientID: "client-1", UserID: testUserID,
		Scopes: []string{"mcp:use"}, Resources: []string{issuer + "/api/mcp"},
		Selection: []byte(`{"models":[],"mcp":[]}`),
	}}
	queries.workspace = gatewaydb.Workspace{ID: testWorkspaceID, OrganizationID: testOrganizationID, State: gatewaydb.WorkspaceStateReady}
	queries.permissions = []gatewaydb.GatewayResolvePermissionsRow{{Active: true, Superadmin: true}}
	queries.grant.OrganizationID = pgtype.Text{String: testOrganizationID, Valid: true}
	service := sandboxTestService(t, queries)
	namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, testWorkspaceID)
	connection := &agentzv1alpha1.MCPConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: namespace, UID: "mcp-original"},
		Spec:       agentzv1alpha1.MCPConnectionSpec{Endpoint: agentzv1alpha1.MCPConnectionEndpoint{URL: "https://mcp.example/mcp"}},
	}
	objects := []ctrlclient.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace, Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: namespace}}},
		connection,
	}
	for _, object := range objects {
		if err := service.k8sClient.Create(t.Context(), object); err != nil {
			t.Fatal(err)
		}
	}
	identity := sha256.Sum256([]byte(testWorkspaceID + "/" + string(connection.UID)))
	queries.grant.Selection, err = json.Marshal(gatewayapi.DelegationCatalog{Models: []gatewayapi.DelegationModel{}, Mcp: []gatewayapi.DelegationMCP{{
		Id: fmt.Sprintf("mcp-%x", identity[:16]), WorkspaceId: testWorkspaceID, Namespace: namespace,
		Connection: connection.Name, Uid: string(connection.UID), Tools: []string{"echo"}, Prompts: []string{}, Resources: []string{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	service.cfg.ExternalJWTIssuer = issuer
	service.delegationBodies = semaphore.NewWeighted(128 << 20)
	service.externalJWTKeyfunc = func(*jwt.Token) (any, error) { return &key.PublicKey, nil }
	claims := authorization.DelegationClaims{
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
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(strings.Repeat("x", (4<<20)+1)))
	request.ContentLength = -1
	request.Header.Set("Authorization", "Bearer "+signed)
	response := httptest.NewRecorder()
	service.handleDelegatedRequest(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized chunked body status %d", response.Code)
	}
	bodies := []string{
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","METHOD":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tasks/get","METHOD":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","method":"ping"}`,
		`{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","\u006dethod":"ping"}`,
	}
	for _, body := range bodies {
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+signed)
		response := httptest.NewRecorder()
		service.handleDelegatedRequest(response, request)
		if strings.Contains(body, `"METHOD"`) {
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":-32601`) {
				t.Fatalf("restricted method passed: %d %s", response.Code, response.Body.String())
			}
			continue
		}
		if response.Code != http.StatusBadRequest {
			t.Fatalf("duplicate method passed: %d %s", response.Code, response.Body.String())
		}
	}
	t.Run("session lookup failure is retryable", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		request.Header.Set("Authorization", "Bearer "+signed)
		request.Header.Set("Mcp-Session-Id", "session")
		response := httptest.NewRecorder()
		service.handleDelegatedRequest(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("unknown session returned %d", response.Code)
		}
		queries.sessionErr = io.ErrUnexpectedEOF
		defer func() { queries.sessionErr = nil }()
		request.Body = io.NopCloser(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		response = httptest.NewRecorder()
		service.handleDelegatedRequest(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("session database outage returned %d", response.Code)
		}
	})
	registrations := []func(*runtime.Scheme) error{gwv1.Install, agw.Install}
	for _, add := range registrations {
		if err := add(service.k8sClient.Scheme()); err != nil {
			t.Fatal(err)
		}
	}
	service.cfg.DelegationNamespace = "private"
	service.cfg.DelegationGatewayURL = "https://private.example"
	hash := sha256.Sum256(queries.grant.Selection)
	metadata := metav1.ObjectMeta{
		Name: "d-grant-1-mcp", Namespace: "private", Generation: 1,
		Annotations: map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", hash)},
	}
	conditions := []metav1.Condition{
		{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 1},
		{Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 1},
		{Type: "Attached", Status: metav1.ConditionTrue, ObservedGeneration: 1},
	}
	projections := []ctrlclient.Object{
		&gwv1.HTTPRoute{ObjectMeta: metadata, Status: gwv1.HTTPRouteStatus{RouteStatus: gwv1.RouteStatus{Parents: []gwv1.RouteParentStatus{{
			ParentRef: gwv1.ParentReference{Name: "delegations"}, ControllerName: "agentgateway.dev/agentgateway", Conditions: conditions,
		}}}}},
		&agw.AgentgatewayBackend{ObjectMeta: metadata, Status: agw.AgentgatewayBackendStatus{Conditions: conditions}},
		&gwv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{
			Name: "d-grant-1-mcp-0", Namespace: namespace, Generation: 1, Annotations: metadata.Annotations,
		}, Status: gwv1.HTTPRouteStatus{RouteStatus: gwv1.RouteStatus{Parents: []gwv1.RouteParentStatus{{
			ParentRef: gwv1.ParentReference{Name: gwv1.ObjectName(mcp.GatewayName)}, ControllerName: "agentgateway.dev/agentgateway", Conditions: conditions,
		}}}}},
		&agw.AgentgatewayBackend{ObjectMeta: metav1.ObjectMeta{
			Name: "d-grant-1-mcp-0", Namespace: namespace, Generation: 1, Annotations: metadata.Annotations,
		}, Status: agw.AgentgatewayBackendStatus{Conditions: conditions}},
		&agw.AgentgatewayPolicy{ObjectMeta: metav1.ObjectMeta{
			Name: "d-grant-1-mcp-0-auth", Namespace: namespace, Generation: 1, Annotations: metadata.Annotations,
		}, Status: gwv1.PolicyStatus{Ancestors: []gwv1.PolicyAncestorStatus{{
			AncestorRef: gwv1.ParentReference{Name: gwv1.ObjectName(mcp.GatewayName)}, ControllerName: "agentgateway.dev/agentgateway", Conditions: conditions,
		}}}},
	}
	for _, object := range projections {
		if err := service.k8sClient.Create(t.Context(), object); err != nil {
			t.Fatal(err)
		}
	}
	statuses := []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusFound}
	for _, status := range statuses {
		t.Run(fmt.Sprintf("upstream status %d keeps credentials private", status), func(t *testing.T) {
			upstream := &delegationUpstream{response: &http.Response{
				StatusCode: status, Body: io.NopCloser(strings.NewReader("private-credential")),
				Header:  http.Header{"X-Diagnostic": {"private-credential"}, "Location": {"https://other.example"}},
				Trailer: http.Header{"X-Diagnostic": {"private-credential"}},
			}}
			service.delegationTransport = upstream
			request := httptest.NewRequest(http.MethodPost, "/api/mcp?api_key=private-credential", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
			request.Header.Set("Authorization", "Bearer "+signed)
			request.Header.Set("Cookie", "private-credential")
			request.Header.Set("X-Api-Key", "private-credential")
			request.Header.Set("X-AgentZ-User-ID", "spoofed")
			response := httptest.NewRecorder()
			service.handleDelegatedRequest(response, request)
			want := status
			if status == http.StatusFound {
				want = http.StatusBadGateway
			}
			if response.Code != want || upstream.request == nil {
				t.Fatalf("upstream status %d returned %d", status, response.Code)
			}
			result := response.Result()
			wire := fmt.Sprint(result.Header, result.Trailer, response.Body.String())
			if strings.Contains(wire, "private-credential") || result.Header.Get("Location") != "" {
				t.Fatal("upstream diagnostics or redirect escaped to the app")
			}
			if upstream.request.URL.RawQuery != "" {
				t.Fatal("app query parameters reached the native gateway")
			}
			headers := []string{"Authorization", "Cookie", "X-Api-Key", "X-AgentZ-User-ID"}
			for _, header := range headers {
				if upstream.request.Header.Get(header) != "" {
					t.Fatalf("app %s reached the native gateway", header)
				}
			}
		})
	}
	t.Run("deleted session cannot be revived by upstream headers", func(t *testing.T) {
		steps := []delegationMCPSessionStep{
			{http.MethodPost, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`, "", http.StatusOK, http.StatusOK},
			{http.MethodDelete, "", "session", http.StatusAccepted, http.StatusAccepted},
			{http.MethodPost, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "", http.StatusOK, http.StatusOK},
			{http.MethodPost, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "session", http.StatusOK, http.StatusNotFound},
		}
		for _, step := range steps {
			service.delegationTransport = &delegationUpstream{response: &http.Response{
				StatusCode: step.upstreamStatus, Body: io.NopCloser(strings.NewReader(`{}`)),
				Header: http.Header{"Mcp-Session-Id": {"session"}},
			}}
			request := httptest.NewRequest(step.method, "/api/mcp", strings.NewReader(step.body))
			request.Header.Set("Authorization", "Bearer "+signed)
			request.Header.Set("Mcp-Session-Id", step.session)
			response := httptest.NewRecorder()
			service.handleDelegatedRequest(response, request)
			if response.Code != step.want {
				t.Fatalf("%s with session %q: status %d, want %d", step.method, step.session, response.Code, step.want)
			}
		}
	})

}
