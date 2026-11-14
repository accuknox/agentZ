package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	keyfunc "github.com/MicahParks/keyfunc/v3"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/guardrails"
	observerdb "github.com/accuknox/agentz/internal/observer/db"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type copilotStudioClaims struct {
	jwt.RegisteredClaims
	TenantID      string `json:"tid"`
	ApplicationID string `json:"azp"`
	IdentityType  string `json:"idtyp"`
	Scope         string `json:"scp"`
	Version       string `json:"ver"`
}

var errCopilotStudioPolicy = errors.New("policy cannot protect Copilot Studio tool calls")

type copilotStudioPageScope struct {
	OrganizationID string `json:"organization_id"`
	WorkspaceID    string `json:"workspace_id"`
	IntegrationID  string `json:"integration_id"`
	UserID         string `json:"user_id"`
}

type copilotStudioPageCursor struct {
	Scope copilotStudioPageScope `json:"scope"`
	ID    string                 `json:"id"`
}

// ListCopilotStudioIntegrations lists a bounded page of environment connections.
func (s *Service) ListCopilotStudioIntegrations(w http.ResponseWriter, r *http.Request, params gatewayapi.ListCopilotStudioIntegrationsParams) {
	access, ok := s.copilotStudioAdministrator(w, r)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, set, ok := decodeCursorPageToken[copilotStudioPageCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	pageScope := copilotStudioPageScope{
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
		UserID:         access.userID,
	}
	if set && (cursor.Scope != pageScope || cursor.ID == "") {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	rows, err := s.queries.GatewayListCopilotStudioIntegrations(r.Context(), gatewaydb.GatewayListCopilotStudioIntegrationsParams{
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
		CursorSet:      set,
		CursorID:       cursor.ID,
		PageSize:       int32(limit + 1),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	items, next := cursorPage(
		rows, limit, s.copilotStudioIntegrationView,
		func(row gatewaydb.CopilotStudioIntegration) copilotStudioPageCursor {
			return copilotStudioPageCursor{Scope: pageScope, ID: row.ID}
		},
	)
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ListCopilotStudioIntegrationsResponse{
		Enabled:       s.cfg.CopilotStudioAudience != "",
		Integrations:  items,
		NextPageToken: next,
		Audience:      s.cfg.CopilotStudioAudience,
		BaseUrl:       s.cfg.CopilotStudioBaseURL,
	})
}

// GetCopilotStudioIntegration returns one workspace's environment connection.
func (s *Service) GetCopilotStudioIntegration(w http.ResponseWriter, r *http.Request, id string, _ gatewayapi.GetCopilotStudioIntegrationParams) {
	access, ok := s.copilotStudioAdministrator(w, r)
	if !ok {
		return
	}
	row, err := s.queries.GatewayGetCopilotStudioIntegration(r.Context(), id)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get integration", err))
		return
	}
	if row.OrganizationID != access.organizationID || row.WorkspaceID != access.workspaceID {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("integration belongs to another workspace")))
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, s.copilotStudioIntegrationView(row))
}

