package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	gatewaydb "github.com/accuknox/clawarmor/internal/agent/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

// ListAgents handles GET /api/list-agents.
func (s *Service) ListAgents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListAgentsParams) {
	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	sessionIDs := []string{}
	if params.SessionId != nil {
		sessionIDs = make([]string, 0, len(*params.SessionId))
		for _, id := range *params.SessionId {
			sessionID, _, ok := validSessionID(w, r, id.String())
			if !ok {
				return
			}
			sessionIDs = append(sessionIDs, sessionID)
		}
	}

	items, next, err := s.listAgentItems(r.Context(), sessionIDs, limit, offset)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
		Agents:        items,
		NextPageToken: next,
	})
}

// CreateAgent handles POST /api/create-agent.
//
//nolint:gocyclo
func (s *Service) CreateAgent(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, mode, fields := validateCreateAgentRequest(req)
	envFields, err := s.validateAgentEnvironmentName(r.Context(), req.EnvironmentName)
	fields = append(fields, envFields...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	sessionID := uuid.New()
	row, err := s.queries.GatewayCreateSession(r.Context(), gatewaydb.GatewayCreateSessionParams{
		SessionID: sessionID,
		AgentName: name,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create session", err))
		return
	}

	agt := s.agentFromCreateRequest(req, sessionID, name, mode)
	_, err = s.resolver.client.ApiV1alpha1().Agents(s.cfg.Namespace).Create(
		r.Context(),
		agt,
		metav1.CreateOptions{},
	)
	if err != nil {
		if _, deleteErr := s.queries.GatewayDeleteSession(r.Context(), sessionID); deleteErr != nil {
			err = fmt.Errorf("create agent: %w; rollback session: %v", err, deleteErr)
		}
		writeError(w, r, mapKubeHTTPError("create agent", err))
		return
	}

	writeJSON(w, http.StatusCreated, gatewayapi.Agent{
		Name:         row.AgentName,
		SessionId:    row.SessionID,
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       gatewayapi.PROGRESSING,
	})
}

// UpdateAgent handles POST /api/update-agent/{sessionID}.
func (s *Service) UpdateAgent(w http.ResponseWriter, r *http.Request, sessionID gatewayapi.SessionIDPath) {
	var req gatewayapi.UpdateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	_, sessionUUID, ok := validSessionID(w, r, sessionID.String(), "sessionID")
	if !ok {
		return
	}
	if fields := validateUpdateAgentRequest(req); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	envFields, err := s.validateAgentEnvironmentName(r.Context(), req.EnvironmentName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(envFields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			envFields...,
		))
		return
	}
	if !updateAgentRequestHasChanges(req) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "must include at least one mutable field",
			},
		))
		return
	}

	row, err := s.queries.GatewayGetSession(r.Context(), sessionUUID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get session", err))
		return
	}

	var updated *clawarmorv1alpha1.Agent
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, getErr := s.resolver.client.ApiV1alpha1().Agents(s.cfg.Namespace).Get(
			r.Context(),
			row.AgentName,
			metav1.GetOptions{},
		)
		if getErr != nil {
			return getErr
		}
		applyUpdateAgentRequest(agt, req)
		updated, getErr = s.resolver.client.ApiV1alpha1().Agents(s.cfg.Namespace).Update(
			r.Context(),
			agt,
			metav1.UpdateOptions{},
		)
		return getErr
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update agent", err))
		return
	}

	status := gatewayapi.PROGRESSING
	if view := statusFromAgent(updated); view != nil {
		status = statusFromView(view)
	}
	writeJSON(w, http.StatusOK, gatewayapi.Agent{
		Name:         row.AgentName,
		SessionId:    row.SessionID,
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       status,
	})
}

