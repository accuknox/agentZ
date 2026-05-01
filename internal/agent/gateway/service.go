package gateway

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	gatewaydb "github.com/accuknox/clawarmor/internal/agent/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

var (
	errAgentNotFound = errors.New("agent not found")
	errRunNotFound   = errors.New("run not found")
	errBadRequest    = errors.New("bad request")
)

const (
	labelManagedBy = "app.kubernetes.io/managed-by"
	labelSessionID = "clawarmor.accuknox.com/session-id"
)

const (
	defaultCreateThresholdRatio           = 0.9
	defaultCreateHistoryToolResultRatio   = 0.008
	defaultCreateKeepRecentRequests       = 2
	defaultCreateOversizedToolResultRatio = 0.065
	defaultCreateMaxHistoryRuns           = 50
	defaultCreateTemperature              = 0.2
)

// Config describes how to start the gateway.
type Config struct {
	Addr                    string
	Namespace               string
	ValkeyAddr              string
	PostgresDSN             string
	GracefulShutdownTimeout time.Duration
	TargetOverride          string
	AgentImage              string
	AgentServerAddress      string
	AgentSessionTarget      string
	AgentTraceEndpoint      string
}

// Service implements the agent gateway HTTP API.
type Service struct {
	ctx      context.Context
	resolver *resolver
	store    *valkeyStore
	queries  gatewaydb.Querier
	cfg      Config

	mu             sync.Mutex
	consumers      map[string]struct{}
	sessionWaiters map[string]map[chan struct{}]struct{}
}

type activeRun struct {
	sessionID string
	runID     string
	requestID string
}

type apiError struct {
	status  int
	code    string
	message string
	cause   error
	fields  []gatewayapi.FieldError
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	apiCode string
	cause   error
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) setAPIError(code string, cause error) {
	r.apiCode = code
	r.cause = cause
}

// Serve starts the agent gateway HTTP server and blocks until shutdown.
func Serve(ctx context.Context, cfg Config) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.Addr == "" {
		cfg.Addr = DefaultListenAddr
	}
	if cfg.Namespace == "" {
		cfg.Namespace = DefaultNamespace
	}
	if cfg.ValkeyAddr == "" {
		cfg.ValkeyAddr = DefaultValkeyAddr
	}
	if strings.TrimSpace(cfg.PostgresDSN) == "" {
		return fmt.Errorf("postgres dsn is required")
	}
	if strings.TrimSpace(cfg.AgentSessionTarget) == "" {
		return fmt.Errorf("agent session target is required")
	}
	if strings.TrimSpace(cfg.AgentTraceEndpoint) == "" {
		return fmt.Errorf("agent trace endpoint is required")
	}
	if strings.TrimSpace(cfg.AgentServerAddress) == "" {
		cfg.AgentServerAddress = DefaultAgentServerAddress
	}

	resolver, err := newResolver(ctx, cfg.Namespace, cfg.TargetOverride)
	if err != nil {
		return err
	}
	defer resolver.Close()

	store, err := newValkeyStore(cfg.ValkeyAddr, defaultRunTTL)
	if err != nil {
		return err
	}
	defer store.Close()

	db, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	svc := &Service{
		ctx:            ctx,
		resolver:       resolver,
		store:          store,
		queries:        gatewaydb.New(db),
		cfg:            cfg,
		consumers:      make(map[string]struct{}),
		sessionWaiters: make(map[string]map[chan struct{}]struct{}),
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           svc.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting agent gateway HTTP server",
			slog.String("addr", cfg.Addr),
			slog.String("namespace", cfg.Namespace),
			slog.String("valkey_addr", cfg.ValkeyAddr),
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		timeout := cfg.GracefulShutdownTimeout
		if timeout == 0 {
			timeout = 15 * time.Second
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
		}
		err = <-errCh
	case err = <-errCh:
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve http: %w", err)
	}
	return nil
}

func (s *Service) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(requestLog)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	return gatewayapi.HandlerWithOptions(s, gatewayapi.ChiServerOptions{
		BaseRouter:       r,
		ErrorHandlerFunc: s.handleRouteError,
	})
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		attrs := []slog.Attr{
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", rec.status),
			slog.Duration("duration", time.Since(start)),
			slog.String("request_id", requestID(r)),
		}
		if rec.apiCode != "" {
			attrs = append(attrs, slog.String("code", rec.apiCode))
		}
		if rec.cause != nil && (rec.status >= http.StatusInternalServerError || rec.status == http.StatusOK) {
			attrs = append(attrs, slog.Any("err", rec.cause))
			slog.LogAttrs(r.Context(), slog.LevelError, "gateway request completed", attrs...)
			return
		}
		slog.LogAttrs(r.Context(), slog.LevelInfo, "gateway request completed", attrs...)
	})
}

