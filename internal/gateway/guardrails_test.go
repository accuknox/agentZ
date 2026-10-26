package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	baoapi "github.com/openbao/openbao/api/v2"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type guardrailSettingsQueries struct {
	*sandboxQueries
	superadmin bool
}

// GatewayIsActiveSuperadmin checks the configured administrator and caller identity.
func (q *guardrailSettingsQueries) GatewayIsActiveSuperadmin(_ context.Context, arg gatewaydb.GatewayIsActiveSuperadminParams) (bool, error) {
	return q.superadmin && arg.OrganizationID == testOrganizationID && arg.UserID == testUserID, nil
}

func TestOrganizationSettingsRequireAdministratorAndUseMappedBearerScope(t *testing.T) {
	for _, administrator := range []bool{true, false} {
		queries := &guardrailSettingsQueries{
			superadmin: administrator,
			sandboxQueries: &sandboxQueries{
				permissions: []gatewaydb.GatewayResolvePermissionsRow{{
					Active: true,
					Resource: gatewaydb.NullPermissionResource{
						PermissionResource: gatewaydb.PermissionResourceGuardrailPolicy,
						Valid:              true,
					},
					Action: gatewaydb.NullPermissionAction{
						PermissionAction: gatewaydb.PermissionActionModify,
						Valid:            true,
					},
				}},
			},
		}
		service := sandboxTestService(t, queries)
		router := chi.NewRouter()
		gatewayapi.HandlerWithOptions(service, gatewayapi.ChiServerOptions{
			BaseRouter:  router,
			Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
		})
		body := `{"mandatoryPolicies":[]}`
		request := httptest.NewRequest(http.MethodPut, "/api/guardrails/settings", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		want := http.StatusForbidden
		if administrator {
			want = http.StatusOK
		}
		if response.Code != want {
			t.Fatalf("administrator=%v: HTTP %d, want %d: %s", administrator, response.Code, want, response.Body.String())
		}
		if administrator {
			if len(queries.events) != 1 || queries.events[0].TargetType != gatewaydb.EventTrailTargetGuardrailSettings || queries.events[0].Result != gatewaydb.EventTrailResultSucceeded {
				t.Fatalf("settings mutation audit = %+v", queries.events)
			}
		}
	}
}

func TestGuardrailHTTPHandlersUseAuthorizedClaimsForSettingsAndAudit(t *testing.T) {
	spec, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	assignment := map[string]any{"policies": []any{}}
	err = spec.Components.Schemas["GuardrailAssignment"].Value.VisitJSON(assignment)
	if err != nil {
		t.Fatalf("the deployed API schema must accept an empty policy assignment: %v", err)
	}
	queries := &sandboxQueries{
		workspace: gatewaydb.Workspace{
			ID:             testWorkspaceID,
			OrganizationID: testOrganizationID,
			Namespace:      testWorkspaceNS,
			State:          gatewaydb.WorkspaceStateReady,
		},
	}
	actions := []gatewaydb.PermissionAction{gatewaydb.PermissionActionRead, gatewaydb.PermissionActionCreate}
	for _, action := range actions {
		queries.permissions = append(queries.permissions, gatewaydb.GatewayResolvePermissionsRow{
			Active:      true,
			WorkspaceID: pgtype.Text{String: testWorkspaceID, Valid: true},
			Resource: gatewaydb.NullPermissionResource{
				PermissionResource: gatewaydb.PermissionResourceGuardrailPolicy,
				Valid:              true,
			},
			Action: gatewaydb.NullPermissionAction{PermissionAction: action, Valid: true},
		})
	}
	service := sandboxTestService(t, queries)
	tenant := &api.Tenant{}
	key := ctrlclient.ObjectKey{
		Name: api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID),
	}
	if err := service.k8sClient.Get(t.Context(), key, tenant); err != nil {
		t.Fatal(err)
	}
	tenant.Spec.Guardrails.MandatoryPolicies = []string{"organization-policy"}
	if err := service.k8sClient.Update(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	gatewayapi.HandlerWithOptions(service, gatewayapi.ChiServerOptions{
		BaseRouter:  router,
		Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
	})
	request := httptest.NewRequest(http.MethodGet, "/api/guardrails/settings", nil)
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("read authorized organization settings: HTTP %d: %s", response.Code, response.Body.String())
	}
	var wireSettings map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &wireSettings); err != nil {
		t.Fatal(err)
	}
	err = spec.Components.Schemas["GuardrailSettings"].Value.VisitJSON(wireSettings)
	if err != nil {
		t.Fatalf("settings response cannot be round-tripped through its public API contract: %v", err)
	}
	var settings gatewayapi.GuardrailSettings
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(settings.MandatoryPolicies, []string{"organization-policy"}) {
		t.Fatal("workspace settings did not inherit the authenticated organization")
	}
	body := `{"name":"identity-proof","displayName":"Identity proof","checks":[{"id":"input","name":"Input","phase":"input","scopes":["conversation"],"mode":"enforce","failureMode":"closed","action":"deny","regex":{"patterns":["restricted"]}}]}`
	request = httptest.NewRequest(http.MethodPost, "/api/guardrails/policies", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create authorized policy: HTTP %d: %s", response.Code, response.Body.String())
	}
	policy := &api.GuardrailPolicy{}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: testWorkspaceNS, Name: "identity-proof"}, policy)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Spec.CreatedByUserID != testUserID || policy.Spec.LastModifiedByUserID != testUserID {
		t.Fatalf("policy audit identity did not use the authenticated caller: %+v", policy.Spec.ResourceAudit)
	}
}