// DeleteAgent handles POST /api/delete-agent.
func (s *Service) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.DeleteAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	_, sessionID, ok := validSessionID(w, r, req.SessionId)
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get session", err))
		return
	}
	err = s.resolver.client.ApiV1alpha1().Agents(s.cfg.Namespace).Delete(
		r.Context(),
		row.AgentName,
		metav1.DeleteOptions{},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		writeError(w, r, mapKubeHTTPError("delete agent", err))
		return
	}

	if err := s.deleteSessionSecrets(r.Context(), sessionID); err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}

	rows, err := s.queries.GatewayDeleteSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapGatewayStoreError("delete session", err))
		return
	}
	if rows == 0 {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// WatchAgents handles POST /api/watch-agents.
func (s *Service) WatchAgents(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.WatchAgentsRequest
	if r.Body != nil {
		if !decodeJSONBody(w, r, &req, true) {
			return
		}
	}

	sessionIDs := []string{}
	if req.SessionIds != nil {
		sessionIDs = make([]string, 0, len(*req.SessionIds))
		for _, id := range *req.SessionIds {
			sessionID, _, ok := validSessionID(w, r, id, "session_ids")
			if !ok {
				return
			}
			sessionIDs = append(sessionIDs, sessionID)
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"streaming is unavailable",
			nil,
		))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := make(map[uuid.UUID]gatewayapi.Agent)
	send := func(event string, items []gatewayapi.Agent) bool {
		if len(items) == 0 {
			return true
		}
		raw, err := json.Marshal(gatewayapi.WatchAgentsEvent{Agents: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if event != "" {
			if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	events, cancel := s.resolver.watchAgents()
	defer cancel()

	writeChanges := func() bool {
		items, _, err := s.listAgentItems(r.Context(), sessionIDs, 200, 0)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		changed := make([]gatewayapi.Agent, 0, len(items))
		for _, item := range items {
			agt := agentFromListAgent(item)
			if !sameAgent(prev[agt.SessionId], agt) {
				prev[agt.SessionId] = agt
				changed = append(changed, agt)
			}
		}
		return send("", changed)
	}

	if !writeChanges() {
		return
	}

	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == agentWatchEventDeleted {
				item, ok := deletedAgentEventItem(evt.Agent, prev, sessionIDs)
				if ok && !send("DELETE", []gatewayapi.Agent{item}) {
					return
				}
				continue
			}
			if !writeChanges() {
				return
			}
		case <-ticker.C:
			if !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) listAgentItems(ctx context.Context, sessionIDs []string, limit int, offset int) ([]gatewayapi.ListAgent, string, error) {
	var rows []gatewaydb.Session
	var err error
	if len(sessionIDs) > 0 {
		ids := make([]uuid.UUID, 0, len(sessionIDs))
		for _, sessionID := range sessionIDs {
			id, err := uuid.Parse(sessionID)
			if err != nil {
				return nil, "", err
			}
			ids = append(ids, id)
		}
		rows, err = s.queries.GatewayListSessionsByID(ctx, gatewaydb.GatewayListSessionsByIDParams{
			Column1: ids,
			Limit:   int32(limit + 1),
			Offset:  int32(offset),
		})
	} else {
		rows, err = s.queries.GatewayListSessions(ctx, gatewaydb.GatewayListSessionsParams{
			Limit:  int32(limit + 1),
			Offset: int32(offset),
		})
	}
	if err != nil {
		return nil, "", err
	}

	items := make([]gatewayapi.ListAgent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodeOffsetToken(offset + limit)
			continue
		}

		status := gatewayapi.UNSPECIFIED
		cfg := gatewayapi.AgentConfiguration{}
		resolved, resolveErr := s.resolver.resolveSession(ctx, row.SessionID.String())
		if resolveErr == nil {
			view := statusFromAgent(resolved.Agent)
			status = statusFromView(view)
			cfg = configurationFromAgent(resolved.Agent)
			if status == gatewayapi.IDLE {
				if active, ok, _ := s.activeRun(ctx, row.SessionID.String(), resolved.Target); ok && active.runID != "" {
					status = gatewayapi.WORKING
				}
			}
		} else if !errors.Is(resolveErr, errAgentNotFound) {
			return nil, "", resolveErr
		}

		items = append(items, gatewayapi.ListAgent{
			Name:          row.AgentName,
			SessionId:     row.SessionID,
			LastActivity:  row.UpdatedAt,
			CreatedAt:     row.CreatedAt,
			ModifiedAt:    row.UpdatedAt,
			Status:        status,
			Configuration: cfg,
		})
	}
	return items, next, nil
}

func agentFromListAgent(item gatewayapi.ListAgent) gatewayapi.Agent {
	return gatewayapi.Agent{
		Name:         item.Name,
		SessionId:    item.SessionId,
		LastActivity: item.LastActivity,
		CreatedAt:    item.CreatedAt,
		ModifiedAt:   item.ModifiedAt,
		Status:       item.Status,
	}
}

func sameAgent(a, b gatewayapi.Agent) bool {
	return a.Name == b.Name &&
		a.SessionId == b.SessionId &&
		a.LastActivity.Equal(b.LastActivity) &&
		a.CreatedAt.Equal(b.CreatedAt) &&
		a.ModifiedAt.Equal(b.ModifiedAt) &&
		a.Status == b.Status
}

func deletedAgentEventItem(agt *clawarmorv1alpha1.Agent, prev map[uuid.UUID]gatewayapi.Agent, sessionIDs []string) (gatewayapi.Agent, bool) {
	if agt == nil {
		return gatewayapi.Agent{}, false
	}

	sessionID, err := uuid.Parse(strings.TrimSpace(agt.Spec.Session.ID))
	if err != nil {
		return gatewayapi.Agent{}, false
	}
	if len(sessionIDs) > 0 && !slices.Contains(sessionIDs, sessionID.String()) {
		return gatewayapi.Agent{}, false
	}

	item, ok := prev[sessionID]
	delete(prev, sessionID)
	if !ok {
		return gatewayapi.Agent{}, false
	}

	item.Status = gatewayapi.DELETED
	return item, true
}

//nolint:gocyclo
func validateCreateAgentRequest(req gatewayapi.CreateAgentRequest) (string, gatewayapi.CompactionMode, []gatewayapi.FieldError) {
	fields := []gatewayapi.FieldError{}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: "name", Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be at most 32 characters",
		})
	}
	if name != "" {
		if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field: "name", Message: "must be a valid DNS label",
			})
		}
	}

	mode := gatewayapi.Summary
	if req.Compaction != nil && req.Compaction.Mode != nil {
		mode = *req.Compaction.Mode
	}
	if mode != gatewayapi.Summary && mode != gatewayapi.Truncate {
		fields = append(fields, gatewayapi.FieldError{
			Field: "compaction.mode", Message: "must be summary or truncate",
		})
	}

	var historyRatio, oversizedRatio *float64
	if req.Compaction != nil {
		if req.Compaction.ThresholdRatio != nil && (*req.Compaction.ThresholdRatio < 0.2 || *req.Compaction.ThresholdRatio > 0.95) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "compaction.thresholdRatio",
				Message: "must be between 0.2 and 0.95",
			})
		}
		if req.Compaction.HistoryToolResultRatio != nil {
			r := *req.Compaction.HistoryToolResultRatio
			if r < 0 || r > 1 {
				fields = append(fields, gatewayapi.FieldError{
					Field:   "compaction.historyToolResultRatio",
					Message: "must be between 0 and 1",
				})
			}
			historyRatio = req.Compaction.HistoryToolResultRatio
		}
		if req.Compaction.OversizedToolResultRatio != nil {
			r := *req.Compaction.OversizedToolResultRatio
			if r < 0.05 || r > 0.1 {
				fields = append(fields, gatewayapi.FieldError{
					Field:   "compaction.oversizedToolResultRatio",
					Message: "must be between 0.05 and 0.1",
				})
			}
			oversizedRatio = req.Compaction.OversizedToolResultRatio
		}
		if req.Compaction.KeepRecentRequests != nil && *req.Compaction.KeepRecentRequests < 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "compaction.keepRecentRequests",
				Message: "must be greater than or equal to zero",
			})
		}
	}
	if historyRatio != nil && oversizedRatio != nil && *historyRatio >= *oversizedRatio {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.historyToolResultRatio",
			Message: "must be less than compaction.oversizedToolResultRatio",
		})
	}
	if mode == gatewayapi.Summary && req.Model.Summary == nil {
		fields = append(fields, gatewayapi.FieldError{
			Field: "model.summary", Message: "required",
		})
	}
	if req.SystemPrompt != nil && len([]rune(*req.SystemPrompt)) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "systemPrompt",
			Message: "must be at most 4096 characters",
		})
	}
	if req.MaxHistoryRuns != nil && *req.MaxHistoryRuns < 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "maxHistoryRuns",
			Message: "must be greater than or equal to zero",
		})
	}
	if strings.TrimSpace(req.Model.Primary.Name) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field: "model.primary.name", Message: "required",
		})
	}
	if req.Model.Primary.ContextWindow <= 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "model.primary.contextWindow",
			Message: "must be greater than zero",
		})
	}
	if req.Model.Primary.Temperature != nil && (*req.Model.Primary.Temperature < 0 || *req.Model.Primary.Temperature > 1) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "model.primary.temperature",
			Message: "must be between 0 and 1",
		})
	}
	if req.Model.Summary != nil {
		if strings.TrimSpace(req.Model.Summary.Name) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field: "model.summary.name", Message: "required",
			})
		}
		if req.Model.Summary.ContextWindow <= 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "model.summary.contextWindow",
				Message: "must be greater than zero",
			})
		}
		if req.Model.Summary.Temperature != nil && (*req.Model.Summary.Temperature < 0 ||
			*req.Model.Summary.Temperature > 1) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "model.summary.temperature",
				Message: "must be between 0 and 1",
			})
		}
	}

	return name, mode, fields
}

