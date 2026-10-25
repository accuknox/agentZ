package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

// GatewayUpdateGuardrailRetention accepts retention updates without a database.
func (q *guardrailSettingsQueries) GatewayUpdateGuardrailRetention(context.Context, gatewaydb.GatewayUpdateGuardrailRetentionParams) (int64, error) {
	return 0, nil
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
		body := `{"mandatoryPolicies":[],"retentionDays":30}`
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
	}
}

func TestGuardrailHTTPHandlersUseAuthorizedClaimsForSettingsAndAudit(t *testing.T) {
	spec, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	assignment := map[string]any{"policies": []any{}}
	if err := spec.Components.Schemas["GuardrailAssignment"].Value.VisitJSON(assignment); err != nil {
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
	tenant.Spec.Guardrails.RetentionDays = 77
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
	if err := spec.Components.Schemas["GuardrailSettings"].Value.VisitJSON(wireSettings); err != nil {
		t.Fatalf("settings response cannot be round-tripped through its public API contract: %v", err)
	}
	var settings gatewayapi.GuardrailSettings
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.RetentionDays != 77 {
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