// GetChatHistory handles GET /api/chat-history.
func (s *Service) GetChatHistory(w http.ResponseWriter, r *http.Request, params gatewayapi.GetChatHistoryParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
	if !ok {
		return
	}
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
	beforeSeq, ok := decodeSequencePageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	var rows []gatewaydb.GatewayListRecentEventsRow
	if beforeSeq > 0 {
		pageRows, err := s.queries.GatewayListEventPage(r.Context(), gatewaydb.GatewayListEventPageParams{
			SessionID: sessionUUID,
			Seq:       beforeSeq,
			Limit:     int32(limit + 1),
		})
		if err != nil {
			writeError(w, r, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"request failed",
				err,
			))
			return
		}
		rows = make([]gatewaydb.GatewayListRecentEventsRow, 0, len(pageRows))
		for _, row := range pageRows {
			rows = append(rows, gatewaydb.GatewayListRecentEventsRow(row))
		}
	} else {
		rows, err = s.queries.GatewayListRecentEvents(r.Context(), gatewaydb.GatewayListRecentEventsParams{
			SessionID: sessionUUID,
			Limit:     int32(limit + 1),
		})
		if err != nil {
			writeError(w, r, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"request failed",
				err,
			))
			return
		}
	}
	items := make([]gatewayapi.StoredSessionEvent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodePageToken(row.Seq)
			continue
		}
		item := gatewayapi.StoredSessionEvent{
			Seq:     row.Seq,
			EventId: row.EventID,
			EventTs: row.EventTs,
		}
		if err := json.Unmarshal(row.EventPayload, &item.Payload); err != nil {
			writeError(w, r, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"request failed",
				err,
			))
			return
		}
		items = append(items, item)
	}
	slices.SortFunc(items, func(a, b gatewayapi.StoredSessionEvent) int {
		return cmp.Compare(a.Seq, b.Seq)
	})
	writeJSON(w, http.StatusOK, gatewayapi.ChatHistoryResponse{
		SessionId:     sessionUUID,
		Events:        items,
		NextPageToken: next,
	})
}

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
	var sessionIDs []string
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
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
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

	var fields []gatewayapi.FieldError
	name := strings.TrimSpace(req.Name)
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "required",
		})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "must be at most 32 characters",
		})
	}
	if name != "" {
		if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "name",
				Message: "must be a valid DNS label",
			})
		}
	}

	mode := gatewayapi.Summary
	if req.Compaction != nil && req.Compaction.Mode != nil {
		mode = *req.Compaction.Mode
	}
	if mode != gatewayapi.Summary && mode != gatewayapi.Truncate {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.mode",
			Message: "must be summary or truncate",
		})
	}
	historyRatio := defaultCreateHistoryToolResultRatio
	oversizedRatio := defaultCreateOversizedToolResultRatio
	if req.Compaction != nil {
		if req.Compaction.ThresholdRatio != nil && (*req.Compaction.ThresholdRatio < 0.2 || *req.Compaction.ThresholdRatio > 0.95) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "compaction.thresholdRatio",
				Message: "must be between 0.2 and 0.95",
			})
		}
		if req.Compaction.HistoryToolResultRatio != nil {
			historyRatio = *req.Compaction.HistoryToolResultRatio
			if historyRatio < 0 || historyRatio > 1 {
				fields = append(fields, gatewayapi.FieldError{
					Field:   "compaction.historyToolResultRatio",
					Message: "must be between 0 and 1",
				})
			}
		}
		if req.Compaction.OversizedToolResultRatio != nil {
			oversizedRatio = *req.Compaction.OversizedToolResultRatio
			if oversizedRatio < 0.05 || oversizedRatio > 0.1 {
				fields = append(fields, gatewayapi.FieldError{
					Field:   "compaction.oversizedToolResultRatio",
					Message: "must be between 0.05 and 0.1",
				})
			}
		}
		if req.Compaction.KeepRecentRequests != nil && *req.Compaction.KeepRecentRequests < 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "compaction.keepRecentRequests",
				Message: "must be greater than or equal to zero",
			})
		}
	}
	if historyRatio >= oversizedRatio {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "compaction.historyToolResultRatio",
			Message: "must be less than compaction.oversizedToolResultRatio",
		})
	}
	if mode == gatewayapi.Summary && req.Model.Summary == nil {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "model.summary",
			Message: "required",
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
			Field:   "model.primary.name",
			Message: "required",
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
				Field:   "model.summary.name",
				Message: "required",
			})
		}
		if req.Model.Summary.ContextWindow <= 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "model.summary.contextWindow",
				Message: "must be greater than zero",
			})
		}
		if req.Model.Summary.Temperature != nil && (*req.Model.Summary.Temperature < 0 || *req.Model.Summary.Temperature > 1) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "model.summary.temperature",
				Message: "must be between 0 and 1",
			})
		}
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