// ListCopilotStudioAgents pages discovered identities without loading conversation history.
func (s *Service) ListCopilotStudioAgents(w http.ResponseWriter, r *http.Request, id string, params gatewayapi.ListCopilotStudioAgentsParams) {
	access, ok := s.copilotStudioAccess(w, r)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, set, ok := decodeCursorPageToken[copilotStudioPageCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	pageScope := copilotStudioPageScope{
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
		IntegrationID:  id,
		UserID:         access.userID,
	}
	if set && (cursor.Scope != pageScope || cursor.ID == "") {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	integration, err := s.queries.GatewayGetCopilotStudioIntegration(r.Context(), id)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get integration", err))
		return
	}
	if integration.OrganizationID != access.organizationID || integration.WorkspaceID != access.workspaceID {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("integration belongs to another workspace")))
		return
	}
	scope := authorization.Scope{
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
	}
	rows, err := s.queries.GatewayListCopilotStudioAgents(r.Context(), gatewaydb.GatewayListCopilotStudioAgentsParams{
		IntegrationID:  id,
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
		Administer:     access.effective.CanAdminister(scope),
		UserID:         access.userID,
		CursorSet:      set,
		CursorID:       cursor.ID,
		PageSize:       int32(limit + 1),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	items, next := cursorPage(rows, limit, func(row gatewaydb.GatewayListCopilotStudioAgentsRow) gatewayapi.CopilotStudioAgentSummary {
		item := gatewayapi.CopilotStudioAgentSummary{
			ClientId:  row.ClientID,
			AgentId:   row.AgentID,
			Name:      row.Name,
			CreatedAt: row.CreatedAt.Time,
			Disabled:  row.Disabled,
		}
		if row.LastSeenAt.Valid {
			item.LastActiveAt = &row.LastSeenAt.Time
		}
		return item
	}, func(row gatewaydb.GatewayListCopilotStudioAgentsRow) copilotStudioPageCursor {
		return copilotStudioPageCursor{Scope: pageScope, ID: row.AgentID}
	})
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ListCopilotStudioAgentsResponse{Agents: items, NextPageToken: next})
}

// CreateCopilotStudioIntegration binds an authenticated Microsoft caller to one workspace.
func (s *Service) CreateCopilotStudioIntegration(w http.ResponseWriter, r *http.Request, _ gatewayapi.CreateCopilotStudioIntegrationParams) {
	s.saveCopilotStudioIntegration(w, r, uuid.NewString())
}

// UpdateCopilotStudioIntegration changes policy assignments and availability without moving its identity.
func (s *Service) UpdateCopilotStudioIntegration(w http.ResponseWriter, r *http.Request, id string, _ gatewayapi.UpdateCopilotStudioIntegrationParams) {
	s.saveCopilotStudioIntegration(w, r, id)
}

func (s *Service) copilotStudioAdministrator(w http.ResponseWriter, r *http.Request) (resourceAccess, bool) {
	access, ok := s.copilotStudioAccess(w, r)
	if !ok {
		return access, false
	}
	scope := authorization.Scope{
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
	}
	if !access.effective.CanAdminister(scope) {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("workspace administrator access is required")))
		return access, false
	}
	return access, true
}

func (s *Service) copilotStudioAccess(w http.ResponseWriter, r *http.Request) (resourceAccess, bool) {
	access := resourceAccess{}
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return access, false
	}
	effective, err := authorization.New(s.queries).Resolve(r.Context(), authorization.Subject{
		UserID:         claims.UserID,
		OrganizationID: claims.OrganizationID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return access, false
	}
	capabilities := resourceCapabilities(effective, claims.OrganizationID, claims.WorkspaceID)
	if claims.WorkspaceID == "" || !capabilities.externalAgent.Read {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("external use permission is required")))
		return access, false
	}
	namespace, _, apiErr := s.resolveResourceScope(r.Context(), claims, claims.WorkspaceID, "Copilot Studio")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return access, false
	}
	return resourceAccess{
		userID:         claims.UserID,
		organizationID: claims.OrganizationID,
		workspaceID:    claims.WorkspaceID,
		namespace:      namespace,
		authorized:     true,
		claims:         claims,
		effective:      effective,
	}, true
}

