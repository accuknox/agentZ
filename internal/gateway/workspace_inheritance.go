package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListWorkspaceInheritedResources handles GET
// /api/workspace/{workspaceId}/inherited-resource/{resourceType}.
func (s *Service) ListWorkspaceInheritedResources(w http.ResponseWriter, r *http.Request, workspaceID gatewayapi.WorkspaceIDPath, resourceType gatewayapi.InheritedResourceTypePath) {
	_, workspace, ok := s.authorizeWorkspaceInheritance(w, r, workspaceID, "read")
	if !ok {
		return
	}
	resources, err := s.workspaceInheritedResources(r.Context(), workspace, resourceType)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListWorkspaceInheritedResourcesResponse{
		ResourceType: resourceType,
		Resources:    resources,
	})
}

// ReplaceWorkspaceInheritedResources handles PUT
// /api/workspace/{workspaceId}/inherited-resource/{resourceType}.
func (s *Service) ReplaceWorkspaceInheritedResources(w http.ResponseWriter, r *http.Request, workspaceID gatewayapi.WorkspaceIDPath, resourceType gatewayapi.InheritedResourceTypePath) {
	claims, workspace, ok := s.authorizeWorkspaceInheritance(w, r, workspaceID, "modify")
	if !ok {
		return
	}
	var req gatewayapi.ReplaceWorkspaceInheritedResourcesRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	names := slices.Clone(req.Names)
	for i := range names {
		names[i] = strings.TrimSpace(names[i])
	}
	sort.Strings(names)
	invalid := slices.Contains(names, "")
	for i := 1; i < len(names); i++ {
		invalid = invalid || names[i-1] == names[i]
	}
	if invalid {
		s.recordWorkspaceInheritanceFailure(r, claims, workspaceID, resourceType)
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"resource names must be non-empty and unique",
			errBadRequest,
		))
		return
	}

	resources, err := s.workspaceInheritedResources(r.Context(), workspace, resourceType)
	if err != nil {
		s.recordWorkspaceInheritanceFailure(r, claims, workspaceID, resourceType)
		writeInternalError(w, r, err)
		return
	}
	available := make(map[string]gatewayapi.WorkspaceInheritedResource, len(resources))
	for _, resource := range resources {
		available[resource.Name] = resource
	}
	for _, name := range names {
		if _, found := available[name]; found {
			continue
		}
		s.recordWorkspaceInheritanceFailure(r, claims, workspaceID, resourceType)
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"selected Organisation resource was not found",
			errBadRequest,
			gatewayapi.FieldError{Field: "names", Message: name + " was not found"},
		))
		return
	}
	for _, resource := range resources {
		if !resource.Selected || slices.Contains(names, resource.Name) || len(resource.Consumers) == 0 {
			continue
		}
		consumerNames := make([]string, 0, len(resource.Consumers))
		for _, consumer := range resource.Consumers {
			consumerNames = append(consumerNames, consumer.Kind+" "+consumer.Name)
		}
		s.recordWorkspaceInheritanceFailure(r, claims, workspaceID, resourceType)
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"resource_consumed",
			"an inherited resource is still consumed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "names",
				Message: resource.Name + " is consumed by " + strings.Join(consumerNames, ", "),
			},
		))
		return
	}

	previous, err := s.workspaceResourceSelection(r.Context(), workspaceID, claims.TenantID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	next := previous
	kind, _, mapped := inheritedResourceKind(resourceType)
	if !mapped {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request",
			"unknown inherited resource type", errBadRequest,
		))
		return
	}
	next.Set(kind, names)
	if err := s.updateWorkspaceResourceSelection(r.Context(), workspace, next); err != nil {
		s.recordWorkspaceInheritanceFailure(r, claims, workspaceID, resourceType)
		writeInternalError(w, r, err)
		return
	}
	if err := s.persistWorkspaceResourceSelection(r.Context(), r, claims, workspaceID, resourceType, names); err != nil {
		compensationErr := s.updateWorkspaceResourceSelection(r.Context(), workspace, previous)
		writeInternalError(w, r, errors.Join(err, compensationErr))
		return
	}
	resources, err = s.workspaceInheritedResources(r.Context(), workspace, resourceType)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListWorkspaceInheritedResourcesResponse{
		ResourceType: resourceType,
		Resources:    resources,
	})
}