// SendMessage handles POST /api/send-message.
func (s *Service) SendMessage(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.SendMessageRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	sessionID, _, ok := validSessionID(w, r, req.SessionId)
	if !ok {
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "prompt", Message: "required"},
		))
		return
	}

	resolved, err := s.resolver.resolveSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapResolverHTTPError(err))
		return
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}
	defer backend.Close()

	callCtx, cancel := backendCallContext(r.Context())
	defer cancel()
	resp, err := backend.client.SendUserMessage(callCtx, &agentpb.SendUserMessageRequest{
		Prompt: prompt,
	})
	if err != nil {
		writeError(w, r, mapGRPCError(err))
		return
	}

	meta := runMeta{
		SessionID: resp.GetSessionId(),
		RunID:     resp.GetRunId(),
		RequestID: resp.GetRequestId(),
	}
	if err := s.store.initRun(r.Context(), meta); err != nil {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}
	if err := s.startConsumer(resp.GetRunId(), resolved.Target); err != nil {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}
	s.notifySession(resp.GetSessionId())

	sessionUUID, runUUID, requestUUID, err := parseStreamIDs(resp.GetSessionId(), resp.GetRunId(), resp.GetRequestId())
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.SendMessageResponse{
		SessionId: sessionUUID,
		RunId:     runUUID,
		RequestId: requestUUID,
	})
}

// SubscribeSession handles POST /api/subscribe-session.
func (s *Service) SubscribeSession(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.SessionActionRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	sessionID, _, ok := validSessionID(w, r, req.SessionId)
	if !ok {
		return
	}
	resolved, err := s.resolver.resolveSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapResolverHTTPError(err))
		return
	}
	s.streamSession(w, r, sessionID, resolved.Target)
}