func (s *Service) saveCopilotStudioIntegration(w http.ResponseWriter, r *http.Request, id string) {
	access, ok := s.copilotStudioAdministrator(w, r)
	if !ok {
		return
	}
	if s.cfg.CopilotStudioAudience == "" {
		apiutil.WriteError(w, r, apiutil.NewError(503, "unavailable", "Copilot Studio is not configured on this installation.", nil))
		return
	}
	var input gatewayapi.CopilotStudioIntegrationInput
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	assignment := api.GuardrailAssignment{Policies: input.Assignment.Policies}
	if assignment.Policies == nil {
		assignment.Policies = []api.ResourceReference{}
	}
	bundle, err := guardrails.Resolve(r.Context(), s.k8sClient, access.namespace, assignment)
	if err == nil {
		err = copilotStudioPolicyCompatibility(bundle)
	}
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(400, "invalid_request", err.Error(), err))
		return
	}
	if r.Method == http.MethodPut {
		previous, getErr := s.queries.GatewayGetCopilotStudioIntegration(r.Context(), id)
		if getErr != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("get integration", getErr))
			return
		}
		if previous.OrganizationID != access.organizationID || previous.WorkspaceID != access.workspaceID {
			apiutil.WriteError(w, r, resourceForbidden(errors.New("integration belongs to another workspace")))
			return
		}
	}
	row, err := s.queries.GatewaySaveCopilotStudioIntegration(r.Context(), gatewaydb.GatewaySaveCopilotStudioIntegrationParams{
		ID:             id,
		OrganizationID: access.organizationID,
		WorkspaceID:    access.workspaceID,
		UserID:         access.userID,
		Name:           input.Name,
		TenantID:       input.TenantId.String(),
		ApplicationID:  input.ApplicationId.String(),
		EnvironmentID:  input.EnvironmentId,
		Enabled:        input.Enabled,
		FailureMode:    string(input.FailureMode),
		Policies:       assignment.Policies,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("save integration", err))
		return
	}
	status := http.StatusOK
	if r.Method == http.MethodPost {
		status = http.StatusCreated
	}
	apiutil.WriteJSON(w, status, s.copilotStudioIntegrationView(row))
}

func (s *Service) copilotStudioIntegrationView(row gatewaydb.CopilotStudioIntegration) gatewayapi.CopilotStudioIntegration {
	result := gatewayapi.CopilotStudioIntegration{
		Id:            row.ID,
		Name:          row.Name,
		TenantId:      uuid.MustParse(row.TenantID),
		ApplicationId: uuid.MustParse(row.ApplicationID),
		EnvironmentId: row.EnvironmentID,
		Enabled:       row.Enabled,
		FailureMode:   gatewayapi.CopilotStudioIntegrationFailureMode(row.FailureMode),
		Assignment:    gatewayapi.GuardrailAssignment{Policies: row.Policies},
		CreatedAt:     row.CreatedAt.Time,
		RuntimeError:  row.RuntimeError,
		Endpoint:      strings.TrimSuffix(s.cfg.CopilotStudioBaseURL, "/") + "/api/copilot-studio/webhooks/" + row.ID,
		Audience:      s.cfg.CopilotStudioAudience,
	}
	// Microsoft encodes the first three GUID fields in .NET's little-endian order.
	tenant := result.TenantId
	slices.Reverse(tenant[:4])
	slices.Reverse(tenant[4:6])
	slices.Reverse(tenant[6:8])
	result.FederatedCredential = gatewayapi.CopilotStudioFederatedCredential{
		Issuer: "https://login.microsoftonline.com/" + row.TenantID + "/v2.0",
		Subject: "/eid1/c/pub/t/" + base64.RawURLEncoding.EncodeToString(tenant[:]) +
			"/a/m1WPnYRZpEaQKq1Cceg--g/" + base64.RawURLEncoding.EncodeToString([]byte(result.Endpoint)),
		Audience: "api://AzureADTokenExchange",
	}
	if row.ValidatedAt.Valid {
		result.ValidatedAt = &row.ValidatedAt.Time
	}
	if row.LastSeenAt.Valid {
		result.LastSeenAt = &row.LastSeenAt.Time
	}
	return result
}

func copilotStudioPolicyCompatibility(bundle *guardrails.Bundle) error {
	for _, resolved := range bundle.Checks {
		check := resolved.Check
		if check.Phase == "output" {
			return fmt.Errorf("%w: check %q requires an output hook", errCopilotStudioPolicy, check.Name)
		}
		if check.Action == "mask" && check.Mode == "enforce" {
			return fmt.Errorf("%w: check %q masks content; the webhook accepts only allow or block", errCopilotStudioPolicy, check.Name)
		}
		available := false
		for _, scope := range check.Scopes {
			if scope != "instructions" {
				available = true
				break
			}
		}
		if !available {
			return fmt.Errorf("%w: check %q requires unavailable system instructions", errCopilotStudioPolicy, check.Name)
		}
	}
	return nil
}

