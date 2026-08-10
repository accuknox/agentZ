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
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type resourceAccess struct {
	claims      gatewayClaims
	effective   authorization.Effective
	namespace   string
	workspaceID string
	owner       metav1.OwnerReference
	operation   authorization.Operation
	authorized  bool
}

type resourceAccessRequest struct {
	resource        string
	workspaceID     string
	operation       authorization.Operation
	creatorFallback authorization.Operation
	isCreator       func(context.Context, string, string) (bool, error)
}

func (a resourceAccess) failureResult() gatewaydb.AuditResult {
	if a.authorized {
		return gatewaydb.AuditResultFailed
	}
	return gatewaydb.AuditResultDenied
}

func (s *Service) resolveResourceAccess(ctx context.Context, req resourceAccessRequest) (resourceAccess, *apiError) {
	access := resourceAccess{workspaceID: req.workspaceID, operation: req.operation}
	claims, apiErr := externalWorkspaceClaims(ctx)
	if apiErr != nil {
		return access, apiErr
	}
	access.claims = claims
	if claims.WorkspaceID != req.workspaceID {
		return access, resourceForbidden(errors.New("selected Workspace does not match bearer claims"))
	}

	expectedScope, mapped := req.operation.BearerScope()
	if !mapped {
		return access, resourceForbidden(fmt.Errorf("%s operation %q is unknown", req.resource, req.operation))
	}
	scopes, ok := ctx.Value(gatewayapi.GatewayBearerScopes).([]string)
	if !ok || len(scopes) != 1 || scopes[0] != expectedScope {
		return access, resourceForbidden(fmt.Errorf("%s operation mapping is missing, ambiguous, or unknown", req.resource))
	}

	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: claims.UserID, OrganizationID: claims.TenantID,
	})
	if err != nil {
		return access, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("resolve %s permissions: %w", req.resource, err),
		)
	}
	access.effective = effective
	scope := authorization.Scope{
		OrganizationID: claims.TenantID,
		WorkspaceID:    req.workspaceID,
	}
	allowed := effective.Allows(scope, req.operation)
	creatorOnly := !allowed && req.creatorFallback != "" && req.isCreator != nil &&
		effective.Allows(scope, req.creatorFallback)
	if !allowed && !creatorOnly {
		return access, resourceForbidden(fmt.Errorf("effective %s permission is missing", req.resource))
	}

	namespace, owner, apiErr := s.resolveResourceScope(ctx, claims, req.workspaceID, req.resource)
	if apiErr != nil {
		return access, apiErr
	}
	access.namespace = namespace
	access.owner = owner

	if creatorOnly {
		creator, err := req.isCreator(ctx, access.namespace, claims.UserID)
		if err != nil {
			return access, mapKubeHTTPError(req.resource, err)
		}
		if !creator {
			return access, resourceForbidden(fmt.Errorf("%s creator privilege is missing", req.resource))
		}
	}

	access.authorized = true
	return access, nil
}

func (s *Service) resolveResourceScope(ctx context.Context, claims gatewayClaims, workspaceID string, resource string) (string, metav1.OwnerReference, *apiError) {
	if workspaceID == "" {
		tenant, err := tenantObject(ctx)
		if err != nil {
			return "", metav1.OwnerReference{}, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"unexpected server error",
				fmt.Errorf("resolve Organisation %s scope: %w", resource, err),
			)
		}
		if tenant.Spec.OrganizationID != claims.TenantID {
			return "", metav1.OwnerReference{}, resourceForbidden(errors.New("organisation identity does not match bearer claims"))
		}
		return tenant.Status.Namespace, *metav1.NewControllerRef(
			tenant,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
		), nil
	}

	row, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
		ID: workspaceID, OrganizationID: claims.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", metav1.OwnerReference{}, workspaceNotFound(workspaceID)
	}
	if err != nil {
		return "", metav1.OwnerReference{}, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("resolve Workspace %s scope: %w", resource, err),
		)
	}
	if row.DeletedAt.Valid || row.State != gatewaydb.WorkspaceStateReady {
		return "", metav1.OwnerReference{}, newAPIError(
			http.StatusConflict,
			"workspace_not_ready",
			"Workspace is not ready",
			fmt.Errorf("workspace %q state is %q", row.ID, row.State),
		)
	}
	workspace := &agentzv1alpha1.Workspace{}
	err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: row.Namespace}, workspace)
	if err != nil {
		return "", metav1.OwnerReference{}, newAPIError(
			http.StatusConflict,
			"workspace_not_ready",
			"Workspace is not ready",
			fmt.Errorf("get Workspace %s scope: %w", resource, err),
		)
	}
	valid := workspace.Spec.WorkspaceID == row.ID &&
		workspace.Spec.OrganizationID == row.OrganizationID &&
		workspace.Status.Namespace == row.Namespace
	if !valid {
		return "", metav1.OwnerReference{}, newAPIError(
			http.StatusConflict,
			"workspace_not_ready",
			"Workspace is not ready",
			fmt.Errorf("workspace %s scope identity is inconsistent", resource),
		)
	}
	return row.Namespace, *metav1.NewControllerRef(
		workspace,
		agentzv1alpha1.SchemeGroupVersion.WithKind("Workspace"),
	), nil
}