// InterruptSession handles POST /api/interrupt-session.
func (s *Service) InterruptSession(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.SessionActionRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	sessionID, _, ok := validSessionID(w, r, req.SessionId)
	if !ok {
		return
	}
	resolved, err := s.resolver.resolveSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapResolverHTTPError(err))
		return
	}
	active, ok, err := s.activeRun(r.Context(), sessionID, resolved.Target)
	if err != nil {
		writeError(w, r, mapGRPCError(err))
		return
	}
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"active run not found",
			errRunNotFound,
		))
		return
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}
	defer backend.Close()
	callCtx, cancel := backendCallContext(r.Context())
	defer cancel()
	resp, err := backend.client.Interrupt(callCtx, &agentpb.InterruptRequest{
		RunId: active.runID,
	})
	if err != nil {
		writeError(w, r, mapGRPCError(err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.InterruptSessionResponse{
		Interrupted: resp.GetInterrupted(),
	})
}

// CompactSession handles POST /api/compact-session.
func (s *Service) CompactSession(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.SessionActionRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	sessionID, _, ok := validSessionID(w, r, req.SessionId)
	if !ok {
		return
	}
	resolved, err := s.resolver.resolveSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapResolverHTTPError(err))
		return
	}
	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}
	defer backend.Close()
	callCtx, cancel := backendCallContext(r.Context())
	defer cancel()
	resp, err := backend.client.Compact(callCtx, &agentpb.CompactRequest{})
	if err != nil {
		writeError(w, r, mapGRPCError(err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.CompactSessionResponse{
		Message: resp.GetMessage(),
	})
}

// WatchAgents handles POST /api/watch-agents.
func (s *Service) WatchAgents(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.WatchAgentsRequest
	if r.Body != nil {
		if !decodeJSONBody(w, r, &req, true) {
			return
		}
	}
	var sessionIDs []string
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
			if !sameAgent(prev[item.SessionId], item) {
				prev[item.SessionId] = item
				changed = append(changed, item)
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

func (s *Service) streamSession(w http.ResponseWriter, r *http.Request, sessionID, target string) {
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

	send := func(evt *gatewayapi.SessionStreamEvent) bool {
		raw, err := json.Marshal(evt)
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	var runID string
	var afterSeq int64
	for r.Context().Err() == nil && s.ctx.Err() == nil {
		active, ok, err := s.activeRun(r.Context(), sessionID, target)
		if err != nil {
			recordRequestError(w, "unavailable", err)
			return
		}
		if !ok {
			if runID != "" {
				if err := s.finishRunIfRunning(r.Context(), runID); err != nil {
					recordRequestError(w, "internal_error", err)
					return
				}
				done, ok := s.writeRunEvents(r.Context(), runID, &afterSeq, send)
				if !ok || done {
					runID = ""
					afterSeq = 0
				}
			}
			if !s.waitForSession(r.Context(), sessionID, statusPollInterval) {
				return
			}
			continue
		}

		if active.runID != runID {
			runID = active.runID
			afterSeq = 0
		}
		err = s.store.initRun(r.Context(), runMeta{
			SessionID: active.sessionID,
			RunID:     active.runID,
			RequestID: active.requestID,
		})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return
		}
		if err := s.startConsumer(active.runID, target); err != nil {
			recordRequestError(w, "internal_error", err)
			return
		}

		done, ok := s.writeRunEvents(r.Context(), active.runID, &afterSeq, send)
		if !ok {
			return
		}
		if done {
			runID = ""
			afterSeq = 0
			if !s.waitForSession(r.Context(), sessionID, statusPollInterval) {
				return
			}
			continue
		}
		if !s.store.waitForAppend(r.Context(), active.runID, statusPollInterval) {
			return
		}
	}
}

func (s *Service) writeRunEvents(ctx context.Context, runID string, afterSeq *int64, send func(*gatewayapi.SessionStreamEvent) bool) (bool, bool) {
	items, err := s.store.replay(ctx, runID, *afterSeq)
	if err != nil {
		if errors.Is(err, errRunNotFound) {
			return false, true
		}
		slog.ErrorContext(ctx, "replay stream failed", slog.String("run_id", runID), slog.Any("err", err))
		return false, false
	}
	for _, evt := range items {
		if !send(evt) {
			return false, false
		}
		*afterSeq = sessionEventSequence(evt)
		if isTerminalState(eventState(evt)) {
			return true, true
		}
	}
	run, err := s.store.getRun(ctx, runID)
	if err == nil && isTerminalState(run.State) {
		return true, true
	}
	return false, true
}

func (s *Service) startConsumer(runID string, target string) error {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return fmt.Errorf("run id is required")
	}

	s.mu.Lock()
	if _, ok := s.consumers[runID]; ok {
		s.mu.Unlock()
		return nil
	}
	s.consumers[runID] = struct{}{}
	s.mu.Unlock()

	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.consumers, runID)
			s.mu.Unlock()
		}()
		s.consumeBackendRun(ctx, target, runID)
	}()
	return nil
}

func (s *Service) consumeBackendRun(ctx context.Context, target, runID string) {
	backend, err := newBackendClient(target)
	if err != nil {
		slog.ErrorContext(ctx, "dial backend stream failed", slog.String("run_id", runID), slog.Any("err", err))
		return
	}
	defer backend.Close()

	stream, err := backend.client.StreamRun(ctx, &agentpb.StreamRunRequest{RunId: runID})
	if err != nil {
		slog.ErrorContext(ctx, "open backend stream failed", slog.String("run_id", runID), slog.Any("err", err))
		return
	}

	for {
		evt, recvErr := stream.Recv()
		if recvErr != nil {
			if err := s.finishRunIfRunning(ctx, runID); err != nil {
				slog.ErrorContext(ctx, "finish stream event failed", slog.String("run_id", runID), slog.Any("err", err))
			}
			return
		}
		out, err := convertBackendEvent(evt)
		if err != nil {
			slog.ErrorContext(ctx, "convert stream event failed", slog.String("run_id", runID), slog.Any("err", err))
			return
		}
		if err := s.store.appendEvent(ctx, runID, out); err != nil {
			slog.ErrorContext(ctx, "persist stream event failed", slog.String("run_id", runID), slog.Any("err", err))
			return
		}
	}
}

func (s *Service) finishRunIfRunning(ctx context.Context, runID string) error {
	run, err := s.store.getRun(ctx, runID)
	if err != nil {
		return err
	}
	if isTerminalState(run.State) {
		return nil
	}
	sessionID, runUUID, requestID, err := parseStreamIDs(run.SessionID, run.RunID, run.RequestID)
	if err != nil {
		return err
	}
	var evt gatewayapi.SessionStreamEvent
	err = evt.FromSessionRunCompletedEvent(gatewayapi.SessionRunCompletedEvent{
		SessionId: sessionID,
		RunId:     runUUID,
		RequestId: requestID,
		Type:      gatewayapi.EVENTTYPERUNCOMPLETED,
	})
	if err != nil {
		return err
	}
	return s.store.appendEvent(ctx, runID, &evt)
}