func (s *Service) authorizeWorkspaceInheritance(w http.ResponseWriter, r *http.Request, workspaceID, action string) (gatewayClaims, gatewaydb.Workspace, bool) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return gatewayClaims{}, gatewaydb.Workspace{}, false
	}
	allowed, err := s.queries.GatewayIsActiveSuperadmin(
		r.Context(),
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID: claims.UserID, OrganizationID: claims.TenantID,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("authorize Workspace inheritance: %w", err))
		return gatewayClaims{}, gatewaydb.Workspace{}, false
	}
	workspace, getErr := s.queries.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{
			ID: workspaceID, OrganizationID: claims.TenantID,
		},
	)
	if !allowed || getErr != nil {
		if action == "modify" {
			_ = createWorkspaceAudit(r.Context(), s.queries, workspaceAudit{
				request: r, organizationID: claims.TenantID, workspaceID: workspaceID,
				actorType: gatewaydb.AuditActorUser, actorID: claims.UserID,
				action: "workspace.inheritance.modify", result: gatewaydb.AuditResultDenied,
				interfaceName: gatewaydb.AuditInterfaceGateway,
			})
		}
		if !allowed {
			writeError(w, r, newAPIError(
				http.StatusForbidden, "forbidden",
				"Superadmin authority is required",
				errors.New("workspace inheritance requires Superadmin authority"),
			))
			return gatewayClaims{}, gatewaydb.Workspace{}, false
		}
		if errors.Is(getErr, pgx.ErrNoRows) {
			writeError(w, r, workspaceNotFound(workspaceID))
			return gatewayClaims{}, gatewaydb.Workspace{}, false
		}
		writeInternalError(w, r, fmt.Errorf("get Workspace inheritance: %w", getErr))
		return gatewayClaims{}, gatewaydb.Workspace{}, false
	}
	return claims, workspace, true
}

func (s *Service) workspaceResourceSelection(ctx context.Context, workspaceID, organizationID string) (agentzv1alpha1.SelectedOrganizationResources, error) {
	rows, err := s.queries.GatewayListWorkspaceInheritedResources(
		ctx,
		gatewaydb.GatewayListWorkspaceInheritedResourcesParams{
			WorkspaceID: workspaceID, OrganizationID: organizationID,
		},
	)
	if err != nil {
		return agentzv1alpha1.SelectedOrganizationResources{}, fmt.Errorf("list Workspace inheritance: %w", err)
	}
	selected := agentzv1alpha1.SelectedOrganizationResources{}
	for _, row := range rows {
		kind, mapped := databaseOrganizationResourceKind(row.Resource)
		if !mapped {
			return selected, fmt.Errorf("unknown persisted inherited resource type %q", row.Resource)
		}
		selected.Set(kind, append(selected.Names(kind), row.ResourceName))
	}
	return selected, nil
}

func (s *Service) selectedOrganizationResourceNames(ctx context.Context, workspaceID, organizationID string, kind agentzv1alpha1.OrganizationResourceKind) (map[string]struct{}, error) {
	selected, err := s.workspaceResourceSelection(ctx, workspaceID, organizationID)
	if err != nil {
		return nil, err
	}
	names := selected.Names(kind)
	out := make(map[string]struct{}, len(names))
	for _, name := range names {
		out[name] = struct{}{}
	}
	return out, nil
}

func inheritedResourceKind(resourceType gatewayapi.InheritedResourceType) (agentzv1alpha1.OrganizationResourceKind, gatewaydb.PermissionResource, bool) {
	switch resourceType {
	case gatewayapi.InheritedResourceTypeSkill:
		return agentzv1alpha1.OrganizationResourceKindSkill, gatewaydb.PermissionResourceSkill, true
	case gatewayapi.InheritedResourceTypeSandbox:
		return agentzv1alpha1.OrganizationResourceKindSandbox, gatewaydb.PermissionResourceSandbox, true
	case gatewayapi.InheritedResourceTypeMCPConnection:
		return agentzv1alpha1.OrganizationResourceKindMCPConnection, gatewaydb.PermissionResourceMcpConnection, true
	case gatewayapi.InheritedResourceTypeInferenceProvider:
		return agentzv1alpha1.OrganizationResourceKindInferenceProvider, gatewaydb.PermissionResourceInferenceProvider, true
	}
	return "", "", false
}