func (s *Service) copilotStudioWebhook(w http.ResponseWriter, r *http.Request) {
	// Reserve the remaining webhook budget for durable decision recording.
	ctx, cancel := context.WithTimeout(r.Context(), 600*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	integration, err := s.queries.GatewayGetCopilotStudioIntegration(ctx, chi.URLParam(r, "integrationId"))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !integration.Enabled) {
		http.Error(w, "Integration unavailable", http.StatusNotFound)
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	s.copilotStudioMu.RLock()
	key, ok := s.copilotStudioKeys[integration.TenantID]
	s.copilotStudioMu.RUnlock()
	if !ok {
		http.Error(w, "Authentication is initializing", http.StatusServiceUnavailable)
		return
	}
	claims := copilotStudioClaims{}
	bearer := strings.Fields(r.Header.Get("Authorization"))
	if len(bearer) != 2 || !strings.EqualFold(bearer[0], "Bearer") {
		http.Error(w, "Invalid Microsoft application token", http.StatusUnauthorized)
		return
	}
	issuer := "https://login.microsoftonline.com/" + integration.TenantID + "/v2.0"
	_, err = jwt.ParseWithClaims(
		bearer[1], &claims, key.KeyfuncCtx(ctx),
		jwt.WithValidMethods([]string{"RS256"}), jwt.WithExpirationRequired(),
		jwt.WithAudience(s.cfg.CopilotStudioAudience), jwt.WithIssuer(issuer),
	)
	authenticated := err == nil && claims.Version == "2.0" && claims.TenantID == integration.TenantID
	authenticated = authenticated && claims.ApplicationID == integration.ApplicationID && claims.IdentityType == "app" && claims.Scope == ""
	if !authenticated {
		http.Error(w, "Invalid Microsoft application token", http.StatusUnauthorized)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/validate") {
		err = s.queries.GatewayTouchCopilotStudio(ctx, gatewaydb.GatewayTouchCopilotStudioParams{ID: integration.ID, Validated: true})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		apiutil.WriteJSON(w, http.StatusOK, map[string]any{"isSuccessful": true, "status": "OK"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Evaluation exceeds the request limit", http.StatusRequestEntityTooLarge)
		return
	}
	var input gatewayapi.CopilotStudioEvaluationRequest
	var document any
	err = json.Unmarshal(body, &document)
	if err == nil {
		err = s.openAPI.Components.Schemas["CopilotStudioEvaluationRequest"].Value.VisitJSON(document)
	}
	if err != nil {
		var schemaError *openapi3.SchemaError
		if errors.As(err, &schemaError) {
			slog.WarnContext(ctx, "Invalid Copilot Studio webhook contract", "integration", integration.ID,
				"field", schemaError.JSONPointer(), "reason", schemaError.Reason)
		}
		http.Error(w, "Evaluation does not match the Microsoft webhook contract", http.StatusBadRequest)
		return
	}
	if err = json.Unmarshal(body, &input); err != nil {
		http.Error(w, "Invalid evaluation payload", http.StatusBadRequest)
		return
	}
	if input.PlannerContext.PreviousToolOutputs == nil {
		input.PlannerContext.PreviousToolOutputs = input.PlannerContext.PreviousToolsOutputs
	}
	metadata := input.ConversationMetadata
	agent := metadata.Agent
	if agent.TenantId != integration.TenantID || agent.EnvironmentId != integration.EnvironmentID {
		http.Error(w, "Evaluation does not match the configured environment", http.StatusForbidden)
		return
	}
	identity := sha256.Sum256([]byte(integration.ID + "\x00" + agent.Id))
	clientID := "mcs-" + hex.EncodeToString(identity[:16])
	name := agent.Id
	if agent.Name != nil && *agent.Name != "" {
		name = *agent.Name
	}
	registration := gatewaydb.GatewayRegisterCopilotStudioAgentParams{
		IntegrationID: integration.ID,
		ClientID:      clientID,
		AgentID:       agent.Id,
		Name:          pgtype.Text{String: name, Valid: true},
	}
	registered, err := s.queries.GatewayRegisterCopilotStudioAgent(ctx, registration)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent first callback can commit after this statement's snapshot.
		registered, err = s.queries.GatewayRegisterCopilotStudioAgent(ctx, registration)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "Agent is disconnected", http.StatusForbidden)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}
	assignment := api.GuardrailAssignment{Policies: integration.Policies}
	selected, selectErr := s.queries.GatewayGetExternalAgentGuardrails(ctx, gatewaydb.GatewayGetExternalAgentGuardrailsParams{
		OrganizationID: integration.OrganizationID,
		WorkspaceID:    integration.WorkspaceID,
		ClientID:       clientID,
	})
	if selectErr == nil {
		assignment.Policies = selected
	}
	if selectErr != nil && !errors.Is(selectErr, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, selectErr)
		return
	}
	messages := []gatewayapi.GuardrailEvaluationMessage{}
	if input.PlannerContext.ChatHistory != nil {
		history := *input.PlannerContext.ChatHistory
		timestamped := !slices.ContainsFunc(history, func(message gatewayapi.CopilotStudioChatMessage) bool {
			return message.Timestamp == nil
		})
		// Order messages by timestamp when Microsoft supplies one for every message.
		if timestamped {
			slices.SortStableFunc(history, func(a, b gatewayapi.CopilotStudioChatMessage) int {
				return a.Timestamp.Compare(*b.Timestamp)
			})
		}
		for _, message := range history {
			switch message.Role {
			case "user", "assistant":
				messages = append(messages, gatewayapi.GuardrailEvaluationMessage{
					Role:    gatewayapi.GuardrailEvaluationMessageRole(message.Role),
					Content: message.Content,
				})
			}
		}
	}
	currentMessageIncluded := false
	if len(messages) > 0 {
		last := messages[len(messages)-1]
		currentMessageIncluded = last.Role == gatewayapi.GuardrailEvaluationMessageRoleUser && last.Content == input.PlannerContext.UserMessage
	}
	if !currentMessageIncluded {
		messages = append(messages, gatewayapi.GuardrailEvaluationMessage{
			Role:    gatewayapi.GuardrailEvaluationMessageRoleUser,
			Content: input.PlannerContext.UserMessage,
		})
	}
	outputs := input.PlannerContext.PreviousToolOutputs
	if outputs != nil {
		for _, output := range *outputs {
			content, marshalErr := json.Marshal(output.Outputs)
			if marshalErr != nil {
				apiutil.WriteInternalError(w, r, marshalErr)
				return
			}
			messages = append(messages, gatewayapi.GuardrailEvaluationMessage{
				Role:       gatewayapi.GuardrailEvaluationMessageRoleTool,
				Content:    string(content),
				ToolCallId: &output.ToolId,
			})
		}
	}
	namespace := api.ScopeNamespace(api.ResourceScopeWorkspace, integration.WorkspaceID)
	result, err := s.evaluateCopilotStudio(ctx, namespace, assignment, input, messages)
	decision := gatewayapi.CopilotStudioEvaluationResponse{BlockAction: result.Blocked}
	if result.Blocked {
		decision.Reason = new("The proposed tool invocation was blocked by an AgentZ guardrail policy.")
	}
	if err != nil {
		decision.BlockAction = integration.FailureMode == "closed" || errors.Is(err, errCopilotStudioPolicy)
		message := "The current policy could not be evaluated by the guardrail runtime."
		switch {
		case errors.Is(err, context.Canceled):
			message = "The webhook caller disconnected before the guardrail evaluation completed."
		case errors.Is(err, context.DeadlineExceeded):
			message = "The guardrail evaluation exceeded its time limit."
		}
		decision.Reason = &message
		action := gatewayapi.GuardrailRuntimeEvaluationActionFailOpen
		if decision.BlockAction {
			action = gatewayapi.GuardrailRuntimeEvaluationActionReject
		}
		result.Evaluations = append(result.Evaluations, gatewayapi.GuardrailRuntimeEvaluation{
			Phase:  gatewayapi.GuardrailRuntimeEvaluationPhaseRequest,
			Guard:  "copilot-studio-runtime",
			Action: action,
			Error:  &message,
		})
		slog.WarnContext(ctx, "Copilot Studio guardrail evaluation unavailable", "integration", integration.ID, "error", err)
	}
	// Evaluation deadlines and caller disconnects must not erase the decision.
	recordCtx, cancelRecording := context.WithTimeout(context.WithoutCancel(r.Context()), 200*time.Millisecond)
	defer cancelRecording()
	err = s.storeCopilotStudioObservation(
		recordCtx, integration, registered, input, messages, result, decision, r.Header.Get("x-ms-correlation-id"), body,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, decision)
}

