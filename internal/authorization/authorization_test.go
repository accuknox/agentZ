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

package authorization_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

type permissionQueries struct {
	rows   []gatewaydb.GatewayResolvePermissionsRow
	err    error
	params gatewaydb.GatewayResolvePermissionsParams
}

func (q *permissionQueries) GatewayResolvePermissions(_ context.Context, params gatewaydb.GatewayResolvePermissionsParams) ([]gatewaydb.GatewayResolvePermissionsRow, error) {
	q.params = params
	return q.rows, q.err
}

func TestResolverDirectRoleUnionAndScopeIsolation(t *testing.T) {
	t.Parallel()

	queries := &permissionQueries{rows: []gatewaydb.GatewayResolvePermissionsRow{
		permissionRow("", gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionRead),
		permissionRow("workspace-a", gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionCreate),
		permissionRow("workspace-a", gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionModify),
		permissionRow("workspace-b", gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionDelete),
	}}
	effective, err := authorization.New(queries).Resolve(context.Background(), authorization.Subject{
		UserID:         "user-a",
		OrganizationID: "organization-a",
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if queries.params.UserID != "user-a" || queries.params.OrganizationID != "organization-a" {
		t.Fatalf("Resolve() query params = %#v", queries.params)
	}

	tests := []struct {
		name      string
		scope     authorization.Scope
		operation authorization.Operation
		want      bool
	}{
		{
			name: "Organisation Read from first Role",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
			},
			operation: authorization.OperationListSandboxes,
			want:      true,
		},
		{
			name: "Workspace Create from second Role",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
				WorkspaceID:    "workspace-a",
			},
			operation: authorization.OperationCreateSandbox,
			want:      true,
		},
		{
			name: "Workspace Modify from third Role",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
				WorkspaceID:    "workspace-a",
			},
			operation: authorization.OperationUpdateSandbox,
			want:      true,
		},
		{
			name: "Workspace Delete does not cross Workspace",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
				WorkspaceID:    "workspace-a",
			},
			operation: authorization.OperationDeleteSandbox,
			want:      false,
		},
		{
			name: "Organisation grant does not imply Workspace grant",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
				WorkspaceID:    "workspace-b",
			},
			operation: authorization.OperationListSandboxes,
			want:      false,
		},
		{
			name: "Workspace grant does not imply Organisation grant",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
			},
			operation: authorization.OperationCreateSandbox,
			want:      false,
		},
		{
			name: "Grant does not cross Organisation",
			scope: authorization.Scope{
				OrganizationID: "organization-b",
				WorkspaceID:    "workspace-a",
			},
			operation: authorization.OperationCreateSandbox,
			want:      false,
		},
		{
			name: "Unmapped operation denies",
			scope: authorization.Scope{
				OrganizationID: "organization-a",
				WorkspaceID:    "workspace-a",
			},
			operation: "unmappedOperation",
			want:      false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := effective.Allows(tt.scope, tt.operation); got != tt.want {
				t.Errorf("Allows() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestResolverFailClosedAndSuperadminBypass(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		rows         []gatewaydb.GatewayResolvePermissionsRow
		queryErr     error
		organization string
		operation    authorization.Operation
		wantAllowed  bool
		wantErr      bool
	}{
		{
			name:         "Missing Membership",
			rows:         []gatewaydb.GatewayResolvePermissionsRow{{}},
			organization: "organization-a",
			operation:    authorization.OperationListSandboxes,
		},
		{
			name:         "No resolver rows",
			rows:         []gatewaydb.GatewayResolvePermissionsRow{},
			organization: "organization-a",
			operation:    authorization.OperationListSandboxes,
		},
		{
			name: "Active Membership without Roles",
			rows: []gatewaydb.GatewayResolvePermissionsRow{{
				Active: true,
			}},
			organization: "organization-a",
			operation:    authorization.OperationListSandboxes,
		},
		{
			name: "Immutable Superadmin bypass",
			rows: []gatewaydb.GatewayResolvePermissionsRow{{
				Active:     true,
				Superadmin: true,
			}},
			organization: "organization-a",
			operation:    authorization.OperationDeleteSandbox,
			wantAllowed:  true,
		},
		{
			name: "Superadmin still denies unmapped operation",
			rows: []gatewaydb.GatewayResolvePermissionsRow{{
				Active:     true,
				Superadmin: true,
			}},
			organization: "organization-a",
			operation:    "unmappedOperation",
		},
		{
			name:         "Store failure",
			queryErr:     errors.New("database unavailable"),
			organization: "organization-a",
			operation:    authorization.OperationListSandboxes,
			wantErr:      true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			queries := &permissionQueries{rows: tt.rows, err: tt.queryErr}
			effective, err := authorization.New(queries).Resolve(
				context.Background(),
				authorization.Subject{
					UserID:         "user-a",
					OrganizationID: "organization-a",
				},
			)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Resolve() error = %v, wantErr %t", err, tt.wantErr)
			}
			if err != nil {
				return
			}

			allowed := effective.Allows(authorization.Scope{
				OrganizationID: tt.organization,
				WorkspaceID:    "workspace-a",
			}, tt.operation)
			if allowed != tt.wantAllowed {
				t.Errorf("Allows() = %t, want %t", allowed, tt.wantAllowed)
			}
		})
	}
}

func permissionRow(workspaceID string, resource gatewaydb.PermissionResource, action gatewaydb.PermissionAction) gatewaydb.GatewayResolvePermissionsRow {
	return gatewaydb.GatewayResolvePermissionsRow{
		Active:      true,
		WorkspaceID: pgtype.Text{String: workspaceID, Valid: workspaceID != ""},
		Resource: gatewaydb.NullPermissionResource{
			PermissionResource: resource,
			Valid:              true,
		},
		Action: gatewaydb.NullPermissionAction{
			PermissionAction: action,
			Valid:            true,
		},
	}
}
