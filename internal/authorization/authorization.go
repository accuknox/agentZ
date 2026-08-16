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
	_ "embed"
	"fmt"

	cedar "github.com/cedar-policy/cedar-go"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

//go:embed agent.cedar
var agentPolicy []byte

var agentPolicies = func() *cedar.PolicySet {
	policies, err := cedar.NewPolicySetFromBytes("agent.cedar", agentPolicy)
	if err != nil {
		panic(fmt.Sprintf("compile Agent authorization policy: %v", err))
	}
	return policies
}()

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
	// OperationListAgents lists Agent resources.
	OperationListAgents Operation = "listAgents"
	// OperationWatchAgents watches Agent resources.
	OperationWatchAgents Operation = "watchAgents"
	// OperationCreateAgent creates an Agent resource.
	OperationCreateAgent Operation = "createAgent"
	// OperationUpdateAgent modifies an Agent resource.
	OperationUpdateAgent Operation = "updateAgent"
	// OperationDeleteAgent deletes an Agent resource.
	OperationDeleteAgent Operation = "deleteAgent"
	// OperationShareAuthoredAgent shares an Agent owned by the caller.
	OperationShareAuthoredAgent Operation = "shareAuthoredAgent"
	// OperationShareNonAuthoredAgent shares an Agent through delegation.
	OperationShareNonAuthoredAgent Operation = "shareNonAuthoredAgent"
	// OperationUseSharedAgent uses a shared Agent.
	OperationUseSharedAgent Operation = "useSharedAgent"
	// OperationReadSharedSecret reads shared Agent secret metadata.
	OperationReadSharedSecret Operation = "readSharedSecret"
	// OperationWriteSharedSecret writes a shared Agent secret.
	OperationWriteSharedSecret Operation = "writeSharedSecret"
	// OperationDeleteSharedSecret deletes a shared Agent secret.
	OperationDeleteSharedSecret Operation = "deleteSharedSecret"
	// OperationListAPIKeys lists Workspace API key metadata.
	OperationListAPIKeys Operation = "listAPIKeys"
	// OperationCreateAPIKey creates a Workspace API key.
	OperationCreateAPIKey Operation = "createAPIKey"
	// OperationDeleteAPIKey deletes a Workspace API key.
	OperationDeleteAPIKey Operation = "deleteAPIKey"
	// OperationReadObservability reads Workspace observability.
	OperationReadObservability Operation = "readObservability"
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
	userID          string
	organizationID  string
	active          bool
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
		userID:          subject.UserID,
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

	effective.active = true
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

// Agent describes the relationship facts used to authorize one Agent.
type Agent struct {
	Name        string
	OwnerUserID string
	ShareGrants []gatewaydb.AgentShareCapability
}

// AgentCapabilities is the complete action projection for one Agent.
type AgentCapabilities struct {
	Use             bool
	Modify          bool
	Delete          bool
	Share           bool
	ManageOwnership bool
	ReadSecrets     bool
	WriteSecrets    bool
	DeleteSecrets   bool
}