func (s *Service) copilotStudioKey(ctx context.Context, tenant string) error {
	s.copilotStudioMu.RLock()
	_, ok := s.copilotStudioKeys[tenant]
	s.copilotStudioMu.RUnlock()
	if ok {
		return nil
	}
	key, err := newExternalJWTKeyfunc(ctx, "https://login.microsoftonline.com/"+tenant+"/discovery/v2.0/keys")
	if err != nil {
		return err
	}
	s.copilotStudioMu.Lock()
	if s.copilotStudioKeys == nil {
		s.copilotStudioKeys = make(map[string]keyfunc.Keyfunc)
	}
	s.copilotStudioKeys[tenant] = key
	s.copilotStudioMu.Unlock()
	return nil
}

func (s *Service) evaluateCopilotStudio(ctx context.Context, namespace string, assignment api.GuardrailAssignment, input gatewayapi.CopilotStudioEvaluationRequest, conversation []gatewayapi.GuardrailEvaluationMessage) (gatewayapi.GuardrailEvaluationResult, error) {
	result := gatewayapi.GuardrailEvaluationResult{
		Evaluations: []gatewayapi.GuardrailRuntimeEvaluation{},
	}
	bundle, err := guardrails.Resolve(ctx, s.k8sClient, namespace, assignment)
	if err != nil {
		return result, err
	}
	if err = copilotStudioPolicyCompatibility(bundle); err != nil {
		return result, err
	}
	result.Revision = bundle.Revision
	if len(bundle.Checks) == 0 {
		return result, nil
	}
	name := "guard-" + bundle.Revision[:24]
	requestURL := strings.TrimSuffix(s.cfg.DelegationGatewayURL, "/") + "/" + name + "/v1/chat/completions"
	messages := make([]any, 0, len(conversation)+1)
	for _, message := range conversation {
		messages = append(messages, message)
	}
	args, err := json.Marshal(input.InputValues)
	if err != nil {
		return result, err
	}
	messages = append(messages, map[string]any{
		"role":    "assistant",
		"content": "",
		"tool_calls": []map[string]any{{
			"id":       "proposed-tool",
			"type":     "function",
			"function": map[string]string{"name": input.ToolDefinition.Name, "arguments": string(args)},
		}},
	})
	payload, err := json.Marshal(map[string]any{
		"model":    "guardrail-evaluation",
		"stream":   false,
		"messages": messages,
	})
	if err != nil {
		return result, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(payload))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.outboundHTTP.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusUnprocessableEntity {
		return result, fmt.Errorf("guardrail runtime returned HTTP %d", response.StatusCode)
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return result, fmt.Errorf("guardrail runtime result: %w", err)
	}
	if result.Revision != bundle.Revision {
		return result, errors.New("guardrail runtime has not applied the current policy revision")
	}
	for _, evaluation := range result.Evaluations {
		switch evaluation.Action {
		case gatewayapi.GuardrailRuntimeEvaluationActionReject, gatewayapi.GuardrailRuntimeEvaluationActionMask:
			result.Blocked = true
		}
	}
	if response.StatusCode == http.StatusUnprocessableEntity && !result.Blocked {
		return result, errors.New("guardrail runtime rejected evaluation without a blocking result")
	}
	return result, nil
}

