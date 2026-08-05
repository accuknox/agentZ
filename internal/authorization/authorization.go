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

// Package authorization resolves product permissions from stable Role identities.
package authorization

import (
	"context"
	"fmt"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

// Operation identifies a generated gateway operation.
type Operation string

const (
	// OperationListSandboxes lists Sandbox resources.
	OperationListSandboxes Operation = "listSandboxes"
	// OperationCreateSandbox creates a Sandbox resource.
	OperationCreateSandbox Operation = "createSandbox"
	// OperationUpdateSandbox modifies a Sandbox resource.
	OperationUpdateSandbox Operation = "updateSandbox"
	// OperationDeleteSandbox deletes a Sandbox resource.
	OperationDeleteSandbox Operation = "deleteSandbox"
)

// Subject identifies a User within one Organisation.
type Subject struct {
	UserID         string
	OrganizationID string
}

// Scope identifies an Organisation or one of its Workspaces.
type Scope struct {
	OrganizationID string
	WorkspaceID    string
}

// Queries is the generated persistence used to resolve direct Role grants.
type Queries interface {
	GatewayResolveDirectPermissions(ctx context.Context, arg gatewaydb.GatewayResolveDirectPermissionsParams) ([]gatewaydb.GatewayResolveDirectPermissionsRow, error)
}

// Resolver resolves all direct Role grants for one active Organisation Membership.
type Resolver struct {
	queries Queries
}

// New returns a Resolver backed by generated sqlc queries.
func New(queries Queries) *Resolver {
	return &Resolver{queries: queries}
}

// Effective is an immutable snapshot of one Subject's effective permissions.
type Effective struct {
	organizationID string
	superadmin     bool
	grants         map[grantKey]struct{}
}

type grantKey struct {
	workspaceID string
	resource    gatewaydb.PermissionResource
	action      gatewaydb.PermissionAction
}

// Resolve returns the union of every direct Role assigned to an active member.
// Missing and disabled Memberships resolve to no permissions.
func (r *Resolver) Resolve(ctx context.Context, subject Subject) (Effective, error) {
	effective := Effective{
		organizationID: subject.OrganizationID,
		grants:         map[grantKey]struct{}{},
	}

	rows, err := r.queries.GatewayResolveDirectPermissions(
		ctx,
		gatewaydb.GatewayResolveDirectPermissionsParams{
			UserID:         subject.UserID,
			OrganizationID: subject.OrganizationID,
		},
	)
	if err != nil {
		return Effective{}, fmt.Errorf("resolve direct Role permissions: %w", err)
	}
	if len(rows) == 0 || !rows[0].Active {
		return effective, nil
	}

	effective.superadmin = rows[0].Superadmin
	if effective.superadmin {
		return effective, nil
	}

	for _, row := range rows {
		if !row.Resource.Valid || !row.Action.Valid {
			continue
		}
		effective.grants[grantKey{
			workspaceID: row.WorkspaceID.String,
			resource:    row.Resource.PermissionResource,
			action:      row.Action.PermissionAction,
		}] = struct{}{}
	}

	return effective, nil
}

// Allows reports whether an explicitly mapped operation is allowed in the exact scope.
func (e Effective) Allows(scope Scope, operation Operation) bool {
	resource, action, mapped := operationPermission(operation)
	if !mapped || scope.OrganizationID != e.organizationID {
		return false
	}
	if e.superadmin {
		return true
	}

	_, allowed := e.grants[grantKey{
		workspaceID: scope.WorkspaceID,
		resource:    resource,
		action:      action,
	}]
	return allowed
}

func operationPermission(operation Operation) (gatewaydb.PermissionResource, gatewaydb.PermissionAction, bool) {
	switch operation {
	case OperationListSandboxes:
		return gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionRead, true
	case OperationCreateSandbox:
		return gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionCreate, true
	case OperationUpdateSandbox:
		return gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionModify, true
	case OperationDeleteSandbox:
		return gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionDelete, true
	default:
		return "", "", false
	}
}
