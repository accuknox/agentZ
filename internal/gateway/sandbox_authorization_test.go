/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	testOrganizationID = "organization-1"
	testUserID         = "user-1"
	testOrgNamespace   = "org-namespace"
	testWorkspaceID    = "workspace-1"
	testWorkspaceNS    = "workspace-namespace"
)

type sandboxQueries struct {
	gatewaydb.Querier
	permissions []gatewaydb.GatewayResolvePermissionsRow
	workspace   gatewaydb.Workspace
}

func (q *sandboxQueries) GatewayResolvePermissions(context.Context, gatewaydb.GatewayResolvePermissionsParams) ([]gatewaydb.GatewayResolvePermissionsRow, error) {
	return q.permissions, nil
}

func (q *sandboxQueries) GatewayGetWorkspace(_ context.Context, arg gatewaydb.GatewayGetWorkspaceParams) (gatewaydb.Workspace, error) {
	if arg.ID == q.workspace.ID && arg.OrganizationID == q.workspace.OrganizationID {
		return q.workspace, nil
	}
	return gatewaydb.Workspace{}, pgx.ErrNoRows
}

func (q *sandboxQueries) GatewayListWorkspaceInheritedResources(context.Context, gatewaydb.GatewayListWorkspaceInheritedResourcesParams) ([]gatewaydb.GatewayListWorkspaceInheritedResourcesRow, error) {
	return []gatewaydb.GatewayListWorkspaceInheritedResourcesRow{}, nil
}

func TestGeneratedSandboxListSelectsAuthorizedNamespace(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		workspaceID  string
		permissionNS string
		wantSandbox  string
	}{
		{
			name:        "Organisation",
			wantSandbox: "organization-sandbox",
		},
		{
			name:         "Workspace",
			workspaceID:  testWorkspaceID,
			permissionNS: testWorkspaceID,
			wantSandbox:  "workspace-sandbox",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			queries := &sandboxQueries{
				permissions: []gatewaydb.GatewayResolvePermissionsRow{{
					Active: true,
					WorkspaceID: pgtype.Text{
						String: tt.permissionNS,
						Valid:  tt.permissionNS != "",
					},
					Resource: gatewaydb.NullPermissionResource{
						PermissionResource: gatewaydb.PermissionResourceSandbox,
						Valid:              true,
					},
					Action: gatewaydb.NullPermissionAction{
						PermissionAction: gatewaydb.PermissionActionRead,
						Valid:            true,
					},
				}},
				workspace: gatewaydb.Workspace{
					ID:             testWorkspaceID,
					OrganizationID: testOrganizationID,
					Namespace:      testWorkspaceNS,
					State:          gatewaydb.WorkspaceStateReady,
				},
			}
			svc := sandboxTestService(t, queries)
			router := chi.NewRouter()
			gatewayapi.HandlerWithOptions(svc, gatewayapi.ChiServerOptions{
				BaseRouter:  router,
				Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
			})

			req := httptest.NewRequest(http.MethodGet, "/api/sandbox", nil)
			if tt.workspaceID != "" {
				req.Header.Set("X-AgentZ-Workspace-ID", tt.workspaceID)
			}
			res := httptest.NewRecorder()
			router.ServeHTTP(res, req)
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}

			var body gatewayapi.ListSandboxesResponse
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(body.Sandboxes) != 1 || body.Sandboxes[0].Name != tt.wantSandbox {
				t.Fatalf("sandboxes = %#v, want only %q", body.Sandboxes, tt.wantSandbox)
			}
		})
	}
}