func TestCreatePermissionCannotOverwriteExistingConnectionCredentials(t *testing.T) {
	queries := &sandboxQueries{
		workspace: gatewaydb.Workspace{
			ID:             testWorkspaceID,
			OrganizationID: testOrganizationID,
			Namespace:      testWorkspaceNS,
			State:          gatewaydb.WorkspaceStateReady,
		},
		permissions: []gatewaydb.GatewayResolvePermissionsRow{{
			Active:      true,
			WorkspaceID: pgtype.Text{String: testWorkspaceID, Valid: true},
			Resource: gatewaydb.NullPermissionResource{
				PermissionResource: gatewaydb.PermissionResourceGuardrailConnection,
				Valid:              true,
			},
			Action: gatewaydb.NullPermissionAction{
				PermissionAction: gatewaydb.PermissionActionCreate,
				Valid:            true,
			},
		}},
	}
	service := sandboxTestService(t, queries)
	connection := &api.GuardrailConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "existing", Namespace: testWorkspaceNS},
		Spec: api.GuardrailConnectionSpec{
			DisplayName: "Existing connection",
			Provider:    "Webhook",
			Endpoint:    "http://detector.local",
			SecretName:  "existing-credentials",
		},
	}
	if err := service.k8sClient.Create(t.Context(), connection); err != nil {
		t.Fatal(err)
	}
	// No credential client is configured: the duplicate must be rejected before
	// touching the credential store, even for an authorized create-only caller.
	router := chi.NewRouter()
	gatewayapi.HandlerWithOptions(service, gatewayapi.ChiServerOptions{
		BaseRouter:  router,
		Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
	})
	body := `{"name":"existing","displayName":"Replacement","provider":"Webhook","endpoint":"http://detector.local","credentials":{"token":"replacement-token"}}`
	request := httptest.NewRequest(http.MethodPost, "/api/guardrails/connections", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("duplicate create reached the credential store or bypassed authorization: HTTP %d: %s", response.Code, response.Body.String())
	}
	current := &api.GuardrailConnection{}
	err := service.k8sClient.Get(t.Context(), ctrlclient.ObjectKeyFromObject(connection), current)
	if err != nil {
		t.Fatal(err)
	}
	if current.Spec.SecretName != connection.Spec.SecretName || current.Spec.DisplayName != connection.Spec.DisplayName {
		t.Fatal("create-only caller modified the existing connection")
	}
}

type guardrailFailingWriter struct {
	ctrlclient.Client
	fail      bool
	ambiguous bool
}

type guardrailCredentialRequest struct {
	Options map[string]int `json:"options"`
}

// Create fails the first resource write after credentials have been persisted.
func (c *guardrailFailingWriter) Create(ctx context.Context, object ctrlclient.Object, options ...ctrlclient.CreateOption) error {
	if c.fail {
		if c.ambiguous {
			if err := c.Client.Create(ctx, object, options...); err != nil {
				return err
			}
			return context.DeadlineExceeded
		}
		return apierrors.NewForbidden(schema.GroupResource{
			Group:    api.SchemeGroupVersion.Group,
			Resource: "guardrailconnections",
		}, object.GetName(), errors.New("fixture resource write failure"))
	}
	return c.Client.Create(ctx, object, options...)
}

// Update fails the resource write after replacement credentials have been staged.
func (c *guardrailFailingWriter) Update(ctx context.Context, object ctrlclient.Object, options ...ctrlclient.UpdateOption) error {
	if c.fail {
		if c.ambiguous {
			if err := c.Client.Update(ctx, object, options...); err != nil {
				return err
			}
			return context.DeadlineExceeded
		}
		return apierrors.NewConflict(schema.GroupResource{
			Group:    api.SchemeGroupVersion.Group,
			Resource: "guardrailconnections",
		}, object.GetName(), errors.New("fixture resource write failure"))
	}
	return c.Client.Update(ctx, object, options...)
}