func validateAgentEnvironmentNameField(fields []gatewayapi.FieldError, name string) []gatewayapi.FieldError {
	name = strings.TrimSpace(name)
	if name == "" {
		return append(fields, gatewayapi.FieldError{
			Field: "environmentName", Message: "required",
		})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "environmentName", Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "environmentName", Message: "must be a valid DNS label",
		})
	}
	return fields
}

func (s *Service) validateAgentEnvironmentName(ctx context.Context, name gatewayapi.EnvironmentName) ([]gatewayapi.FieldError, error) {
	fields := validateAgentEnvironmentNameField(nil, name)
	if len(fields) > 0 {
		return fields, nil
	}

	var env clawarmorv1alpha1.Environment
	key := types.NamespacedName{Namespace: s.cfg.Namespace, Name: name}
	if err := s.k8sClient.Get(ctx, key, &env); err != nil {
		if apierrors.IsNotFound(err) {
			return []gatewayapi.FieldError{{
				Field:   "environmentName",
				Message: "environment not found",
			}}, nil
		}
		return nil, fmt.Errorf("get environment %q: %w", name, err)
	}
	return nil, nil
}

func (s *Service) agentFromCreateRequest(req gatewayapi.CreateAgentRequest, sessionID uuid.UUID, name string, mode gatewayapi.CompactionMode) *clawarmorv1alpha1.Agent {
	specMode := clawarmorv1alpha1.CompactionModeSummary
	if mode == gatewayapi.Truncate {
		specMode = clawarmorv1alpha1.CompactionModeTruncate
	}

	env := []corev1.EnvVar{}
	if req.Env != nil {
		env = envVarsFromMap(*req.Env)
	}

	systemPrompt := ""
	if req.SystemPrompt != nil {
		systemPrompt = *req.SystemPrompt
	}

	compaction := clawarmorv1alpha1.ContextCompactionConfig{Mode: specMode}
	if req.Compaction != nil {
		if req.Compaction.ThresholdRatio != nil {
			compaction.ThresholdRatio = *req.Compaction.ThresholdRatio
		}
		if req.Compaction.HistoryToolResultRatio != nil {
			compaction.HistoryToolResultRatio = *req.Compaction.HistoryToolResultRatio
		}
		if req.Compaction.KeepRecentRequests != nil {
			compaction.KeepRecentRequests = int(*req.Compaction.KeepRecentRequests)
		}
		if req.Compaction.OversizedToolResultRatio != nil {
			compaction.OversizedToolResultRatio = *req.Compaction.OversizedToolResultRatio
		}
	}

	modelCfg := clawarmorv1alpha1.ModelConfig{
		Name:          req.Model.Primary.Name,
		ContextWindow: int(req.Model.Primary.ContextWindow),
		Stream:        true,
	}
	if req.Model.Primary.Temperature != nil {
		modelCfg.Temperature = *req.Model.Primary.Temperature
	}

	agt := &clawarmorv1alpha1.Agent{
		TypeMeta: metav1.TypeMeta{
			APIVersion: clawarmorv1alpha1.GroupVersion.String(),
			Kind:       "Agent",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.cfg.Namespace,
			Labels: map[string]string{
				labelManagedBy: "clawarmor-agent-gateway",
				labelSessionID: sessionID.String(),
			},
		},
		Spec: clawarmorv1alpha1.AgentSpec{
			Image:        s.cfg.AgentImage,
			Env:          env,
			Server:       clawarmorv1alpha1.ServerConfig{Address: s.cfg.AgentServerAddress},
			SystemPrompt: systemPrompt,
			Compaction:   compaction,
			Model:        modelCfg,
			Session: clawarmorv1alpha1.SessionConfig{
				ID:        sessionID.String(),
				Enabled:   true,
				Target:    s.cfg.AgentSessionTarget,
				Insecure:  true,
				TimeoutMs: 5000,
			},
			Telemetry: clawarmorv1alpha1.TelemetryConfig{
				Enabled:       true,
				TraceEndpoint: s.cfg.AgentTraceEndpoint,
			},
			EnvironmentRef: &corev1.LocalObjectReference{
				Name: req.EnvironmentName,
			},
		},
	}

	if req.MaxHistoryRuns != nil {
		agt.Spec.MaxHistoryRuns = int(*req.MaxHistoryRuns)
	}

	if req.Model.Summary != nil {
		summaryModel := clawarmorv1alpha1.SummaryModelConfig{
			Name:          req.Model.Summary.Name,
			ContextWindow: int(req.Model.Summary.ContextWindow),
		}
		if req.Model.Summary.Temperature != nil {
			summaryModel.Temperature = *req.Model.Summary.Temperature
		}
		agt.Spec.SummaryModel = summaryModel
	}

	if req.Tools != nil {
		if req.Tools.HostExec != nil && req.Tools.HostExec.Enabled != nil {
			agt.Spec.Tools.HostExec.Enabled = req.Tools.HostExec.Enabled
		}
		if req.Tools.WebFetch != nil && req.Tools.WebFetch.Enabled != nil {
			agt.Spec.Tools.WebFetch.Enabled = req.Tools.WebFetch.Enabled
		}
		if req.Tools.File != nil && req.Tools.File.Enabled != nil {
			agt.Spec.Tools.File.Enabled = req.Tools.File.Enabled
		}
		if req.Tools.Arxiv != nil && req.Tools.Arxiv.Enabled != nil {
			agt.Spec.Tools.Arxiv.Enabled = req.Tools.Arxiv.Enabled
		}
	}

	return agt
}