// CoversShare reports whether these effective capabilities contain every action
// represented by the proposed Agent Share grants.
func (c AgentCapabilities) CoversShare(grants []gatewaydb.AgentShareCapability) bool {
	if !c.Use {
		return false
	}
	for _, grant := range grants {
		switch grant {
		case gatewaydb.AgentShareCapabilityUseShared:
		case gatewaydb.AgentShareCapabilityShareNonAuthored:
			if !c.Share {
				return false
			}
		case gatewaydb.AgentShareCapabilityReadSharedSecret:
			if !c.ReadSecrets {
				return false
			}
		case gatewaydb.AgentShareCapabilityWriteSharedSecret:
			if !c.ReadSecrets || !c.WriteSecrets {
				return false
			}
		case gatewaydb.AgentShareCapabilityDeleteSharedSecret:
			if !c.ReadSecrets || !c.WriteSecrets || !c.DeleteSecrets {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// AgentCapabilities evaluates Workspace grants, ownership, and Agent Shares
// through the Cedar policy set.
func (e Effective) AgentCapabilities(scope Scope, agent Agent) (AgentCapabilities, error) {
	if !e.active || scope.OrganizationID != e.organizationID {
		return AgentCapabilities{}, nil
	}
	principal := cedar.NewEntityUID("User", cedar.String(e.userID))
	resource := cedar.NewEntityUID("Agent", cedar.String(agent.Name))
	workspaceGrants := make([]cedar.Value, 0, len(e.grants))
	for grant := range e.grants {
		if grant.workspaceID != scope.WorkspaceID || grant.resource != gatewaydb.PermissionResourceAgent {
			continue
		}
		workspaceGrants = append(workspaceGrants, cedar.NewEntityUID(
			"Action",
			cedar.String(grant.action),
		))
	}
	shareGrants := make([]cedar.Value, 0, len(agent.ShareGrants))
	for _, grant := range agent.ShareGrants {
		shareGrants = append(shareGrants, cedar.NewEntityUID(
			"Action",
			cedar.String(grant),
		))
	}
	entities := cedar.EntityMap{
		principal: {
			UID:        principal,
			Parents:    cedar.NewEntityUIDSet(),
			Attributes: cedar.NewRecord(nil),
		},
		resource: {
			UID:     resource,
			Parents: cedar.NewEntityUIDSet(),
			Attributes: cedar.NewRecord(cedar.RecordMap{
				"administrator":    cedar.Boolean(e.CanAdminister(scope)),
				"owner":            cedar.NewEntityUID("User", cedar.String(agent.OwnerUserID)),
				"share_grants":     cedar.NewSet(shareGrants...),
				"workspace_access": cedar.Boolean(e.HasWorkspaceAccess(scope)),
				"workspace_grants": cedar.NewSet(workspaceGrants...),
			}),
		},
	}

	allowed := func(action string) (bool, error) {
		decision, diagnostic := cedar.Authorize(agentPolicies, entities, cedar.Request{
			Principal: principal,
			Action:    cedar.NewEntityUID("Action", cedar.String(action)),
			Resource:  resource,
			Context:   cedar.NewRecord(nil),
		})
		if len(diagnostic.Errors) > 0 {
			return false, fmt.Errorf("evaluate Agent action %q: %v", action, diagnostic.Errors)
		}
		return decision == cedar.Allow, nil
	}

	var capabilities AgentCapabilities
	actions := []struct {
		name    string
		allowed *bool
	}{
		{"use", &capabilities.Use},
		{"modify", &capabilities.Modify},
		{"delete", &capabilities.Delete},
		{"share", &capabilities.Share},
		{"manage_ownership", &capabilities.ManageOwnership},
		{"read_secrets", &capabilities.ReadSecrets},
		{"write_secrets", &capabilities.WriteSecrets},
		{"delete_secrets", &capabilities.DeleteSecrets},
	}
	for _, action := range actions {
		value, err := allowed(action.name)
		if err != nil {
			return AgentCapabilities{}, err
		}
		*action.allowed = value
	}
	return capabilities, nil
}

// CanReceiveAgentShare reports whether the subject's Workspace grants support
// every effective capability in the proposed Agent Share.
func (e Effective) CanReceiveAgentShare(scope Scope, grants []gatewaydb.AgentShareCapability) (bool, error) {
	return e.canReceiveAgentShare(scope, grants)
}

// CanReceiveAgentShare reports whether the supplied Workspace grants support
// every effective capability in the proposed Agent Share.
func CanReceiveAgentShare(workspaceID string, workspaceGrants []gatewaydb.PermissionAction, administrator bool, grants []gatewaydb.AgentShareCapability) (bool, error) {
	effective := Effective{
		userID:          "recipient",
		organizationID:  "organization",
		active:          true,
		workspaceAdmins: map[string]struct{}{},
		grants:          map[grantKey]struct{}{},
	}
	if administrator {
		effective.workspaceAdmins[workspaceID] = struct{}{}
	}
	for _, action := range workspaceGrants {
		effective.grants[grantKey{
			workspaceID: workspaceID,
			resource:    gatewaydb.PermissionResourceAgent,
			action:      action,
		}] = struct{}{}
	}
	return effective.canReceiveAgentShare(Scope{
		OrganizationID: "organization",
		WorkspaceID:    workspaceID,
	}, grants)
}

func (e Effective) canReceiveAgentShare(scope Scope, grants []gatewaydb.AgentShareCapability) (bool, error) {
	capabilities, err := e.AgentCapabilities(scope, Agent{
		Name:        "prospective-share",
		OwnerUserID: "owner",
		ShareGrants: grants,
	})
	if err != nil {
		return false, err
	}
	return capabilities.CoversShare(grants), nil
}

// Active reports whether the subject has an enabled Membership in the
// Organisation. A grant-free active Membership remains active.
func (e Effective) Active() bool {
	return e.active
}

// Allows reports whether an explicitly mapped operation is allowed in the exact scope.
func (e Effective) Allows(scope Scope, operation Operation) bool {
	mapping, mapped := mapOperation(operation)
	if !mapped || scope.OrganizationID != e.organizationID {
		return false
	}
	if e.CanAdminister(scope) {
		return true
	}

	_, allowed := e.grants[grantKey{
		workspaceID: scope.WorkspaceID,
		resource:    mapping.resource,
		action:      mapping.action,
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

// HasWorkspaceAccess reports whether the subject has any active authority in
// a Workspace. Agent ownership depends on this so an owned Agent cannot keep a
// user inside a Workspace after all independent access is revoked.
func (e Effective) HasWorkspaceAccess(scope Scope) bool {
	if scope.OrganizationID != e.organizationID {
		return false
	}
	if e.CanAdminister(scope) {
		return true
	}
	for grant := range e.grants {
		if grant.workspaceID == scope.WorkspaceID {
			return true
		}
	}
	return false
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
	case OperationListAgents, OperationWatchAgents:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionUseShared, "agent.use_shared"}, true
	case OperationCreateAgent:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionAuthor, "agent.author"}, true
	case OperationUpdateAgent, OperationDeleteAgent:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionUseShared, "agent.use_shared"}, true
	case OperationShareAuthoredAgent:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionShareAuthored, "agent.share_authored"}, true
	case OperationShareNonAuthoredAgent:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionShareNonAuthored, "agent.share_non_authored"}, true
	case OperationUseSharedAgent:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionUseShared, "agent.use_shared"}, true
	case OperationReadSharedSecret:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionReadSharedSecret, "agent.read_shared_secret"}, true
	case OperationWriteSharedSecret:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionWriteSharedSecret, "agent.write_shared_secret"}, true
	case OperationDeleteSharedSecret:
		return operationMapping{gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionDeleteSharedSecret, "agent.delete_shared_secret"}, true
	case OperationListAPIKeys:
		return operationMapping{gatewaydb.PermissionResourceApiKey, gatewaydb.PermissionActionRead, "api_key.read"}, true
	case OperationCreateAPIKey:
		return operationMapping{gatewaydb.PermissionResourceApiKey, gatewaydb.PermissionActionCreate, "api_key.create"}, true
	case OperationDeleteAPIKey:
		return operationMapping{gatewaydb.PermissionResourceApiKey, gatewaydb.PermissionActionDelete, "api_key.delete"}, true
	case OperationReadObservability:
		return operationMapping{gatewaydb.PermissionResourceObservability, gatewaydb.PermissionActionRead, "observability.read"}, true
	default:
		return operationMapping{}, false
	}
}