func (s *Service) storeCopilotStudioObservation(ctx context.Context, integration gatewaydb.CopilotStudioIntegration, agent gatewaydb.GatewayRegisterCopilotStudioAgentRow, input gatewayapi.CopilotStudioEvaluationRequest, conversation []gatewayapi.GuardrailEvaluationMessage, result gatewayapi.GuardrailEvaluationResult, decision gatewayapi.CopilotStudioEvaluationResponse, correlation string, body []byte) error {
	now := time.Now().UTC()
	metadata := input.ConversationMetadata
	turn := correlation
	// A callback identifies a proposed action, not a new user turn. Reuse the
	// originating message identity so cumulative history is inserted only once.
	if input.PlannerContext.ChatHistory != nil {
		for _, message := range slices.Backward(*input.PlannerContext.ChatHistory) {
			if message.Role != "user" || message.Content != input.PlannerContext.UserMessage {
				continue
			}
			if message.Id != "" {
				turn = "message:" + message.Id
			}
			break
		}
	}
	if metadata.PlanId != nil && *metadata.PlanId != "" {
		turn = *metadata.PlanId
	}
	if turn == "" {
		turn = uuid.NewString()
	}
	trace := sha256.Sum256([]byte(agent.ClientID + "\x00" + metadata.ConversationId + "\x00" + turn))
	root := sha256.Sum256(append(trace[:], []byte("root")...))
	event := correlation
	if event == "" && metadata.PlanStepId != nil {
		event = *metadata.PlanStepId
	}
	if event == "" {
		event = uuid.NewString()
	}
	step := sha256.Sum256(append(trace[:], []byte(event)...))
	messages, err := json.Marshal(conversation)
	if err != nil {
		return err
	}
	arguments, err := json.Marshal(input.InputValues)
	if err != nil {
		return err
	}
	appName := metadata.Agent.Id
	if metadata.Agent.Name != nil && *metadata.Agent.Name != "" {
		appName = *metadata.Agent.Name
	}
	base := observerdb.InsertNativeAppOperationParams{
		OrganizationID:    integration.OrganizationID,
		WorkspaceID:       integration.WorkspaceID,
		ClientID:          agent.ClientID,
		AppName:           appName,
		UserID:            agent.UserID,
		ResourceNamespace: api.ScopeNamespace(api.ResourceScopeWorkspace, integration.WorkspaceID),
		ResourceName:      agent.ClientID,
		ResourceUid:       agent.ClientID,
		TargetID:          agent.ClientID,
		TraceID:           trace[:16],
		SpanID:            root[:8],
		ParentSpanID:      []byte{},
		StartTime:         now,
		EndTime:           now,
		Name:              "Copilot Studio context",
		ResourceKind:      "turn",
		SpanClass:         "session",
		OperationName:     "observe_context",
		StatusCode:        "UNSET",
		SessionID:         metadata.ConversationId,
		TurnID:            turn,
		AgentKind:         string(agent.Kind),
		InputMessages:     messages,
		OutputMessages:    []byte("null"),
		ToolArguments:     []byte("null"),
		ToolResult:        []byte("null"),
		ToolError:         []byte("null"),
	}
	tool := base
	tool.ResourceKind = "tool"
	tool.ResourceName = input.ToolDefinition.Type
	// Definition IDs can be reused. Attach output only when its ID matches
	// exactly one call in this session; delivery IDs cannot identify results.
	tool.ExternalToolID = input.ToolDefinition.Id
	tool.ResourceUid = integration.ID + ":" + input.ToolDefinition.Type
	tool.Name = input.ToolDefinition.Name
	tool.ToolName = input.ToolDefinition.Name
	tool.SpanClass = "tool"
	tool.SpanID = step[:8]
	tool.ParentSpanID = root[:8]
	tool.ToolCallID = event
	tool.InputMessages = []byte("null")
	tool.ToolArguments = arguments
	tool.OperationName = "allow_tool"
	if decision.BlockAction {
		tool.OperationName = "block_tool"
		tool.StatusCode = "ERROR"
		tool.ErrorType = "guardrail_blocked"
		tool.ErrorMessage = "Blocked before tool execution."
	}
	rows := []observerdb.InsertNativeAppOperationParams{base, tool}
	outputs := input.PlannerContext.PreviousToolOutputs
	var results []observerdb.UpdateCopilotStudioToolResultParams
	if outputs != nil {
		results = make([]observerdb.UpdateCopilotStudioToolResultParams, 0, len(*outputs))
		for _, output := range *outputs {
			content, err := json.Marshal(output.Outputs)
			if err != nil {
				return err
			}
			update := observerdb.UpdateCopilotStudioToolResultParams{
				OrganizationID: integration.OrganizationID,
				WorkspaceID:    integration.WorkspaceID,
				ClientID:       agent.ClientID,
				UserID:         agent.UserID,
				SessionID:      metadata.ConversationId,
				ToolID:         output.ToolId,
				ToolResult:     content,
			}
			if output.Timestamp != nil {
				update.CompletedAt = pgtype.Timestamptz{Time: *output.Timestamp, Valid: true}
			}
			results = append(results, update)
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := observerdb.New(tx)
	q.InsertNativeAppOperation(ctx, rows).QueryRow(func(_ int, _ int64, next error) {
		err = errors.Join(err, next)
	})
	if err != nil {
		return err
	}
	if len(results) > 0 {
		q.UpdateCopilotStudioToolResult(ctx, results).Exec(func(_ int, next error) {
			err = errors.Join(err, next)
		})
		if err != nil {
			return err
		}
	}

	err = q.AssignNativeRuns(ctx, observerdb.AssignNativeRunsParams{
		OrganizationID: integration.OrganizationID,
		WorkspaceID:    integration.WorkspaceID,
		ClientID:       agent.ClientID,
		TraceIds:       [][]byte{trace[:16]},
	})
	if err != nil {
		return err
	}
	for index, check := range result.Evaluations {
		evidence, marshalErr := json.Marshal(check)
		if marshalErr != nil {
			return marshalErr
		}
		_, err = q.InsertGuardrailEvent(ctx, observerdb.InsertGuardrailEventParams{
			ID:             fmt.Sprintf("%x:%x:%d", trace[:16], step[:8], index),
			OrganizationID: integration.OrganizationID,
			WorkspaceID:    integration.WorkspaceID,
			OccurredAt:     now,
			ExpiresAt:      now.Add(30 * 24 * time.Hour),
			ClientID:       agent.ClientID,
			SessionID:      metadata.ConversationId,
			TraceID:        trace[:16],
			SpanID:         step[:8],
			Revision:       result.Revision,
			Phase:          string(check.Phase),
			Action:         string(check.Action),
			Evaluation:     evidence,
		})
		if err != nil {
			return err
		}
	}
	if len(result.Evaluations) > 0 {
		err = q.InsertGuardrailRequest(ctx, observerdb.InsertGuardrailRequestParams{
			TraceID:   trace[:16],
			SpanID:    step[:8],
			ExpiresAt: now.Add(30 * 24 * time.Hour),
			Body:      body,
		})
		if err != nil {
			return err
		}
	}
	err = gatewaydb.New(tx).GatewayTouchCopilotStudio(ctx, gatewaydb.GatewayTouchCopilotStudioParams{
		ID:      integration.ID,
		AgentID: metadata.Agent.Id,
	})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