func updateAgentRequestHasChanges(req gatewayapi.UpdateAgentRequest) bool {
	if req.Env != nil || req.SystemPrompt != nil || req.MaxHistoryRuns != nil {
		return true
	}
	if strings.TrimSpace(req.EnvironmentName) != "" {
		return true
	}
	if req.Compaction != nil {
		cfg := req.Compaction
		if cfg.Mode != nil || cfg.ThresholdRatio != nil ||
			cfg.HistoryToolResultRatio != nil {
			return true
		}
		if cfg.KeepRecentRequests != nil ||
			cfg.OversizedToolResultRatio != nil {
			return true
		}
	}
	if req.Model != nil {
		primary := req.Model.Primary
		summary := req.Model.Summary
		if primary != nil && (primary.Name != nil || primary.ContextWindow != nil || primary.Temperature != nil) {
			return true
		}
		if summary != nil && (summary.Name != nil || summary.ContextWindow != nil || summary.Temperature != nil) {
			return true
		}
	}
	if req.Tools == nil {
		return false
	}
	return updateToolHasChange(req.Tools.HostExec) ||
		updateToolHasChange(req.Tools.WebFetch) ||
		updateToolHasChange(req.Tools.File) ||
		updateToolHasChange(req.Tools.Arxiv)
}

