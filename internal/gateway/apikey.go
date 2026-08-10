package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

const (
	openCodeAPIKeyConfigID = "opencode"
	webhookAPIKeyConfigID  = "webhook"
)

type apiKeyPermissions struct {
	Opencode []string `json:"opencode"`
	Webhook  []string `json:"webhook"`
}

func (s *Service) resolveOpenCodeAPIKeyAuth(r *http.Request) (requestAuth, error) {
	username, password, ok := r.BasicAuth()
	if !ok {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if username != "opencode" || strings.TrimSpace(password) == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}

	key, err := s.getAPIKeyByHash(r.Context(), password, openCodeAPIKeyConfigID)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	var perms apiKeyPermissions
	if !key.Permissions.Valid {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if err := json.Unmarshal([]byte(key.Permissions.String), &perms); err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}
	scope, err := s.apiKeyScope(r.Context(), key)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	if agentName == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if !allowOpenCodeAgent(perms.Opencode, agentName) {
		return requestAuth{}, invalidAPIKeyAuthError(
			fmt.Errorf("api key %q is not authorized for agent %q", key.ID, agentName),
		)
	}
	if err := s.validateAPIKeyAgentScope(r.Context(), scope, agentName); err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	return requestAuth{
		apiKeyID:        key.ID,
		organizationID:  key.ReferenceID,
		workspaceID:     scope.WorkspaceID,
		tenantNamespace: scope.TenantNamespace,
	}, nil
}

func (s *Service) resolveWebhookAPIKeyAuth(r *http.Request) (requestAuth, error) {
	rawKey := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if rawKey == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}

	key, err := s.getAPIKeyByHash(r.Context(), rawKey, webhookAPIKeyConfigID)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	var perms apiKeyPermissions
	if !key.Permissions.Valid {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if err := json.Unmarshal([]byte(key.Permissions.String), &perms); err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}
	scope, err := s.apiKeyScope(r.Context(), key)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	workflowName := strings.TrimSpace(chi.URLParam(r, "workflowName"))
	if agentName == "" || workflowName == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if !allowWebhookWorkflow(perms.Webhook, agentName, workflowName) {
		return requestAuth{}, invalidAPIKeyAuthError(
			fmt.Errorf(
				"api key %q is not authorized for workflow %q/%q",
				key.ID,
				agentName,
				workflowName,
			),
		)
	}
	if err := s.validateAPIKeyAgentScope(r.Context(), scope, agentName); err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	return requestAuth{
		apiKeyID:        key.ID,
		organizationID:  key.ReferenceID,
		workspaceID:     scope.WorkspaceID,
		tenantNamespace: scope.TenantNamespace,
	}, nil
}

func (s *Service) getAPIKeyByHash(ctx context.Context, rawKey string, configID string) (gatewaydb.GatewayGetAPIKeyByHashRow, error) {
	return s.queries.GatewayGetAPIKeyByHash(
		ctx,
		gatewaydb.GatewayGetAPIKeyByHashParams{
			Key:      hashAPIKey(rawKey),
			ConfigID: configID,
			NowAt: pgtype.Timestamp{
				Time:  time.Now().UTC(),
				Valid: true,
			},
		},
	)
}

type apiKeyScope struct {
	gatewaydb.GatewayGetAPIKeyScopeByKeyRow
	TenantNamespace string
}