func (s *Service) activeRun(ctx context.Context, sessionID string, target string) (activeRun, bool, error) {
	backend, err := newBackendClient(target)
	if err != nil {
		return activeRun{}, false, status.Errorf(codes.Unavailable, "dial backend: %v", err)
	}
	defer backend.Close()

	callCtx, cancel := backendCallContext(ctx)
	defer cancel()
	resp, err := backend.client.GetActiveRunStatus(callCtx, &emptypb.Empty{})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return activeRun{}, false, nil
		}
		return activeRun{}, false, err
	}
	item := resp.GetStatus()
	if item == nil || item.GetRunId() == "" || item.GetSessionId() != sessionID {
		return activeRun{}, false, nil
	}
	return activeRun{
		sessionID: item.GetSessionId(),
		runID:     item.GetRunId(),
		requestID: item.GetRequestId(),
	}, true, nil
}

func (s *Service) waitForSession(ctx context.Context, sessionID string, timeout time.Duration) bool {
	ch := make(chan struct{}, 1)
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	s.mu.Lock()
	waiters := s.sessionWaiters[sessionID]
	if waiters == nil {
		waiters = make(map[chan struct{}]struct{})
		s.sessionWaiters[sessionID] = waiters
	}
	waiters[ch] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.sessionWaiters[sessionID], ch)
		if len(s.sessionWaiters[sessionID]) == 0 {
			delete(s.sessionWaiters, sessionID)
		}
		s.mu.Unlock()
	}()

	select {
	case <-ctx.Done():
		return false
	case <-s.ctx.Done():
		return false
	case <-timer.C:
		return true
	case <-ch:
		return true
	}
}