func updateToolHasChange(tool *gatewayapi.UpdateAgentTool) bool {
	return tool != nil && tool.Enabled != nil
}

func validateUpdateAgentRequest(req gatewayapi.UpdateAgentRequest) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 12)
	if req.SystemPrompt != nil && len([]rune(*req.SystemPrompt)) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "systemPrompt",
			Message: "must be at most 4096 characters",
		})
	}
	if req.MaxHistoryRuns != nil && *req.MaxHistoryRuns < 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "maxHistoryRuns",
			Message: "must be greater than or equal to zero",
		})
	}
	if req.Compaction != nil {
		fields = validateUpdateAgentCompaction(fields, req.Compaction)
	}
	if req.Model != nil {
		fields = validateUpdateAgentModelConfig(fields, "model.primary", req.Model.Primary)
		fields = validateUpdateAgentModelConfig(fields, "model.summary", req.Model.Summary)
	}
	return fields
}

func validateUpdateAgentCompaction(fields []gatewayapi.FieldError, req *gatewayapi.UpdateAgentCompaction) []gatewayapi.FieldError {
	if req.Mode != nil && *req.Mode != gatewayapi.Summary && *req.Mode != gatewayapi.Truncate {
		fields = append(fields, gatewayapi.FieldError{
			Field: "compaction.mode", Message: "must be summary or truncate",
		})
	}
	if req.ThresholdRatio != nil && (*req.ThresholdRatio < 0.2 || *req.ThresholdRatio > 0.95) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.thresholdRatio",
			Message: "must be between 0.2 and 0.95",
		})
	}
	if req.HistoryToolResultRatio != nil && (*req.HistoryToolResultRatio < 0 || *req.HistoryToolResultRatio > 1) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.historyToolResultRatio",
			Message: "must be between 0 and 1",
		})
	}
	if req.OversizedToolResultRatio != nil && (*req.OversizedToolResultRatio < 0.05 || *req.OversizedToolResultRatio > 0.1) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.oversizedToolResultRatio",
			Message: "must be between 0.05 and 0.1",
		})
	}
	if req.KeepRecentRequests != nil && *req.KeepRecentRequests < 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.keepRecentRequests",
			Message: "must be greater than or equal to zero",
		})
	}
	if req.HistoryToolResultRatio == nil || req.OversizedToolResultRatio == nil {
		return fields
	}
	if *req.HistoryToolResultRatio >= *req.OversizedToolResultRatio {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.historyToolResultRatio",
			Message: "must be less than compaction.oversizedToolResultRatio",
		})
	}
	return fields
}

