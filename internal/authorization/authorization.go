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
	// OperationListSkills lists immutable Skill resources.
	OperationListSkills Operation = "listSkills"
	// OperationCreateSkill creates an immutable Skill resource.
	OperationCreateSkill Operation = "createSkill"
	// OperationUpdateSkill modifies an immutable Skill resource.
	OperationUpdateSkill Operation = "updateSkill"
	// OperationDeleteSkill deletes an immutable Skill resource.
	OperationDeleteSkill Operation = "deleteSkill"
	// OperationListSandboxes lists Sandbox resources.
	OperationListSandboxes Operation = "listSandboxes"
	// OperationCreateSandbox creates a Sandbox resource.
	OperationCreateSandbox Operation = "createSandbox"
	// OperationUpdateSandbox modifies a Sandbox resource.
	OperationUpdateSandbox Operation = "updateSandbox"
	// OperationDeleteSandbox deletes a Sandbox resource.
	OperationDeleteSandbox Operation = "deleteSandbox"
	// OperationListMCPConnections lists MCP Connection resources.
	OperationListMCPConnections Operation = "listMCPConnections"
	// OperationWatchMCPConnections watches MCP Connection resources.
	OperationWatchMCPConnections Operation = "watchMCPConnections"
	// OperationGetMCPConnection reads one MCP Connection resource.
	OperationGetMCPConnection Operation = "getMCPConnection"
	// OperationCreateMCPConnection creates an MCP Connection resource.
	OperationCreateMCPConnection Operation = "createMCPConnection"
	// OperationDeleteMCPConnection deletes an MCP Connection resource.
	OperationDeleteMCPConnection Operation = "deleteMCPConnection"
	// OperationListInferenceProviders lists Inference Provider resources.
	OperationListInferenceProviders Operation = "listInferenceProviders"
	// OperationWatchInferenceProviders watches Inference Provider resources.
	OperationWatchInferenceProviders Operation = "watchInferenceProviders"
	// OperationGetInferenceProvider reads one Inference Provider resource.
	OperationGetInferenceProvider Operation = "getInferenceProvider"
	// OperationGetInferenceProviderUsage reads Inference Provider usage.
	OperationGetInferenceProviderUsage Operation = "getInferenceProviderUsage"
	// OperationRefreshInferenceProviderModels reads current Provider models.
	OperationRefreshInferenceProviderModels Operation = "refreshInferenceProviderModels"
	// OperationListInferenceProviderCatalog reads the Provider catalog.
	OperationListInferenceProviderCatalog Operation = "listInferenceProviderCatalog"
	// OperationListInferenceModelSuggestions reads catalog model suggestions.
	OperationListInferenceModelSuggestions Operation = "listInferenceModelSuggestions"
	// OperationCreateInferenceProvider creates an Inference Provider resource.
	OperationCreateInferenceProvider Operation = "createInferenceProvider"
	// OperationCreateInferenceProviderOAuthTicket creates Provider credentials.
	OperationCreateInferenceProviderOAuthTicket Operation = "createInferenceProviderOAuthTicket"
	// OperationUpdateInferenceProvider modifies an Inference Provider resource.
	OperationUpdateInferenceProvider Operation = "updateInferenceProvider"
	// OperationDeleteInferenceProvider deletes an Inference Provider resource.
	OperationDeleteInferenceProvider Operation = "deleteInferenceProvider"
	// OperationListInferencePools lists Inference Pool resources.
	OperationListInferencePools Operation = "listInferencePools"
	// OperationWatchInferencePools watches Inference Pool resources.
	OperationWatchInferencePools Operation = "watchInferencePools"
	// OperationGetInferencePool reads one Inference Pool resource.
	OperationGetInferencePool Operation = "getInferencePool"
	// OperationGetInferencePoolUsage reads Inference Pool usage.
	OperationGetInferencePoolUsage Operation = "getInferencePoolUsage"
	// OperationCreateInferencePool creates an Inference Pool resource.
	OperationCreateInferencePool Operation = "createInferencePool"
	// OperationUpdateInferencePool modifies an Inference Pool resource.
	OperationUpdateInferencePool Operation = "updateInferencePool"
	// OperationDeleteInferencePool deletes an Inference Pool resource.
	OperationDeleteInferencePool Operation = "deleteInferencePool"
)

// BearerScope returns the generated bearer scope for the operation.
func (o Operation) BearerScope() (string, bool) {
	mapping, ok := mapOperation(o)
	return mapping.bearerScope, ok
}

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

// Queries is the generated persistence used to resolve assigned Role grants.
type Queries interface {
	GatewayResolvePermissions(ctx context.Context, arg gatewaydb.GatewayResolvePermissionsParams) ([]gatewaydb.GatewayResolvePermissionsRow, error)
}

// Resolver resolves direct and Team Role grants for one active Organisation Membership.
type Resolver struct {
	queries Queries
}

// New returns a Resolver backed by generated sqlc queries.
func New(queries Queries) *Resolver {
	return &Resolver{queries: queries}
}

// Effective is an immutable snapshot of one Subject's effective permissions.
type Effective struct {
	organizationID  string
	superadmin      bool
	workspaceAdmins map[string]struct{}
	grants          map[grantKey]struct{}
}

type grantKey struct {
	workspaceID string
	resource    gatewaydb.PermissionResource
	action      gatewaydb.PermissionAction
}

