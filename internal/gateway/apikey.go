package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
)

const (
	openCodeAPIKeyConfigID = "opencode"
	webhookAPIKeyConfigID  = "webhook"
)

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

	scope, targets, err := s.resolveAPIKeyTargets(
		r.Context(),
		key,
		gatewaydb.ApiKeyTargetTypeAgent,
	)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	if agentName == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	var allowed bool
	for _, target := range targets {
		if target.AgentName == agentName {
			allowed = true
			break
		}
	}
	if !allowed {
		return requestAuth{}, invalidAPIKeyAuthError(
			fmt.Errorf("api key %q is not authorized for agent %q", key.ID, agentName),
		)
	}
	actorName := key.ID
	if key.Name.Valid {
		actorName = key.Name.String
	}
	return requestAuth{
		apiKeyID:        key.ID,
		actorType:       requestActorAPIKey,
		actorID:         key.ID,
		actorName:       actorName,
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

	scope, targets, err := s.resolveAPIKeyTargets(
		r.Context(),
		key,
		gatewaydb.ApiKeyTargetTypeWorkflow,
	)
	if err != nil {
		return requestAuth{}, invalidAPIKeyAuthError(err)
	}

	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	workflowName := strings.TrimSpace(chi.URLParam(r, "workflowName"))
	if agentName == "" || workflowName == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	var allowed bool
	for _, target := range targets {
		if target.AgentName == agentName && target.WorkflowName == workflowName {
			allowed = true
			break
		}
	}
	if !allowed {
		return requestAuth{}, invalidAPIKeyAuthError(
			fmt.Errorf(
				"api key %q is not authorized for workflow %q/%q",
				key.ID,
				agentName,
				workflowName,
			),
		)
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
	gatewaydb.ApiKeyScope
	TenantNamespace string
}

func (s *Service) apiKeyScope(ctx context.Context, key gatewaydb.GatewayGetAPIKeyByHashRow) (apiKeyScope, error) {
	scope, err := s.queries.GatewayGetAPIKeyScopeByKey(
		ctx,
		gatewaydb.GatewayGetAPIKeyScopeByKeyParams{
			ApiKeyID:       key.ID,
			OrganizationID: key.ReferenceID,
		},
	)
	if err != nil {
		return apiKeyScope{}, fmt.Errorf("resolve api key scope: %w", err)
	}
	workspace, err := s.queries.GatewayGetWorkspace(
		ctx,
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             scope.WorkspaceID,
			OrganizationID: scope.OrganizationID,
		},
	)
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
		ApiKeyScope:     scope,
		TenantNamespace: workspace.Namespace,
	}, nil
}

func (s *Service) resolveAPIKeyTargets(ctx context.Context, key gatewaydb.GatewayGetAPIKeyByHashRow, targetType gatewaydb.ApiKeyTargetType) (apiKeyScope, []gatewaydb.GatewayListAPIKeyTargetsRow, error) {
	scope, err := s.apiKeyScope(ctx, key)
	if err != nil {
		return apiKeyScope{}, nil, err
	}
	targets, err := s.queries.GatewayListAPIKeyTargets(ctx, key.ID)
	if err != nil {
		return apiKeyScope{}, nil, fmt.Errorf("list api key targets: %w", err)
	}
	if len(targets) == 0 {
		reason := "API key has no targets."
		if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
			return apiKeyScope{}, nil, err
		}
		return apiKeyScope{}, nil, errors.New(reason)
	}
	for _, target := range targets {
		if target.TargetType == targetType {
			continue
		}
		reason := "API key target type does not match its credential type."
		if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
			return apiKeyScope{}, nil, err
		}
		return apiKeyScope{}, nil, errors.New(reason)
	}
	if err := s.validateAPIKeyTargets(ctx, scope, targets); err != nil {
		return apiKeyScope{}, nil, err
	}
	return scope, targets, nil
}

func (s *Service) validateAPIKeyTargets(ctx context.Context, scope apiKeyScope, targets []gatewaydb.GatewayListAPIKeyTargetsRow) error {
	claims := gatewayClaims{
		OrganizationID: scope.OrganizationID,
		ScopeType:      gatewayScopeWorkspace,
		ScopeID:        scope.WorkspaceID,
		UserID:         scope.CreatorUserID,
		WorkspaceID:    scope.WorkspaceID,
	}
	effective, err := authorization.New(s.queries).Resolve(
		ctx,
		authorization.Subject{
			UserID:         scope.CreatorUserID,
			OrganizationID: scope.OrganizationID,
		},
	)
	if err != nil {
		return fmt.Errorf("resolve api key creator permissions: %w", err)
	}
	access := resourceAccess{
		claims:      claims,
		effective:   effective,
		workspaceID: scope.WorkspaceID,
	}
	validatedAgents := make(map[string]struct{}, len(targets))
	workflows := workflowdb.New(s.db)
	for _, target := range targets {
		if _, ok := validatedAgents[target.AgentName]; !ok {
			_, err := s.queries.GatewayGetAgentOwner(
				ctx,
				gatewaydb.GatewayGetAgentOwnerParams{
					OrganizationID: scope.OrganizationID,
					WorkspaceID:    scope.WorkspaceID,
					AgentName:      target.AgentName,
				},
			)
			if err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("resolve api key Agent target: %w", err)
				}
				reason := "Target Agent " + target.AgentName + " no longer exists."
				if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
					return err
				}
				return errors.New(reason)
			}
			allowed, err := s.agentOperationAllowed(
				ctx,
				access,
				target.AgentName,
				authorization.OperationUseSharedAgent,
			)
			if err != nil {
				return err
			}
			if !allowed {
				reason := "Creator no longer has access to Agent " + target.AgentName + "."
				if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
					return err
				}
				return errors.New(reason)
			}
			validatedAgents[target.AgentName] = struct{}{}
		}

		if target.TargetType != gatewaydb.ApiKeyTargetTypeWorkflow {
			continue
		}
		_, err := workflows.WorkflowGet(
			ctx,
			workflowdb.WorkflowGetParams{
				TenantNamespace: scope.TenantNamespace,
				AgentName:       target.AgentName,
				WorkflowName:    target.WorkflowName,
			},
		)
		if err == nil {
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("resolve api key workflow target: %w", err)
		}
		reason := "Target Workflow " + target.AgentName + "/" + target.WorkflowName + " no longer exists."
		if err := s.revokeAPIKeyScope(ctx, scope, reason); err != nil {
			return err
		}
		return errors.New(reason)
	}
	return nil
}

func (s *Service) revokeAPIKeyScope(ctx context.Context, scope apiKeyScope, reason string) error {
	now := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	_, err := s.queries.GatewayRevokeScopedAPIKey(
		ctx,
		gatewaydb.GatewayRevokeScopedAPIKeyParams{
			ApiKeyID:       scope.ApiKeyID,
			EventTrailID:   "event-trail-" + uuid.NewString(),
			OrganizationID: scope.OrganizationID,
			WorkspaceID:    scope.WorkspaceID,
			RevokedAt:      now,
			RevokedReason:  pgtype.Text{String: reason, Valid: true},
			UpdatedAt:      pgtype.Timestamp{Time: now.Time, Valid: true},
		},
	)
	if err != nil {
		return fmt.Errorf("revoke api key scope: %w", err)
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

func hashAPIKey(key string) string {
	mac := hmac.New(sha256.New, pepperKey)
	mac.Write([]byte(key))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