func (s *Service) apiKeyScope(ctx context.Context, key gatewaydb.GatewayGetAPIKeyByHashRow) (apiKeyScope, error) {
	scope, err := s.queries.GatewayGetAPIKeyScopeByKey(ctx, gatewaydb.GatewayGetAPIKeyScopeByKeyParams{
		ApiKeyID:       key.ID,
		OrganizationID: key.ReferenceID,
	})
	if err != nil {
		return apiKeyScope{}, fmt.Errorf("resolve api key scope: %w", err)
	}
	workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
		ID:             scope.WorkspaceID,
		OrganizationID: scope.OrganizationID,
	})
	if err != nil {
		return apiKeyScope{}, fmt.Errorf("resolve api key workspace: %w", err)
	}
	if scope.RevokedAt.Valid {
		reason := strings.TrimSpace(scope.RevokedReason.String)
		if reason == "" {
			reason = "api key was revoked"
		}
		return apiKeyScope{}, fmt.Errorf("api key scope revoked: %s", reason)
	}
	return apiKeyScope{
		GatewayGetAPIKeyScopeByKeyRow: scope,
		TenantNamespace:               workspace.Namespace,
	}, nil
}

func (s *Service) validateAPIKeyAgentScope(ctx context.Context, scope apiKeyScope, agentName string) error {
	_, err := s.queries.GatewayGetAgentOwner(ctx, gatewaydb.GatewayGetAgentOwnerParams{
		OrganizationID: scope.OrganizationID,
		WorkspaceID:    scope.WorkspaceID,
		AgentName:      agentName,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			reason := "Target Agent " + agentName + " no longer exists."
			if revokeErr := s.revokeAPIKeyScope(ctx, scope, reason); revokeErr != nil {
				return revokeErr
			}
		}
		return fmt.Errorf("resolve api key agent scope: %w", err)
	}

	claims := gatewayClaims{
		UserID:      scope.CreatorUserID,
		TenantID:    scope.OrganizationID,
		WorkspaceID: scope.WorkspaceID,
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID:         scope.CreatorUserID,
		OrganizationID: scope.OrganizationID,
	})
	if err != nil {
		return fmt.Errorf("resolve api key creator permissions: %w", err)
	}
	allowed, err := s.agentOperationAllowed(ctx, claims, effective, authorization.Scope{
		OrganizationID: scope.OrganizationID,
		WorkspaceID:    scope.WorkspaceID,
	}, agentName, authorization.OperationUseSharedAgent)
	if err != nil {
		return err
	}
	if !allowed {
		reason := "Creator no longer has access to Agent " + agentName + "."
		if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
			return err
		}
		return fmt.Errorf("api key creator no longer has access to agent %q", agentName)
	}
	return nil
}

func (s *Service) revokeAPIKeyScope(ctx context.Context, scope apiKeyScope, reason string) error {
	now := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	_, err := s.queries.GatewayRevokeScopedAPIKey(ctx, gatewaydb.GatewayRevokeScopedAPIKeyParams{
		ApiKeyID:       scope.ApiKeyID,
		OrganizationID: scope.OrganizationID,
		WorkspaceID:    scope.WorkspaceID,
		RevokedAt:      now,
		RevokedReason:  pgtype.Text{String: reason, Valid: true},
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("revoke api key scope: %w", err)
	}
	_, err = s.queries.GatewayDisableAPIKey(ctx, gatewaydb.GatewayDisableAPIKeyParams{
		ApiKeyID:       scope.ApiKeyID,
		OrganizationID: scope.OrganizationID,
		UpdatedAt:      pgtype.Timestamp{Time: now.Time, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("disable api key: %w", err)
	}
	return nil
}

func invalidAPIKeyAuthError(err error) *apiError {
	return newAPIError(
		http.StatusUnauthorized,
		"unauthorized",
		"missing or invalid credentials",
		err,
	)
}

func allowOpenCodeAgent(scopes []string, agentName string) bool {
	if len(scopes) == 0 {
		return false
	}

	allowed := "agent:" + agentName
	for _, scope := range scopes {
		switch scope {
		case "all":
			return true
		case allowed:
			return true
		}
	}

	return false
}

func allowWebhookWorkflow(scopes []string, agentName string, workflowName string) bool {
	if len(scopes) == 0 {
		return false
	}

	allowed := "workflow:" + agentName + ":" + workflowName
	for _, scope := range scopes {
		switch scope {
		case "all":
			return true
		case allowed:
			return true
		}
	}

	return false
}

func hashAPIKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