func (s *Service) notifySession(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.sessionWaiters[sessionID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (s *Service) listAgentItems(ctx context.Context, sessionIDs []string, limit int, offset int) ([]gatewayapi.Agent, string, error) {
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

	items := make([]gatewayapi.Agent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodeOffsetToken(offset + limit)
			continue
		}
		status := gatewayapi.UNSPECIFIED
		resolved, resolveErr := s.resolver.resolveSession(ctx, row.SessionID.String())
		if resolveErr == nil {
			view := statusFromAgent(resolved.Agent)
			status = statusFromView(view)
			if status == gatewayapi.IDLE {
				if active, ok, _ := s.activeRun(ctx, row.SessionID.String(), resolved.Target); ok && active.runID != "" {
					status = gatewayapi.WORKING
				}
			}
		} else if !errors.Is(resolveErr, errAgentNotFound) {
			return nil, "", resolveErr
		}
		items = append(items, gatewayapi.Agent{
			Name:         row.AgentName,
			SessionId:    row.SessionID,
			LastActivity: row.UpdatedAt,
			CreatedAt:    row.CreatedAt,
			ModifiedAt:   row.UpdatedAt,
			Status:       status,
		})
	}
	return items, next, nil
}

func convertBackendEvent(evt *agentpb.AgentEvent) (*gatewayapi.SessionStreamEvent, error) {
	if evt == nil {
		return nil, fmt.Errorf("event is nil")
	}
	sessionID, runID, requestID, err := parseStreamIDs(evt.GetSessionId(), evt.GetRunId(), evt.GetRequestId())
	if err != nil {
		return nil, err
	}
	var out gatewayapi.SessionStreamEvent
	switch evt.GetType() {
	case agentpb.EventType_EVENT_TYPE_RUN_STARTED:
		err = out.FromSessionRunStartedEvent(gatewayapi.SessionRunStartedEvent{
			SessionId: sessionID,
			RunId:     runID,
			RequestId: requestID,
			Type:      gatewayapi.EVENTTYPERUNSTARTED,
			Content:   evt.GetContent(),
		})
	case agentpb.EventType_EVENT_TYPE_ASSISTANT_DELTA:
		content := evt.GetContent()
		reasoning := evt.GetReasoningContent()
		err = out.FromSessionAssistantDeltaEvent(gatewayapi.SessionAssistantDeltaEvent{
			SessionId:        sessionID,
			RunId:            runID,
			RequestId:        requestID,
			Type:             gatewayapi.SessionAssistantDeltaEventTypeEVENTTYPEASSISTANTDELTA,
			Content:          optionalString(content),
			ReasoningContent: optionalString(reasoning),
		})
	case agentpb.EventType_EVENT_TYPE_ASSISTANT_MESSAGE:
		reasoning := evt.GetReasoningContent()
		err = out.FromSessionAssistantMessageEvent(gatewayapi.SessionAssistantMessageEvent{
			SessionId:        sessionID,
			RunId:            runID,
			RequestId:        requestID,
			Type:             gatewayapi.EVENTTYPEASSISTANTMESSAGE,
			Content:          evt.GetContent(),
			ReasoningContent: optionalString(reasoning),
		})
	case agentpb.EventType_EVENT_TYPE_TOOL_CALL:
		err = out.FromSessionToolCallEvent(gatewayapi.SessionToolCallEvent{
			SessionId:   sessionID,
			RunId:       runID,
			RequestId:   requestID,
			Type:        gatewayapi.EVENTTYPETOOLCALL,
			ToolName:    evt.GetToolName(),
			ToolPayload: evt.GetToolPayload(),
		})
	case agentpb.EventType_EVENT_TYPE_TOOL_RESULT:
		err = out.FromSessionToolResultEvent(gatewayapi.SessionToolResultEvent{
			SessionId:   sessionID,
			RunId:       runID,
			RequestId:   requestID,
			Type:        gatewayapi.EVENTTYPETOOLRESULT,
			ToolName:    evt.GetToolName(),
			ToolPayload: evt.GetToolPayload(),
		})
	case agentpb.EventType_EVENT_TYPE_RUN_COMPLETED:
		err = out.FromSessionRunCompletedEvent(gatewayapi.SessionRunCompletedEvent{
			SessionId: sessionID,
			RunId:     runID,
			RequestId: requestID,
			Type:      gatewayapi.EVENTTYPERUNCOMPLETED,
		})
	case agentpb.EventType_EVENT_TYPE_RUN_INTERRUPTED:
		content := evt.GetContent()
		err = out.FromSessionRunInterruptedEvent(gatewayapi.SessionRunInterruptedEvent{
			SessionId: sessionID,
			RunId:     runID,
			RequestId: requestID,
			Type:      gatewayapi.EVENTTYPERUNINTERRUPTED,
			Content:   optionalString(content),
		})
	case agentpb.EventType_EVENT_TYPE_RUN_ERROR:
		err = out.FromSessionRunErrorEvent(gatewayapi.SessionRunErrorEvent{
			SessionId: sessionID,
			RunId:     runID,
			RequestId: requestID,
			Type:      gatewayapi.EVENTTYPERUNERROR,
			Error:     evt.GetError(),
		})
	default:
		err = out.FromSessionStreamUnspecifiedEvent(gatewayapi.SessionStreamUnspecifiedEvent{
			SessionId: sessionID,
			RunId:     runID,
			RequestId: requestID,
			Type:      gatewayapi.EVENTTYPEUNSPECIFIED,
		})
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
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

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if errors.Is(err, io.EOF) && allowEmpty {
		return true
	}
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request body is invalid",
			err,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "invalid JSON",
			},
		))
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request body must contain one JSON object",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "must contain one JSON object",
			},
		))
		return false
	}
	return true
}

func validSessionID(w http.ResponseWriter, r *http.Request, sessionID string, fields ...string) (string, uuid.UUID, bool) {
	id, err := uuid.Parse(sessionID)
	if err != nil || id.Version() != 4 {
		field := "session_id"
		if len(fields) > 0 && fields[0] != "" {
			field = fields[0]
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   field,
				Message: "must be a valid UUIDv4",
			},
		))
		return "", uuid.Nil, false
	}
	return id.String(), id, true
}

func decodeSequencePageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (int64, bool) {
	if token == nil || strings.TrimSpace(*token) == "" {
		return 0, true
	}
	raw := strings.TrimSpace(*token)
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			err,
		))
		return 0, false
	}
	seq, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || seq < 1 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			errBadRequest,
		))
		return 0, false
	}
	return seq, true
}

func decodeOffsetPageToken(w http.ResponseWriter, r *http.Request, token *gatewayapi.PageTokenQuery) (int, bool) {
	if token == nil || strings.TrimSpace(*token) == "" {
		return 0, true
	}
	raw := strings.TrimSpace(*token)
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			err,
		))
		return 0, false
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			errBadRequest,
		))
		return 0, false
	}
	return offset, true
}

func encodePageToken(seq int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(seq, 10)))
}