type resourceCapabilitySet struct {
	skill             gatewayapi.ResourceCapabilities
	mcp               gatewayapi.ResourceCapabilities
	sandbox           gatewayapi.ResourceCapabilities
	inferenceProvider gatewayapi.ResourceCapabilities
	inferencePool     gatewayapi.ResourceCapabilities
}

func resourceScope(workspaceID string) gatewayapi.ResourceScope {
	if workspaceID == "" {
		return gatewayapi.ResourceScopeOrganisation
	}
	return gatewayapi.ResourceScopeWorkspace
}

func (s *Service) resolveResourceCapabilities(ctx context.Context, claims gatewayClaims, workspaceID string) (resourceCapabilitySet, error) {
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: claims.UserID, OrganizationID: claims.TenantID,
	})
	if err != nil {
		return resourceCapabilitySet{}, fmt.Errorf("resolve resource capabilities: %w", err)
	}
	return resourceCapabilities(effective, claims.TenantID, workspaceID), nil
}

func resourceCapabilities(effective authorization.Effective, organizationID, workspaceID string) resourceCapabilitySet {
	scope := authorization.Scope{OrganizationID: organizationID, WorkspaceID: workspaceID}
	capabilities := resourceCapabilitySet{}
	capabilities.skill = gatewayapi.ResourceCapabilities{
		Read:   effective.Allows(scope, authorization.OperationListSkills),
		Create: effective.Allows(scope, authorization.OperationCreateSkill),
		Modify: effective.Allows(scope, authorization.OperationUpdateSkill),
		Delete: effective.Allows(scope, authorization.OperationDeleteSkill),
	}
	capabilities.mcp = gatewayapi.ResourceCapabilities{
		Read:   effective.Allows(scope, authorization.OperationListMCPConnections),
		Create: effective.Allows(scope, authorization.OperationCreateMCPConnection),
		Modify: false,
		Delete: effective.Allows(scope, authorization.OperationDeleteMCPConnection),
	}
	capabilities.sandbox = gatewayapi.ResourceCapabilities{
		Read:   effective.Allows(scope, authorization.OperationListSandboxes),
		Create: effective.Allows(scope, authorization.OperationCreateSandbox),
		Modify: effective.Allows(scope, authorization.OperationUpdateSandbox),
		Delete: effective.Allows(scope, authorization.OperationDeleteSandbox),
	}
	capabilities.inferenceProvider = gatewayapi.ResourceCapabilities{
		Read:   effective.Allows(scope, authorization.OperationListInferenceProviders),
		Create: effective.Allows(scope, authorization.OperationCreateInferenceProvider),
		Modify: effective.Allows(scope, authorization.OperationUpdateInferenceProvider),
		Delete: effective.Allows(scope, authorization.OperationDeleteInferenceProvider),
	}
	if workspaceID != "" {
		capabilities.inferencePool = gatewayapi.ResourceCapabilities{
			Read:   effective.Allows(scope, authorization.OperationListInferencePools),
			Create: effective.Allows(scope, authorization.OperationCreateInferencePool),
			Modify: effective.Allows(scope, authorization.OperationUpdateInferencePool),
			Delete: effective.Allows(scope, authorization.OperationDeleteInferencePool),
		}
	}
	return capabilities
}

func resourceForbidden(cause error) *apiError {
	return newAPIError(
		http.StatusForbidden,
		"forbidden",
		"request is not authorized for the selected scope",
		cause,
	)
}

func (s *Service) createResourceAudit(ctx context.Context, r *http.Request, access resourceAccess, target gatewaydb.AuditTarget, id, category, action string, result gatewaydb.AuditResult) error {
	fields, err := json.Marshal([]gatewayapi.AuditField{{
		Field: gatewayapi.AuditFieldName, Value: id,
	}})
	if err != nil {
		return fmt.Errorf("encode %s audit summary: %w", category, err)
	}
	workspaceID := pgtype.Text{}
	if access.workspaceID != "" {
		workspaceID = pgtype.Text{String: access.workspaceID, Valid: true}
	}
	params := gatewaydb.GatewayCreateAuditEventParams{
		ID:               "audit-" + uuid.NewString(),
		OrganizationID:   access.claims.TenantID,
		WorkspaceID:      workspaceID,
		ActorType:        gatewaydb.AuditActorUser,
		ActorID:          pgtype.Text{String: access.claims.UserID, Valid: true},
		TargetType:       target,
		TargetID:         id,
		Category:         category,
		Action:           category + "." + action,
		Result:           result,
		After:            fields,
		AutomaticCascade: false,
		Interface:        gatewaydb.AuditInterfaceGateway,
	}
	if host, _, splitErr := net.SplitHostPort(r.RemoteAddr); splitErr == nil && host != "" {
		params.IpAddress = pgtype.Text{String: host, Valid: true}
	}
	if userAgent := strings.TrimSpace(r.UserAgent()); userAgent != "" {
		params.UserAgent = pgtype.Text{String: userAgent, Valid: true}
	}
	_, err = s.queries.GatewayCreateAuditEvent(ctx, params)
	if err != nil {
		return fmt.Errorf("create %s audit event: %w", category, err)
	}
	return nil
}