func validateUpdateAgentModelConfig(fields []gatewayapi.FieldError, field string, req *gatewayapi.UpdateAgentModelConfig) []gatewayapi.FieldError {
	if req == nil {
		return fields
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field: field + ".name", Message: "required",
		})
	}
	if req.ContextWindow != nil && *req.ContextWindow <= 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   field + ".contextWindow",
			Message: "must be greater than zero",
		})
	}
	if req.Temperature != nil && (*req.Temperature < 0 || *req.Temperature > 1) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   field + ".temperature",
			Message: "must be between 0 and 1",
		})
	}
	return fields
}

func applyUpdateAgentRequest(agt *clawarmorv1alpha1.Agent, req gatewayapi.UpdateAgentRequest) {
	if req.Env != nil {
		agt.Spec.Env = envVarsFromMap(*req.Env)
	}
	if req.SystemPrompt != nil {
		agt.Spec.SystemPrompt = *req.SystemPrompt
	}
	if req.MaxHistoryRuns != nil {
		agt.Spec.MaxHistoryRuns = int(*req.MaxHistoryRuns)
	}
	if strings.TrimSpace(req.EnvironmentName) != "" {
		agt.Spec.EnvironmentRef = &corev1.LocalObjectReference{Name: req.EnvironmentName}
	}
	if req.Compaction != nil {
		applyUpdateAgentCompaction(&agt.Spec.Compaction, req.Compaction)
	}
	if req.Model != nil {
		applyUpdateAgentModel(&agt.Spec.Model, &agt.Spec.SummaryModel, req.Model)
	}
	if req.Tools != nil {
		applyUpdateAgentTools(&agt.Spec.Tools, req.Tools)
	}
}