func databaseOrganizationResourceKind(resource gatewaydb.PermissionResource) (agentzv1alpha1.OrganizationResourceKind, bool) {
	switch resource {
	case gatewaydb.PermissionResourceSkill:
		return agentzv1alpha1.OrganizationResourceKindSkill, true
	case gatewaydb.PermissionResourceSandbox:
		return agentzv1alpha1.OrganizationResourceKindSandbox, true
	case gatewaydb.PermissionResourceMcpConnection:
		return agentzv1alpha1.OrganizationResourceKindMCPConnection, true
	case gatewaydb.PermissionResourceInferenceProvider:
		return agentzv1alpha1.OrganizationResourceKindInferenceProvider, true
	}
	return "", false
}

func (s *Service) updateWorkspaceResourceSelection(ctx context.Context, row gatewaydb.Workspace, selected agentzv1alpha1.SelectedOrganizationResources) error {
	workspace := &agentzv1alpha1.Workspace{}
	if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: row.Namespace}, workspace); err != nil {
		return fmt.Errorf("get Workspace resource selection: %w", err)
	}
	workspace.Spec.SelectedOrganizationResources = selected
	if err := s.k8sClient.Update(ctx, workspace); err != nil {
		return fmt.Errorf("update Workspace resource selection: %w", err)
	}
	return nil
}

func (s *Service) persistWorkspaceResourceSelection(ctx context.Context, r *http.Request, claims gatewayClaims, workspaceID string, resourceType gatewayapi.InheritedResourceType, names []string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Workspace inheritance update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := gatewaydb.New(tx)
	_, err = q.GatewayLockActiveWorkspace(ctx, gatewaydb.GatewayLockActiveWorkspaceParams{
		ID: workspaceID, OrganizationID: claims.TenantID,
	})
	if err != nil {
		return fmt.Errorf("lock Workspace inheritance: %w", err)
	}
	_, resource, mapped := inheritedResourceKind(resourceType)
	if !mapped {
		return fmt.Errorf("unknown inherited resource type %q", resourceType)
	}
	_, err = q.GatewayDeleteWorkspaceInheritedResources(
		ctx,
		gatewaydb.GatewayDeleteWorkspaceInheritedResourcesParams{
			WorkspaceID: workspaceID, OrganizationID: claims.TenantID,
			Resource: resource,
		},
	)
	if err == nil {
		_, err = q.GatewayInsertWorkspaceInheritedResources(
			ctx,
			gatewaydb.GatewayInsertWorkspaceInheritedResourcesParams{
				WorkspaceID: workspaceID, OrganizationID: claims.TenantID,
				Resource: resource, ResourceNames: names,
			},
		)
	}
	if err != nil {
		return fmt.Errorf("replace Workspace inheritance: %w", err)
	}
	err = createWorkspaceAudit(ctx, q, workspaceAudit{
		request: r, organizationID: claims.TenantID, workspaceID: workspaceID,
		actorType: gatewaydb.AuditActorUser, actorID: claims.UserID,
		action: "workspace.inheritance.modify", result: gatewaydb.AuditResultSucceeded,
		interfaceName: gatewaydb.AuditInterfaceGateway,
		after:         []gatewayapi.AuditField{{Field: gatewayapi.AuditFieldName, Value: string(resourceType)}},
	})
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Workspace inheritance update: %w", err)
	}
	return nil
}

func (s *Service) recordWorkspaceInheritanceFailure(r *http.Request, claims gatewayClaims, workspaceID string, resourceType gatewayapi.InheritedResourceType) {
	err := createWorkspaceAudit(context.WithoutCancel(r.Context()), s.queries, workspaceAudit{
		request: r, organizationID: claims.TenantID, workspaceID: workspaceID,
		actorType: gatewaydb.AuditActorUser, actorID: claims.UserID,
		action: "workspace.inheritance.modify", result: gatewaydb.AuditResultFailed,
		interfaceName: gatewaydb.AuditInterfaceGateway,
		after:         []gatewayapi.AuditField{{Field: gatewayapi.AuditFieldName, Value: string(resourceType)}},
	})
	if err != nil {
		slog.ErrorContext(r.Context(), "audit failed Workspace inheritance mutation", slog.Any("err", err))
	}
}

