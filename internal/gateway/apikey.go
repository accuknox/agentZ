package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

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

	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	if agentName == "" {
		return requestAuth{}, invalidAPIKeyAuthError(errBadRequest)
	}
	if !allowOpenCodeAgent(perms.Opencode, agentName) {
		return requestAuth{}, invalidAPIKeyAuthError(
			fmt.Errorf("api key %q is not authorized for agent %q", key.ID, agentName),
		)
	}

	return requestAuth{
		apiKeyID:       key.ID,
		organizationID: key.ReferenceID,
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

	return requestAuth{
		apiKeyID:       key.ID,
		organizationID: key.ReferenceID,
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