func encodeOffsetToken(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func parseStreamIDs(sessionID, runID, requestID string) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	sessionUUID, err := uuid.Parse(sessionID)
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("parse session id: %w", err)
	}
	runUUID, err := uuid.Parse(runID)
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("parse run id: %w", err)
	}
	requestUUID, err := uuid.Parse(requestID)
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("parse request id: %w", err)
	}
	return sessionUUID, runUUID, requestUUID, nil
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func sessionEventSequence(evt *gatewayapi.SessionStreamEvent) int64 {
	if evt == nil {
		return 0
	}
	v, err := evt.ValueByDiscriminator()
	if err != nil || v == nil {
		return 0
	}
	switch e := v.(type) {
	case gatewayapi.SessionStreamUnspecifiedEvent:
		return e.Sequence
	case gatewayapi.SessionRunStartedEvent:
		return e.Sequence
	case gatewayapi.SessionAssistantDeltaEvent:
		return e.Sequence
	case gatewayapi.SessionAssistantMessageEvent:
		return e.Sequence
	case gatewayapi.SessionToolCallEvent:
		return e.Sequence
	case gatewayapi.SessionToolResultEvent:
		return e.Sequence
	case gatewayapi.SessionRunCompletedEvent:
		return e.Sequence
	case gatewayapi.SessionRunInterruptedEvent:
		return e.Sequence
	case gatewayapi.SessionRunErrorEvent:
		return e.Sequence
	default:
		return 0
	}
}

func requestID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if id := strings.TrimSpace(r.Header.Get("X-Request-ID")); id != "" {
		return id
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return uuid.UUID(b).String()
}

func newAPIError(status int, code string, message string, cause error, fields ...gatewayapi.FieldError) *apiError {
	return &apiError{
		status:  status,
		code:    code,
		message: message,
		cause:   cause,
		fields:  fields,
	}
}