func envVarsFromMap(items map[string]string) []corev1.EnvVar {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	env := make([]corev1.EnvVar, 0, len(keys))
	for _, key := range keys {
		env = append(env, corev1.EnvVar{Name: key, Value: items[key]})
	}
	return env
}

func applyUpdateAgentCompaction(cfg *clawarmorv1alpha1.ContextCompactionConfig, req *gatewayapi.UpdateAgentCompaction) {
	if req.Mode != nil {
		cfg.Mode = string(*req.Mode)
	}
	if req.ThresholdRatio != nil {
		cfg.ThresholdRatio = *req.ThresholdRatio
	}
	if req.HistoryToolResultRatio != nil {
		cfg.HistoryToolResultRatio = *req.HistoryToolResultRatio
	}
	if req.KeepRecentRequests != nil {
		cfg.KeepRecentRequests = int(*req.KeepRecentRequests)
	}
	if req.OversizedToolResultRatio != nil {
		cfg.OversizedToolResultRatio = *req.OversizedToolResultRatio
	}
}

func applyUpdateAgentModel(model *clawarmorv1alpha1.ModelConfig, summary *clawarmorv1alpha1.SummaryModelConfig, req *gatewayapi.UpdateAgentModel) {
	if req.Primary != nil {
		if req.Primary.Name != nil {
			model.Name = *req.Primary.Name
		}
		if req.Primary.ContextWindow != nil {
			model.ContextWindow = int(*req.Primary.ContextWindow)
		}
		if req.Primary.Temperature != nil {
			model.Temperature = *req.Primary.Temperature
		}
	}
	if req.Summary != nil {
		if req.Summary.Name != nil {
			summary.Name = *req.Summary.Name
		}
		if req.Summary.ContextWindow != nil {
			summary.ContextWindow = int(*req.Summary.ContextWindow)
		}
		if req.Summary.Temperature != nil {
			summary.Temperature = *req.Summary.Temperature
		}
	}
}