func TestConnectionMutationsRollBackCredentialsAndAllowRetry(t *testing.T) {
	queries := &sandboxQueries{
		permissions: []gatewaydb.GatewayResolvePermissionsRow{{
			Active: true,
			Resource: gatewaydb.NullPermissionResource{
				PermissionResource: gatewaydb.PermissionResourceGuardrailConnection, Valid: true,
			},
			Action: gatewaydb.NullPermissionAction{
				PermissionAction: gatewaydb.PermissionActionCreate, Valid: true,
			},
		}},
	}
	service := sandboxTestService(t, queries)
	modify := queries.permissions[0]
	modify.Action.PermissionAction = gatewaydb.PermissionActionModify
	queries.permissions = append(queries.permissions, modify)
	writer := &guardrailFailingWriter{Client: service.k8sClient, fail: true}
	service.k8sClient = writer
	var mu sync.Mutex
	writes, cleanups := 0, 0
	stored := map[string]bool{}
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodPut, http.MethodPost:
			var input guardrailCredentialRequest
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input.Options["cas"] != 0 || stored[r.URL.Path] {
				t.Error("credential revisions must use fresh keys")
				http.Error(w, "credential already exists", http.StatusBadRequest)
				return
			}
			stored[r.URL.Path] = true
			writes++
			_, _ = w.Write([]byte(`{"data":{"version":1}}`))
		case http.MethodDelete:
			if !strings.Contains(r.URL.Path, "/metadata/") {
				t.Error("cleanup must remove credential metadata")
			}
			delete(stored, strings.Replace(r.URL.Path, "/metadata/", "/data/", 1))
			cleanups++
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected credential method %s", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer store.Close()
	config := baoapi.DefaultConfig()
	config.Address = store.URL
	bao, err := baoapi.NewClient(config)
	if err != nil {
		t.Fatal(err)
	}
	service.baoKV = bao.KVv2("kv")
	router := chi.NewRouter()
	gatewayapi.HandlerWithOptions(service, gatewayapi.ChiServerOptions{
		BaseRouter: router, Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
	})
	body := `{"name":"retryable","displayName":"Retryable connection","provider":"OpenAI","credentials":{"apiKey":"fixture-secret"}}`
	for _, status := range []int{http.StatusInternalServerError, http.StatusCreated} {
		writer.fail = status == http.StatusInternalServerError
		request := httptest.NewRequest(http.MethodPost, "/api/guardrails/connections", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("HTTP %d, want %d: %s", response.Code, status, response.Body.String())
		}
	}
	if writes != 2 || cleanups != 1 || len(stored) != 1 {
		t.Fatalf("writes=%d, cleanups=%d, credentials=%d", writes, cleanups, len(stored))
	}
	if len(queries.events) != 2 {
		t.Fatalf("mutation audit = %+v", queries.events)
	}
	if queries.events[0].Result != gatewaydb.EventTrailResultFailed || queries.events[1].Result != gatewaydb.EventTrailResultSucceeded {
		t.Fatalf("mutation audit = %+v", queries.events)
	}
	current := &api.GuardrailConnection{}
	key := ctrlclient.ObjectKey{Namespace: testOrgNamespace, Name: "retryable"}
	if err := writer.Get(t.Context(), key, current); err != nil {
		t.Fatal(err)
	}
	activePath := current.CredentialPath()
	writer.fail = true
	for range 12 {
		request := httptest.NewRequest(http.MethodPut, "/api/guardrails/connections/retryable", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusConflict {
			t.Fatalf("failed rotation returned HTTP %d: %s", response.Code, response.Body.String())
		}
	}
	if err := writer.Get(t.Context(), key, current); err != nil {
		t.Fatal(err)
	}
	if cleanups != 13 || len(stored) != 1 || current.CredentialPath() != activePath {
		t.Fatalf("cleanups=%d, remaining=%d, active credential=%s", cleanups, len(stored), current.CredentialPath())
	}
	writer.ambiguous = true
	request := httptest.NewRequest(http.MethodPut, "/api/guardrails/connections/retryable", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("ambiguous rotation returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if err := writer.Get(t.Context(), key, current); err != nil {
		t.Fatal(err)
	}
	if cleanups != 13 || len(stored) != 2 || current.CredentialPath() == activePath {
		t.Fatalf("uncertain write must retain activated credentials: cleanups=%d, keys=%d", cleanups, len(stored))
	}

}

func TestGuardrailSettingsRejectInvalidCombinedBaseline(t *testing.T) {
	queries := &guardrailSettingsQueries{
		superadmin: true,
		sandboxQueries: &sandboxQueries{
			permissions: []gatewaydb.GatewayResolvePermissionsRow{{
				Active: true,
				Resource: gatewaydb.NullPermissionResource{
					PermissionResource: gatewaydb.PermissionResourceGuardrailPolicy,
					Valid:              true,
				},
				Action: gatewaydb.NullPermissionAction{
					PermissionAction: gatewaydb.PermissionActionModify,
					Valid:            true,
				},
			}},
		},
	}
	service := sandboxTestService(t, queries)
	for _, name := range []string{"first", "second", "unbounded"} {
		policy := &api.GuardrailPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID),
				Name:      name,
			},
			Spec: api.GuardrailPolicySpec{DisplayName: name},
		}
		for i := range 5 {
			policy.Spec.Checks = append(policy.Spec.Checks, api.GuardrailCheck{
				ID: fmt.Sprintf("check-%d", i), Name: "Restricted text", Phase: "input",
				Scopes: []string{"conversation"}, Mode: "enforce", FailureMode: "closed", Action: "deny",
				Regex: &api.GuardrailRegex{Patterns: []string{"restricted"}},
			})
		}
		if name == "unbounded" {
			policy.Spec.Checks = policy.Spec.Checks[:1]
			policy.Spec.Checks[0].Phase = "output"
			policy.Spec.Checks[0].Regex.Patterns = []string{".*restricted"}
		}
		if err := service.k8sClient.Create(t.Context(), policy); err != nil {
			t.Fatal(err)
		}
	}
	tenant := &api.Tenant{}
	key := ctrlclient.ObjectKey{Name: api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID)}
	if err := service.k8sClient.Get(t.Context(), key, tenant); err != nil {
		t.Fatal(err)
	}
	tenant.Spec.Guardrails.MandatoryPolicies = []string{"first"}
	if err := service.k8sClient.Update(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	gatewayapi.HandlerWithOptions(service, gatewayapi.ChiServerOptions{
		BaseRouter: router, Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth, func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tenant, err := tenantObject(r.Context())
				if err != nil {
					t.Fatal(err)
				}
				tenant.Status.Namespace = api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID)
				next.ServeHTTP(w, r)
			})
		}},
	})
	for _, body := range []string{`{"mandatoryPolicies":["first","second"]}`, `{"mandatoryPolicies":["unbounded"]}`} {
		request := httptest.NewRequest(http.MethodPut, "/api/guardrails/settings", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid baseline returned HTTP %d: %s", response.Code, response.Body.String())
		}
		if err := service.k8sClient.Get(t.Context(), key, tenant); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(tenant.Spec.Guardrails.MandatoryPolicies, []string{"first"}) {
			t.Fatal("invalid settings replaced the active baseline")
		}
	}
	for _, name := range []string{"first", "second"} {
		policy := &api.GuardrailPolicy{}
		key := ctrlclient.ObjectKey{Namespace: tenant.Status.Namespace, Name: name}
		err := service.k8sClient.Get(t.Context(), key, policy)
		if err != nil {
			t.Fatal(err)
		}
		policy.Spec.Checks = policy.Spec.Checks[:4]
		if err := service.k8sClient.Update(t.Context(), policy); err != nil {
			t.Fatal(err)
		}
	}
	tenant.Spec.Guardrails.MandatoryPolicies = []string{"first", "second"}
	if err := service.k8sClient.Update(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	proposed := &api.GuardrailPolicy{}
	policyKey := ctrlclient.ObjectKey{Namespace: tenant.Status.Namespace, Name: "first"}
	if err := service.k8sClient.Get(t.Context(), policyKey, proposed); err != nil {
		t.Fatal(err)
	}
	extra := proposed.Spec.Checks[0]
	extra.ID = "fifth"
	proposed.Spec.Checks = append(proposed.Spec.Checks, extra)
	body, err := json.Marshal(gatewayapi.GuardrailPolicyInput{
		Name: "first", DisplayName: "first", Checks: proposed.Spec.Checks,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/guardrails/policies/first", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid baseline policy edit returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if err := service.k8sClient.Get(t.Context(), policyKey, proposed); err != nil {
		t.Fatal(err)
	}
	if len(proposed.Spec.Checks) != 4 {
		t.Fatal("invalid edit replaced the active mandatory policy")
	}

}