func mapResolverHTTPError(err error) *apiError {
	if errors.Is(err, errAgentNotFound) {
		return newAPIError(http.StatusNotFound, "not_found", "agent not found for session", err)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func mapGRPCError(err error) *apiError {
	switch status.Code(err) {
	case codes.InvalidArgument:
		return newAPIError(http.StatusBadRequest, "invalid_request", "request is invalid", err)
	case codes.NotFound:
		return newAPIError(http.StatusNotFound, "not_found", "resource not found", err)
	case codes.FailedPrecondition:
		return newAPIError(http.StatusPreconditionFailed, "failed_precondition", "session is not in the required state", err)
	case codes.AlreadyExists, codes.Aborted:
		return newAPIError(http.StatusConflict, "conflict", "request conflicts with current state", err)
	case codes.Unavailable, codes.DeadlineExceeded:
		return newAPIError(http.StatusServiceUnavailable, "unavailable", "agent backend is unavailable", err)
	default:
		return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
	}
}

func mapGatewayStoreError(action string, err error) *apiError {
	if errors.Is(err, pgx.ErrNoRows) {
		return newAPIError(http.StatusNotFound, "not_found", "session not found", err)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if strings.Contains(pgErr.ConstraintName, "agent_name") {
			return newAPIError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return newAPIError(http.StatusConflict, "conflict", action+" conflicts with existing data", err)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func mapKubeHTTPError(action string, err error) *apiError {
	if apierrors.IsAlreadyExists(err) {
		if action == "create agent" {
			return newAPIError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return newAPIError(http.StatusConflict, "conflict", action+" already exists", err)
	}
	if apierrors.IsNotFound(err) {
		return newAPIError(http.StatusNotFound, "not_found", action+" not found", err)
	}
	if apierrors.IsInvalid(err) || apierrors.IsBadRequest(err) {
		statusErr, ok := err.(apierrors.APIStatus)
		if !ok || statusErr.Status().Details == nil {
			return newAPIError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}
		fields := make([]gatewayapi.FieldError, 0, len(statusErr.Status().Details.Causes))
		for _, cause := range statusErr.Status().Details.Causes {
			if cause.Field == "" {
				continue
			}
			fields = append(fields, gatewayapi.FieldError{
				Field:   cause.Field,
				Message: cause.Message,
			})
		}
		if len(fields) == 0 {
			return newAPIError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}
		return newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			err,
			fields...,
		)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func (s *Service) agentFromCreateRequest(req gatewayapi.CreateAgentRequest, sessionID uuid.UUID, name string, mode gatewayapi.CompactionMode) *clawarmorv1alpha1.Agent {
	thresholdRatio := defaultCreateThresholdRatio
	historyRatio := defaultCreateHistoryToolResultRatio
	keepRecentRequests := int32(defaultCreateKeepRecentRequests)
	oversizedRatio := defaultCreateOversizedToolResultRatio
	if req.Compaction != nil {
		if req.Compaction.ThresholdRatio != nil {
			thresholdRatio = *req.Compaction.ThresholdRatio
		}
		if req.Compaction.HistoryToolResultRatio != nil {
			historyRatio = *req.Compaction.HistoryToolResultRatio
		}
		if req.Compaction.KeepRecentRequests != nil {
			keepRecentRequests = *req.Compaction.KeepRecentRequests
		}
		if req.Compaction.OversizedToolResultRatio != nil {
			oversizedRatio = *req.Compaction.OversizedToolResultRatio
		}
	}
	maxHistoryRuns := int32(defaultCreateMaxHistoryRuns)
	if req.MaxHistoryRuns != nil {
		maxHistoryRuns = *req.MaxHistoryRuns
	}
	primaryTemp := defaultCreateTemperature
	if req.Model.Primary.Temperature != nil {
		primaryTemp = *req.Model.Primary.Temperature
	}

	specMode := clawarmorv1alpha1.CompactionModeSummary
	if mode == gatewayapi.Truncate {
		specMode = clawarmorv1alpha1.CompactionModeTruncate
	}
	env := []corev1.EnvVar{}
	if req.Env != nil {
		keys := make([]string, 0, len(*req.Env))
		for key := range *req.Env {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for _, key := range keys {
			env = append(env, corev1.EnvVar{Name: key, Value: (*req.Env)[key]})
		}
	}
	systemPrompt := ""
	if req.SystemPrompt != nil {
		systemPrompt = *req.SystemPrompt
	}

	compactionEnabled := true
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
			Image: s.cfg.AgentImage,
			Env:   env,
			Server: clawarmorv1alpha1.ServerConfig{
				Address: s.cfg.AgentServerAddress,
			},
			SystemPrompt: systemPrompt,
			Compaction: clawarmorv1alpha1.ContextCompactionConfig{
				Mode:                     specMode,
				Enabled:                  &compactionEnabled,
				ThresholdRatio:           thresholdRatio,
				HistoryToolResultRatio:   historyRatio,
				KeepRecentRequests:       int(keepRecentRequests),
				OversizedToolResultRatio: oversizedRatio,
			},
			MaxHistoryRuns: int(maxHistoryRuns),
			Model: clawarmorv1alpha1.ModelConfig{
				Name:          req.Model.Primary.Name,
				ContextWindow: int(req.Model.Primary.ContextWindow),
				Temperature:   primaryTemp,
				Stream:        true,
			},
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
		},
	}
	if req.Model.Summary != nil {
		summaryTemp := defaultCreateTemperature
		if req.Model.Summary.Temperature != nil {
			summaryTemp = *req.Model.Summary.Temperature
		}
		agt.Spec.SummaryModel = clawarmorv1alpha1.SummaryModelConfig{
			Name:          req.Model.Summary.Name,
			ContextWindow: int(req.Model.Summary.ContextWindow),
			Temperature:   summaryTemp,
		}
	}
	hostExecEnabled := true
	webFetchEnabled := true
	fileEnabled := false
	arxivEnabled := false
	if req.Tools != nil {
		if req.Tools.HostExec != nil && req.Tools.HostExec.Enabled != nil {
			hostExecEnabled = *req.Tools.HostExec.Enabled
		}
		if req.Tools.WebFetch != nil && req.Tools.WebFetch.Enabled != nil {
			webFetchEnabled = *req.Tools.WebFetch.Enabled
		}
		if req.Tools.File != nil && req.Tools.File.Enabled != nil {
			fileEnabled = *req.Tools.File.Enabled
		}
		if req.Tools.Arxiv != nil && req.Tools.Arxiv.Enabled != nil {
			arxivEnabled = *req.Tools.Arxiv.Enabled
		}
	}
	agt.Spec.Tools.HostExec.Enabled = &hostExecEnabled
	agt.Spec.Tools.WebFetch.Enabled = &webFetchEnabled
	agt.Spec.Tools.File.Enabled = &fileEnabled
	agt.Spec.Tools.Arxiv.Enabled = &arxivEnabled
	return agt
}

func (s *Service) handleRouteError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"request is invalid",
		err,
	))
}

func recordRequestError(w http.ResponseWriter, code string, cause error) {
	rec, ok := w.(interface {
		setAPIError(string, error)
	})
	if ok {
		rec.setAPIError(code, cause)
	}
}

func writeError(w http.ResponseWriter, _ *http.Request, e *apiError) {
	if e == nil {
		e = newAPIError(http.StatusInternalServerError, "internal_error", "request failed", nil)
	}
	recordRequestError(w, e.code, e.cause)
	body := gatewayapi.Error{
		Code:    e.code,
		Message: e.message,
	}
	if len(e.fields) > 0 {
		body.Errors = &e.fields
	}
	writeJSON(w, e.status, body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
