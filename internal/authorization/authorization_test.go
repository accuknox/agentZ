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
		permissionRow(gatewaydb.PermissionResourceSandbox, "", gatewaydb.PermissionActionRead),
		permissionRow(gatewaydb.PermissionResourceSandbox, "workspace-a", gatewaydb.PermissionActionCreate),
		permissionRow(gatewaydb.PermissionResourceSandbox, "workspace-a", gatewaydb.PermissionActionModify),
		permissionRow(gatewaydb.PermissionResourceSandbox, "workspace-b", gatewaydb.PermissionActionDelete),
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

	if effective.HasWorkspaceAccess(authorization.Scope{
		OrganizationID: "organization-b",
		WorkspaceID:    "workspace-a",
	}) {
		t.Error("HasWorkspaceAccess() allowed a Workspace in another Organisation")
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
		wantActive   bool
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
			wantActive:   true,
		},
		{
			name: "Immutable Superadmin bypass",
			rows: []gatewaydb.GatewayResolvePermissionsRow{{
				Active:     true,
				Superadmin: true,
			}},
			organization: "organization-a",
			operation:    authorization.OperationDeleteSandbox,
			wantActive:   true,
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
			wantActive:   true,
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
			if effective.Active() != tt.wantActive {
				t.Errorf("Active() = %t, want %t", effective.Active(), tt.wantActive)
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

func TestAgentCapabilities(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		owner           string
		permissions     []gatewaydb.PermissionAction
		shares          []gatewaydb.AgentShareCapability
		want            authorization.AgentCapabilities
		wantCoversShare bool
	}{
		{
			name:            "shared use does not confer edit authority",
			owner:           "user-b",
			permissions:     []gatewaydb.PermissionAction{gatewaydb.PermissionActionUseShared},
			shares:          []gatewaydb.AgentShareCapability{gatewaydb.AgentShareCapabilityUseShared},
			want:            authorization.AgentCapabilities{Use: true},
			wantCoversShare: true,
		},
		{
			name:  "owner controls the Agent but cannot share without Workspace authority",
			owner: "user-a",
			permissions: []gatewaydb.PermissionAction{
				gatewaydb.PermissionActionRead,
			},
			want: authorization.AgentCapabilities{
				Use: true, Modify: true, Delete: true, ManageOwnership: true,
				ReadSecrets: true, WriteSecrets: true, DeleteSecrets: true,
			},
		},
		{
			name:  "delegated sharing requires matching Workspace and Share grants",
			owner: "user-b",
			permissions: []gatewaydb.PermissionAction{
				gatewaydb.PermissionActionUseShared,
				gatewaydb.PermissionActionShareNonAuthored,
			},
			shares: []gatewaydb.AgentShareCapability{
				gatewaydb.AgentShareCapabilityShareNonAuthored,
			},
			want:            authorization.AgentCapabilities{Use: true, Share: true},
			wantCoversShare: true,
		},
		{
			name:  "secret deletion implies its usable baseline in policy",
			owner: "user-b",
			permissions: []gatewaydb.PermissionAction{
				gatewaydb.PermissionActionUseShared,
				gatewaydb.PermissionActionReadSharedSecret,
				gatewaydb.PermissionActionWriteSharedSecret,
				gatewaydb.PermissionActionDeleteSharedSecret,
			},
			shares: []gatewaydb.AgentShareCapability{
				gatewaydb.AgentShareCapabilityDeleteSharedSecret,
			},
			want: authorization.AgentCapabilities{
				Use: true, ReadSecrets: true, WriteSecrets: true, DeleteSecrets: true,
			},
			wantCoversShare: true,
		},
		{
			name:  "secret authority denies when the Workspace baseline is incomplete",
			owner: "user-b",
			permissions: []gatewaydb.PermissionAction{
				gatewaydb.PermissionActionUseShared,
				gatewaydb.PermissionActionDeleteSharedSecret,
			},
			shares: []gatewaydb.AgentShareCapability{
				gatewaydb.AgentShareCapabilityDeleteSharedSecret,
			},
			want: authorization.AgentCapabilities{Use: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rows := make([]gatewaydb.GatewayResolvePermissionsRow, 0, len(tt.permissions))
			for _, permission := range tt.permissions {
				rows = append(rows, permissionRow(
					gatewaydb.PermissionResourceAgent,
					"workspace-a",
					permission,
				))
			}
			effective, err := authorization.New(&permissionQueries{rows: rows}).Resolve(
				context.Background(),
				authorization.Subject{UserID: "user-a", OrganizationID: "organization-a"},
			)
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			got, err := effective.AgentCapabilities(
				authorization.Scope{
					OrganizationID: "organization-a",
					WorkspaceID:    "workspace-a",
				},
				authorization.Agent{
					Name: "agent-a", OwnerUserID: tt.owner, ShareGrants: tt.shares,
				},
			)
			if err != nil {
				t.Fatalf("AgentCapabilities() error = %v", err)
			}
			if got != tt.want {
				t.Errorf("AgentCapabilities() = %#v, want %#v", got, tt.want)
			}
			if len(tt.shares) > 0 && got.CoversShare(tt.shares) != tt.wantCoversShare {
				t.Errorf("CoversShare() = %t, want %t", got.CoversShare(tt.shares), tt.wantCoversShare)
			}
		})
	}
}

func permissionRow(resource gatewaydb.PermissionResource, workspaceID string, action gatewaydb.PermissionAction) gatewaydb.GatewayResolvePermissionsRow {
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