func (s *Service) validateOrganizationResourceSelection(ctx context.Context, organizationID string, selected agentzv1alpha1.SelectedOrganizationResources) ([]gatewayapi.FieldError, error) {
	namespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	fields := []gatewayapi.FieldError{}
	kinds := []struct {
		kind  agentzv1alpha1.OrganizationResourceKind
		field string
	}{
		{agentzv1alpha1.OrganizationResourceKindSkill, "selected_organization_resources.skills"},
		{agentzv1alpha1.OrganizationResourceKindSandbox, "selected_organization_resources.sandboxes"},
		{agentzv1alpha1.OrganizationResourceKindMCPConnection, "selected_organization_resources.mcp_connections"},
		{agentzv1alpha1.OrganizationResourceKindInferenceProvider, "selected_organization_resources.inference_providers"},
	}
	for _, item := range kinds {
		seen := map[string]struct{}{}
		for i, name := range selected.Names(item.kind) {
			if strings.TrimSpace(name) == "" {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf("%s[%d]", item.field, i), Message: "must not be blank",
				})
				continue
			}
			if _, duplicate := seen[name]; duplicate {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf("%s[%d]", item.field, i), Message: "must be unique",
				})
				continue
			}
			seen[name] = struct{}{}
			key := ctrlclient.ObjectKey{Namespace: namespace, Name: name}
			var err error
			switch item.kind {
			case agentzv1alpha1.OrganizationResourceKindSkill:
				err = s.k8sClient.Get(ctx, key, &agentzv1alpha1.Skill{})
			case agentzv1alpha1.OrganizationResourceKindSandbox:
				err = s.k8sClient.Get(ctx, key, &agentzv1alpha1.Sandbox{})
			case agentzv1alpha1.OrganizationResourceKindMCPConnection:
				err = s.k8sClient.Get(ctx, key, &agentzv1alpha1.MCPConnection{})
			case agentzv1alpha1.OrganizationResourceKindInferenceProvider:
				err = s.k8sClient.Get(ctx, key, &agentzv1alpha1.InferenceProvider{})
			}
			if ctrlclient.IgnoreNotFound(err) != nil {
				return nil, fmt.Errorf("validate selected Organisation resource: %w", err)
			}
			if err != nil {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf("%s[%d]", item.field, i), Message: "was not found",
				})
			}
		}
	}
	return fields, nil
}

func insertWorkspaceResourceSelection(ctx context.Context, q gatewaydb.Querier, workspaceID, organizationID string, selected agentzv1alpha1.SelectedOrganizationResources) error {
	kinds := []struct {
		kind     agentzv1alpha1.OrganizationResourceKind
		resource gatewaydb.PermissionResource
	}{
		{agentzv1alpha1.OrganizationResourceKindSkill, gatewaydb.PermissionResourceSkill},
		{agentzv1alpha1.OrganizationResourceKindSandbox, gatewaydb.PermissionResourceSandbox},
		{agentzv1alpha1.OrganizationResourceKindMCPConnection, gatewaydb.PermissionResourceMcpConnection},
		{agentzv1alpha1.OrganizationResourceKindInferenceProvider, gatewaydb.PermissionResourceInferenceProvider},
	}
	for _, item := range kinds {
		names := selected.Names(item.kind)
		inserted, err := q.GatewayInsertWorkspaceInheritedResources(
			ctx,
			gatewaydb.GatewayInsertWorkspaceInheritedResourcesParams{
				WorkspaceID: workspaceID, OrganizationID: organizationID,
				Resource: item.resource, ResourceNames: names,
			},
		)
		if err != nil {
			return fmt.Errorf("insert Workspace inherited %s: %w", item.resource, err)
		}
		if inserted != int64(len(names)) {
			return fmt.Errorf("insert Workspace inherited %s: selection changed", item.resource)
		}
	}
	return nil
}

