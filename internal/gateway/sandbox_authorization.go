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

type sandboxAccess struct {
	claims      gatewayClaims
	namespace   string
	workspaceID string
	owner       metav1.OwnerReference
	operation   authorization.Operation
	authorized  bool
}

type sandboxAudit struct {
	access sandboxAccess
	name   string
	result gatewaydb.AuditResult
}

func (a sandboxAccess) failureResult() gatewaydb.AuditResult {
	if a.authorized {
		return gatewaydb.AuditResultFailed
	}
	return gatewaydb.AuditResultDenied
}

func (s *Service) resolveSandboxAccess(ctx context.Context, workspaceID, sandboxName string) (sandboxAccess, *apiError) {
	access := sandboxAccess{workspaceID: workspaceID}
	claims, apiErr := externalWorkspaceClaims(ctx)
	if apiErr != nil {
		return access, apiErr
	}
	access.claims = claims
	if claims.WorkspaceID != workspaceID {
		return access, sandboxForbidden(errors.New("selected Workspace does not match bearer claims"))
	}

	scopes, ok := ctx.Value(gatewayapi.GatewayBearerScopes).([]string)
	if !ok || len(scopes) != 1 {
		return access, sandboxForbidden(errors.New("sandbox operation mapping is missing or ambiguous"))
	}
	switch scopes[0] {
	case "sandbox.read":
		access.operation = authorization.OperationListSandboxes
	case "sandbox.create":
		access.operation = authorization.OperationCreateSandbox
	case "sandbox.modify":
		access.operation = authorization.OperationUpdateSandbox
	case "sandbox.delete":
		access.operation = authorization.OperationDeleteSandbox
	default:
		return access, sandboxForbidden(fmt.Errorf("sandbox operation mapping %q is unknown", scopes[0]))
	}

	effective, err := authorization.New(s.queries).Resolve(
		ctx,
		authorization.Subject{
			UserID:         claims.UserID,
			OrganizationID: claims.TenantID,
		},
	)
	if err != nil {
		return access, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("resolve sandbox permissions: %w", err),
		)
	}
	scope := authorization.Scope{
		OrganizationID: claims.TenantID,
		WorkspaceID:    workspaceID,
	}
	allowed := effective.Allows(scope, access.operation)
	creatorOnly := false
	if !allowed {
		creatorOnly = (access.operation == authorization.OperationUpdateSandbox ||
			access.operation == authorization.OperationDeleteSandbox) &&
			effective.Allows(scope, authorization.OperationCreateSandbox)
	}
	if !allowed && !creatorOnly {
		return access, sandboxForbidden(errors.New("effective sandbox permission is missing"))
	}

	if workspaceID == "" {
		tenant, err := tenantObject(ctx)
		if err != nil {
			return access, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"unexpected server error",
				fmt.Errorf("resolve Organisation sandbox scope: %w", err),
			)
		}
		if tenant.Spec.OrganizationID != claims.TenantID {
			return access, sandboxForbidden(errors.New("organisation scope identity does not match bearer claims"))
		}
		access.namespace = tenant.Status.Namespace
		access.owner = *metav1.NewControllerRef(
			tenant,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
		)
	} else {
		row, err := s.queries.GatewayGetWorkspace(
			ctx,
			gatewaydb.GatewayGetWorkspaceParams{
				ID:             workspaceID,
				OrganizationID: claims.TenantID,
			},
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return access, workspaceNotFound(workspaceID)
		}
		if err != nil {
			return access, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"unexpected server error",
				fmt.Errorf("resolve Workspace sandbox scope: %w", err),
			)
		}
		if row.DeletedAt.Valid || row.State != gatewaydb.WorkspaceStateReady {
			return access, newAPIError(
				http.StatusConflict,
				"workspace_not_ready",
				"Workspace is not ready",
				fmt.Errorf("workspace %q state is %q", row.ID, row.State),
			)
		}

		workspace := &agentzv1alpha1.Workspace{}
		err = s.k8sClient.Get(
			ctx,
			ctrlclient.ObjectKey{Name: row.Namespace},
			workspace,
		)
		if err != nil {
			return access, newAPIError(
				http.StatusConflict,
				"workspace_not_ready",
				"Workspace is not ready",
				fmt.Errorf("get Workspace sandbox scope: %w", err),
			)
		}
		validIdentity := workspace.Spec.WorkspaceID == row.ID &&
			workspace.Spec.OrganizationID == row.OrganizationID &&
			workspace.Status.Namespace == row.Namespace
		if !validIdentity {
			return access, newAPIError(
				http.StatusConflict,
				"workspace_not_ready",
				"Workspace is not ready",
				errors.New("workspace sandbox scope identity is inconsistent"),
			)
		}

		access.namespace = row.Namespace
		access.owner = *metav1.NewControllerRef(
			workspace,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Workspace"),
		)
	}

	if creatorOnly {
		sandbox := &agentzv1alpha1.Sandbox{}
		err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{
			Name:      sandboxName,
			Namespace: access.namespace,
		}, sandbox)
		if err != nil {
			return access, mapKubeHTTPError("sandbox", err)
		}
		if sandbox.Spec.CreatorUserID != claims.UserID {
			return access, sandboxForbidden(errors.New("sandbox creator privilege is missing"))
		}
	}

	access.authorized = true
	return access, nil
}

func sandboxForbidden(cause error) *apiError {
	return newAPIError(
		http.StatusForbidden,
		"forbidden",
		"request is not authorized for the selected scope",
		cause,
	)
}

func (s *Service) createSandboxAudit(ctx context.Context, r *http.Request, audit sandboxAudit) error {
	fields, err := json.Marshal([]gatewayapi.AuditField{{
		Field: gatewayapi.AuditFieldName,
		Value: audit.name,
	}})
	if err != nil {
		return fmt.Errorf("encode sandbox audit summary: %w", err)
	}

	workspaceID := pgtype.Text{}
	if audit.access.workspaceID != "" {
		workspaceID = pgtype.Text{String: audit.access.workspaceID, Valid: true}
	}
	params := gatewaydb.GatewayCreateAuditEventParams{
		ID:               "audit-" + uuid.NewString(),
		OrganizationID:   audit.access.claims.TenantID,
		WorkspaceID:      workspaceID,
		ActorType:        gatewaydb.AuditActorUser,
		ActorID:          pgtype.Text{String: audit.access.claims.UserID, Valid: true},
		TargetType:       gatewaydb.AuditTargetSandbox,
		TargetID:         audit.name,
		Category:         "sandbox",
		Action:           "sandbox." + sandboxOperationAction(audit.access.operation),
		Result:           audit.result,
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
		return fmt.Errorf("create sandbox audit event: %w", err)
	}
	return nil
}

func sandboxOperationAction(operation authorization.Operation) string {
	switch operation {
	case authorization.OperationCreateSandbox:
		return "create"
	case authorization.OperationUpdateSandbox:
		return "modify"
	case authorization.OperationDeleteSandbox:
		return "delete"
	default:
		return "unmapped"
	}
}