// Resolve returns a fresh union of direct and Team Roles assigned to an active member.
// Missing and disabled Memberships resolve to no permissions.
func (r *Resolver) Resolve(ctx context.Context, subject Subject) (Effective, error) {
	effective := Effective{
		organizationID:  subject.OrganizationID,
		workspaceAdmins: map[string]struct{}{},
		grants:          map[grantKey]struct{}{},
	}

	rows, err := r.queries.GatewayResolvePermissions(
		ctx,
		gatewaydb.GatewayResolvePermissionsParams{
			UserID:         subject.UserID,
			OrganizationID: subject.OrganizationID,
		},
	)
	if err != nil {
		return Effective{}, fmt.Errorf("resolve Role permissions: %w", err)
	}
	if len(rows) == 0 || !rows[0].Active {
		return effective, nil
	}

	effective.superadmin = rows[0].Superadmin
	if effective.superadmin {
		return effective, nil
	}

	for _, row := range rows {
		if row.WorkspaceAdmin && row.WorkspaceID.Valid {
			effective.workspaceAdmins[row.WorkspaceID.String] = struct{}{}
		}
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
	if e.CanAdminister(scope) {
		return true
	}

	_, allowed := e.grants[grantKey{
		workspaceID: scope.WorkspaceID,
		resource:    resource,
		action:      action,
	}]
	return allowed
}

// CanAdminister reports whether a built-in role bypass applies to the exact scope.
func (e Effective) CanAdminister(scope Scope) bool {
	if scope.OrganizationID != e.organizationID {
		return false
	}
	if e.superadmin {
		return true
	}
	if scope.WorkspaceID == "" {
		return false
	}
	_, ok := e.workspaceAdmins[scope.WorkspaceID]
	return ok
}

func operationPermission(operation Operation) (gatewaydb.PermissionResource, gatewaydb.PermissionAction, bool) {
	mapping, ok := mapOperation(operation)
	return mapping.resource, mapping.action, ok
}

type operationMapping struct {
	resource    gatewaydb.PermissionResource
	action      gatewaydb.PermissionAction
	bearerScope string
}

func mapOperation(operation Operation) (operationMapping, bool) {
	switch operation {
	case OperationListSkills:
		return operationMapping{gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionRead, "skill.read"}, true
	case OperationCreateSkill:
		return operationMapping{gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionCreate, "skill.create"}, true
	case OperationUpdateSkill:
		return operationMapping{gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionModify, "skill.modify"}, true
	case OperationDeleteSkill:
		return operationMapping{gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionDelete, "skill.delete"}, true
	case OperationListSandboxes:
		return operationMapping{gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionRead, "sandbox.read"}, true
	case OperationCreateSandbox:
		return operationMapping{gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionCreate, "sandbox.create"}, true
	case OperationUpdateSandbox:
		return operationMapping{gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionModify, "sandbox.modify"}, true
	case OperationDeleteSandbox:
		return operationMapping{gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionDelete, "sandbox.delete"}, true
	case OperationListMCPConnections, OperationWatchMCPConnections, OperationGetMCPConnection:
		return operationMapping{gatewaydb.PermissionResourceMcpConnection, gatewaydb.PermissionActionRead, "mcp_connection.read"}, true
	case OperationCreateMCPConnection:
		return operationMapping{gatewaydb.PermissionResourceMcpConnection, gatewaydb.PermissionActionCreate, "mcp_connection.create"}, true
	case OperationDeleteMCPConnection:
		return operationMapping{gatewaydb.PermissionResourceMcpConnection, gatewaydb.PermissionActionDelete, "mcp_connection.delete"}, true
	case OperationListInferenceProviders,
		OperationWatchInferenceProviders,
		OperationGetInferenceProvider,
		OperationGetInferenceProviderUsage,
		OperationRefreshInferenceProviderModels,
		OperationListInferenceProviderCatalog,
		OperationListInferenceModelSuggestions:
		return operationMapping{gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionRead, "inference_provider.read"}, true
	case OperationCreateInferenceProvider, OperationCreateInferenceProviderOAuthTicket:
		return operationMapping{gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionCreate, "inference_provider.create"}, true
	case OperationUpdateInferenceProvider:
		return operationMapping{gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionModify, "inference_provider.modify"}, true
	case OperationDeleteInferenceProvider:
		return operationMapping{gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionDelete, "inference_provider.delete"}, true
	case OperationListInferencePools,
		OperationWatchInferencePools,
		OperationGetInferencePool,
		OperationGetInferencePoolUsage:
		return operationMapping{gatewaydb.PermissionResourceInferencePool, gatewaydb.PermissionActionRead, "inference_pool.read"}, true
	case OperationCreateInferencePool:
		return operationMapping{gatewaydb.PermissionResourceInferencePool, gatewaydb.PermissionActionCreate, "inference_pool.create"}, true
	case OperationUpdateInferencePool:
		return operationMapping{gatewaydb.PermissionResourceInferencePool, gatewaydb.PermissionActionModify, "inference_pool.modify"}, true
	case OperationDeleteInferencePool:
		return operationMapping{gatewaydb.PermissionResourceInferencePool, gatewaydb.PermissionActionDelete, "inference_pool.delete"}, true
	default:
		return operationMapping{}, false
	}
}