func (s *Service) selectedOrganizationResourceConflict(ctx context.Context, access resourceAccess, kind agentzv1alpha1.OrganizationResourceKind, name string) (*apiError, error) {
	if access.workspaceID != "" {
		return nil, nil
	}
	var resource gatewaydb.PermissionResource
	switch kind {
	case agentzv1alpha1.OrganizationResourceKindSkill:
		resource = gatewaydb.PermissionResourceSkill
	case agentzv1alpha1.OrganizationResourceKindSandbox:
		resource = gatewaydb.PermissionResourceSandbox
	case agentzv1alpha1.OrganizationResourceKindMCPConnection:
		resource = gatewaydb.PermissionResourceMcpConnection
	case agentzv1alpha1.OrganizationResourceKindInferenceProvider:
		resource = gatewaydb.PermissionResourceInferenceProvider
	default:
		return nil, fmt.Errorf("unknown Organisation resource kind %q", kind)
	}
	rows, err := s.queries.GatewayListWorkspacesSelectingOrganizationResource(
		ctx,
		gatewaydb.GatewayListWorkspacesSelectingOrganizationResourceParams{
			OrganizationID: access.claims.TenantID,
			Resource:       resource, ResourceName: name,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("list Workspaces selecting Organisation resource: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil
	}
	workspaces := make([]string, 0, len(rows))
	for _, row := range rows {
		workspaces = append(workspaces, row.Name+" ("+row.ID+")")
	}
	return newAPIError(
		http.StatusConflict,
		"resource_inherited",
		"Organisation resource is selected by one or more Workspaces",
		errBadRequest,
		gatewayapi.FieldError{
			Field: "name", Message: "selected by Workspaces: " + strings.Join(workspaces, ", "),
		},
	), nil
}

func (s *Service) workspaceInheritedResources(ctx context.Context, workspace gatewaydb.Workspace, resourceType gatewayapi.InheritedResourceType) ([]gatewayapi.WorkspaceInheritedResource, error) {
	selected, err := s.workspaceResourceSelection(ctx, workspace.ID, workspace.OrganizationID)
	if err != nil {
		return nil, err
	}
	kind, _, mapped := inheritedResourceKind(resourceType)
	if !mapped {
		return nil, fmt.Errorf("unknown inherited resource type %q", resourceType)
	}
	selectedNames := selected.Names(kind)
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		workspace.OrganizationID,
	)
	resources := []gatewayapi.WorkspaceInheritedResource{}
	appendResource := func(name string, ready bool) {
		resources = append(resources, gatewayapi.WorkspaceInheritedResource{
			Name: name, Ready: ready,
			Selected:  slices.Contains(selectedNames, name),
			Consumers: []gatewayapi.InheritedResourceConsumer{},
		})
	}
	switch resourceType {
	case gatewayapi.InheritedResourceTypeSkill:
		var list agentzv1alpha1.SkillList
		if err := s.k8sClient.List(ctx, &list, ctrlclient.InNamespace(organizationNamespace)); err != nil {
			return nil, fmt.Errorf("list Organisation Skills: %w", err)
		}
		for _, item := range list.Items {
			appendResource(item.Name, true)
		}
	case gatewayapi.InheritedResourceTypeSandbox:
		var list agentzv1alpha1.SandboxList
		if err := s.k8sClient.List(ctx, &list, ctrlclient.InNamespace(organizationNamespace)); err != nil {
			return nil, fmt.Errorf("list Organisation Sandboxes: %w", err)
		}
		for _, item := range list.Items {
			appendResource(item.Name, item.Status.InferenceReady)
		}
	case gatewayapi.InheritedResourceTypeMCPConnection:
		var list agentzv1alpha1.MCPConnectionList
		if err := s.k8sClient.List(ctx, &list, ctrlclient.InNamespace(organizationNamespace)); err != nil {
			return nil, fmt.Errorf("list Organisation MCP Connections: %w", err)
		}
		for _, item := range list.Items {
			appendResource(item.Name, item.Status.State == agentzv1alpha1.MCPConnectionStateReady)
		}
	case gatewayapi.InheritedResourceTypeInferenceProvider:
		var list agentzv1alpha1.InferenceProviderList
		if err := s.k8sClient.List(ctx, &list, ctrlclient.InNamespace(organizationNamespace)); err != nil {
			return nil, fmt.Errorf("list Organisation Inference Providers: %w", err)
		}
		for _, item := range list.Items {
			appendResource(item.Name, item.Status.State == agentzv1alpha1.InferenceProviderStateReady)
		}
	default:
		return nil, fmt.Errorf("unknown inherited resource type %q", resourceType)
	}

	consumers, err := s.inheritedResourceConsumers(ctx, workspace, resourceType)
	if err != nil {
		return nil, err
	}
	for i := range resources {
		resources[i].Consumers = consumers[resources[i].Name]
		if len(resources[i].Consumers) > 0 {
			reason := "Unselecting is blocked while this resource has consumers"
			resources[i].DisabledReason = &reason
		}
	}
	sort.Slice(resources, func(i, j int) bool {
		return resources[i].Name < resources[j].Name
	})
	return resources, nil
}

func (s *Service) inheritedResourceConsumers(ctx context.Context, workspace gatewaydb.Workspace, resourceType gatewayapi.InheritedResourceType) (map[string][]gatewayapi.InheritedResourceConsumer, error) {
	consumers := map[string][]gatewayapi.InheritedResourceConsumer{}
	add := func(name, kind, consumerName string) {
		consumer := gatewayapi.InheritedResourceConsumer{
			Kind: kind, Name: consumerName,
		}
		if !slices.Contains(consumers[name], consumer) {
			consumers[name] = append(consumers[name], consumer)
		}
	}
	var agents agentzv1alpha1.AgentList
	if err := s.k8sClient.List(ctx, &agents, ctrlclient.InNamespace(workspace.Namespace)); err != nil {
		return nil, fmt.Errorf("list inherited resource Agent consumers: %w", err)
	}
	var sandboxes agentzv1alpha1.SandboxList
	if err := s.k8sClient.List(ctx, &sandboxes, ctrlclient.InNamespace(workspace.Namespace)); err != nil {
		return nil, fmt.Errorf("list inherited resource Sandbox consumers: %w", err)
	}
	for _, agent := range agents.Items {
		if resourceType == gatewayapi.InheritedResourceTypeSandbox &&
			agent.Spec.SandboxRef.Scope == agentzv1alpha1.ResourceScopeOrganisation {
			add(agent.Spec.SandboxRef.Name, "Agent", agent.Name)
		}
		if resourceType == gatewayapi.InheritedResourceTypeSkill {
			for _, ref := range agent.Spec.Skills {
				if ref.Scope == agentzv1alpha1.ResourceScopeOrganisation {
					add(ref.Name, "Agent", agent.Name)
				}
			}
		}
	}
	for _, sandbox := range sandboxes.Items {
		switch resourceType {
		case gatewayapi.InheritedResourceTypeSkill:
			for _, ref := range sandbox.Spec.Skills {
				if ref.Scope == agentzv1alpha1.ResourceScopeOrganisation {
					add(ref.Name, "Sandbox", sandbox.Name)
				}
			}
		case gatewayapi.InheritedResourceTypeMCPConnection:
			for _, ref := range sandbox.Spec.MCPConnectionRefs {
				if ref.Scope == agentzv1alpha1.ResourceScopeOrganisation {
					add(ref.Name, "Sandbox", sandbox.Name)
				}
			}
		case gatewayapi.InheritedResourceTypeInferenceProvider:
			for _, ref := range sandbox.Spec.Inference.Models {
				if ref.Scope == agentzv1alpha1.ResourceScopeOrganisation {
					add(ref.Provider, "Sandbox", sandbox.Name)
				}
			}
		}
	}
	if resourceType == gatewayapi.InheritedResourceTypeInferenceProvider {
		var pools agentzv1alpha1.InferencePoolList
		if err := s.k8sClient.List(ctx, &pools, ctrlclient.InNamespace(workspace.Namespace)); err != nil {
			return nil, fmt.Errorf("list inherited resource Pool consumers: %w", err)
		}
		for _, pool := range pools.Items {
			for _, ref := range pool.Spec.Members {
				if ref.Scope == agentzv1alpha1.ResourceScopeOrganisation {
					add(ref.Provider, "Inference Pool", pool.Name)
				}
			}
		}
	}
	return consumers, nil
}