func applyUpdateAgentTools(cfg *clawarmorv1alpha1.ToolsConfig, req *gatewayapi.UpdateAgentTools) {
	if req.HostExec != nil && req.HostExec.Enabled != nil {
		cfg.HostExec.Enabled = req.HostExec.Enabled
	}
	if req.WebFetch != nil && req.WebFetch.Enabled != nil {
		cfg.WebFetch.Enabled = req.WebFetch.Enabled
	}
	if req.File != nil && req.File.Enabled != nil {
		cfg.File.Enabled = req.File.Enabled
	}
	if req.Arxiv != nil && req.Arxiv.Enabled != nil {
		cfg.Arxiv.Enabled = req.Arxiv.Enabled
	}
}

func configurationFromAgent(agt *clawarmorv1alpha1.Agent) gatewayapi.AgentConfiguration {
	cfg := gatewayapi.AgentConfiguration{
		Model: gatewayapi.CreateAgentModel{
			Primary: gatewayapi.CreateAgentModelConfig{
				Name:          agt.Spec.Model.Name,
				ContextWindow: int32(agt.Spec.Model.ContextWindow),
			},
		},
	}

	env := make(map[string]string, len(agt.Spec.Env))
	for _, item := range agt.Spec.Env {
		env[item.Name] = item.Value
	}
	if len(env) > 0 {
		cfg.Env = &env
	}
	if agt.Spec.SystemPrompt != "" {
		cfg.SystemPrompt = &agt.Spec.SystemPrompt
	}
	if agt.Spec.EnvironmentRef != nil {
		cfg.EnvironmentName = &agt.Spec.EnvironmentRef.Name
	}

	maxHistoryRuns := int32(agt.Spec.MaxHistoryRuns)
	cfg.MaxHistoryRuns = &maxHistoryRuns

	mode := gatewayapi.CompactionMode(agt.Spec.Compaction.Mode)
	keepRecentRequests := int32(agt.Spec.Compaction.KeepRecentRequests)
	cfg.Compaction = &gatewayapi.CreateAgentCompaction{
		Mode:                     &mode,
		ThresholdRatio:           &agt.Spec.Compaction.ThresholdRatio,
		HistoryToolResultRatio:   &agt.Spec.Compaction.HistoryToolResultRatio,
		KeepRecentRequests:       &keepRecentRequests,
		OversizedToolResultRatio: &agt.Spec.Compaction.OversizedToolResultRatio,
	}

	primaryTemp := agt.Spec.Model.Temperature
	cfg.Model.Primary.Temperature = &primaryTemp
	if agt.Spec.SummaryModel.Name != "" {
		summaryTemp := agt.Spec.SummaryModel.Temperature
		cfg.Model.Summary = &gatewayapi.CreateAgentModelConfig{
			Name:          agt.Spec.SummaryModel.Name,
			ContextWindow: int32(agt.Spec.SummaryModel.ContextWindow),
			Temperature:   &summaryTemp,
		}
	}

	cfg.Tools = &gatewayapi.CreateAgentTools{
		HostExec: &gatewayapi.CreateAgentEnabledByDefaultTool{
			Enabled: agt.Spec.Tools.HostExec.Enabled,
		},
		WebFetch: &gatewayapi.CreateAgentEnabledByDefaultTool{
			Enabled: agt.Spec.Tools.WebFetch.Enabled,
		},
		File: &gatewayapi.CreateAgentDisabledByDefaultTool{
			Enabled: agt.Spec.Tools.File.Enabled,
		},
		Arxiv: &gatewayapi.CreateAgentDisabledByDefaultTool{
			Enabled: agt.Spec.Tools.Arxiv.Enabled,
		},
	}
	return cfg
}

func statusFromView(view *agentStatusView) gatewayapi.AgentStatus {
	switch view.Phase {
	case agentPhaseReady:
		return gatewayapi.IDLE
	case agentPhaseProgressing:
		return gatewayapi.PROGRESSING
	case agentPhaseDegraded:
		return gatewayapi.DEGRADED
	case agentPhaseNotFound:
		return gatewayapi.UNSPECIFIED
	default:
		return gatewayapi.UNSPECIFIED
	}
}