func TestSandboxMutationAuthorizationIncludesCreatorPrivilege(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		userID     string
		operation  authorization.Operation
		action     gatewaydb.PermissionAction
		wantStatus int
	}{
		{
			name:      "creator with Create may modify",
			userID:    testUserID,
			operation: authorization.OperationUpdateSandbox,
			action:    gatewaydb.PermissionActionCreate,
		},
		{
			name:      "creator with Create may delete",
			userID:    testUserID,
			operation: authorization.OperationDeleteSandbox,
			action:    gatewaydb.PermissionActionCreate,
		},
		{
			name:       "non-creator with Create may not modify",
			userID:     "user-2",
			operation:  authorization.OperationUpdateSandbox,
			action:     gatewaydb.PermissionActionCreate,
			wantStatus: http.StatusForbidden,
		},
		{
			name:      "broad Modify allows a non-creator",
			userID:    "user-2",
			operation: authorization.OperationUpdateSandbox,
			action:    gatewaydb.PermissionActionModify,
		},
		{
			name:      "broad Delete allows a non-creator",
			userID:    "user-2",
			operation: authorization.OperationDeleteSandbox,
			action:    gatewaydb.PermissionActionDelete,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			queries := &sandboxQueries{permissions: []gatewaydb.GatewayResolvePermissionsRow{{
				Active: true,
				Resource: gatewaydb.NullPermissionResource{
					PermissionResource: gatewaydb.PermissionResourceSandbox,
					Valid:              true,
				},
				Action: gatewaydb.NullPermissionAction{
					PermissionAction: tt.action,
					Valid:            true,
				},
			}}}
			svc := sandboxTestService(t, queries)
			ctx := context.Background()
			ctx = context.WithValue(ctx, authContextKey{}, requestAuth{claims: &gatewayClaims{
				OrganizationID: testOrganizationID,
				UserID:         tt.userID,
			}})
			ctx = context.WithValue(ctx, tenantContextKey{}, tenantRequest{tenant: &agentzv1alpha1.Tenant{
				Spec:   agentzv1alpha1.TenantSpec{OrganizationID: testOrganizationID},
				Status: agentzv1alpha1.TenantStatus{Namespace: testOrgNamespace},
			}})
			scope, ok := tt.operation.BearerScope()
			if !ok {
				t.Fatalf("operation %q is not mapped", tt.operation)
			}
			// The generated context key is a string constant owned by oapi-codegen.
			ctx = context.WithValue(ctx, gatewayapi.GatewayBearerScopes, []string{scope}) //nolint:staticcheck

			_, apiErr := svc.resolveSandboxAccess(
				ctx, "", "organization-sandbox", tt.operation,
			)
			if tt.wantStatus == 0 && apiErr != nil {
				t.Fatalf("error = %#v, want authorized", apiErr)
			}
			if tt.wantStatus != 0 && (apiErr == nil || apiErr.Status != tt.wantStatus) {
				t.Fatalf("error = %#v, want status %d", apiErr, tt.wantStatus)
			}
		})
	}
}

func sandboxTestService(t *testing.T, queries gatewaydb.Querier) *Service {
	t.Helper()

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add AgentZ scheme: %v", err)
	}
	objects := []ctrlclient.Object{
		&agentzv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{
			Name:      "organization-sandbox",
			Namespace: testOrgNamespace,
		}, Spec: agentzv1alpha1.SandboxSpec{CreatorUserID: testUserID}},
		&agentzv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{
			Name:      "workspace-sandbox",
			Namespace: testWorkspaceNS,
		}},
		&agentzv1alpha1.Workspace{
			ObjectMeta: metav1.ObjectMeta{Name: testWorkspaceNS},
			Spec: agentzv1alpha1.WorkspaceSpec{
				WorkspaceID:    testWorkspaceID,
				OrganizationID: testOrganizationID,
			},
			Status: agentzv1alpha1.WorkspaceStatus{Namespace: testWorkspaceNS},
		},
	}
	return &Service{
		queries:   queries,
		k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build(),
	}
}

func sandboxTestAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		workspaceID := r.Header.Get("X-AgentZ-Workspace-ID")
		ctx := context.WithValue(r.Context(), authContextKey{}, requestAuth{claims: &gatewayClaims{
			OrganizationID: testOrganizationID,
			WorkspaceID:    workspaceID,
			UserID:         testUserID,
		}})
		ctx = context.WithValue(ctx, tenantContextKey{}, tenantRequest{tenant: &agentzv1alpha1.Tenant{
			Spec:   agentzv1alpha1.TenantSpec{OrganizationID: testOrganizationID},
			Status: agentzv1alpha1.TenantStatus{Namespace: testOrgNamespace},
		}})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
