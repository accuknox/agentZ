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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	gatewaydb "github.com/accuknox/clawarmor/internal/agent/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

var (
	errAgentNotFound = errors.New("agent not found")
	errRunNotFound   = errors.New("run not found")
	errBadRequest    = errors.New("bad request")
)

// Config describes how to start the gateway.
type Config struct {
	Addr                    string
	Namespace               string
	ValkeyAddr              string
	PostgresDSN             string
	GracefulShutdownTimeout time.Duration
	TargetOverride          string
}

// Service implements the agent gateway HTTP API.
type Service struct {
	ctx      context.Context
	resolver *resolver
	store    *valkeyStore
	queries  gatewaydb.Querier

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
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "limit must be between 1 and 200", errBadRequest))
		return
	}
	beforeSeq, ok := decodeSequencePageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
		return
	}
	if !exists {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "session not found", errAgentNotFound))
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
			writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
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
			writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
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
			writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
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
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "limit must be between 1 and 200", errBadRequest))
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
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
		Agents:        items,
		NextPageToken: next,
	})
}

// SendMessage handles POST /api/send-message.
func (s *Service) SendMessage(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.SendMessageRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	sessionID, _, ok := validSessionID(w, r, req.SessionId.String())
	if !ok {
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "prompt is required", errBadRequest))
		return
	}

	resolved, err := s.resolver.resolveSession(r.Context(), sessionID)
	if err != nil {
		writeError(w, r, mapResolverHTTPError(err))
		return
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusServiceUnavailable, "unavailable", "agent backend is unavailable", err))
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
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
		return
	}
	if err := s.startConsumer(resp.GetRunId(), resolved.Target); err != nil {
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
		return
	}
	s.notifySession(resp.GetSessionId())

	sessionUUID, runUUID, requestUUID, err := parseStreamIDs(resp.GetSessionId(), resp.GetRunId(), resp.GetRequestId())
	if err != nil {
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err))
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
	sessionID, _, ok := validSessionID(w, r, req.SessionId.String())
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
	sessionID, _, ok := validSessionID(w, r, req.SessionId.String())
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
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "active run not found", errRunNotFound))
		return
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusServiceUnavailable, "unavailable", "agent backend is unavailable", err))
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
	sessionID, _, ok := validSessionID(w, r, req.SessionId.String())
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
		writeError(w, r, newAPIError(http.StatusServiceUnavailable, "unavailable", "agent backend is unavailable", err))
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
			sessionID, _, ok := validSessionID(w, r, id.String())
			if !ok {
				return
			}
			sessionIDs = append(sessionIDs, sessionID)
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "streaming is unavailable", nil))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := make(map[uuid.UUID]gatewayapi.Agent)
	send := func(items []gatewayapi.Agent) bool {
		if len(items) == 0 {
			return true
		}
		raw, err := json.Marshal(gatewayapi.WatchAgentsEvent{Agents: items})
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

	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()
	for {
		items, _, err := s.listAgentItems(r.Context(), sessionIDs, 200, 0)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return
			}
			recordRequestError(w, "internal_error", err)
			return
		}
		changed := make([]gatewayapi.Agent, 0, len(items))
		for _, item := range items {
			if !sameAgent(prev[item.SessionId], item) {
				prev[item.SessionId] = item
				changed = append(changed, item)
			}
		}
		if !send(changed) {
			return
		}

		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) streamSession(w http.ResponseWriter, r *http.Request, sessionID, target string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(http.StatusInternalServerError, "internal_error", "streaming is unavailable", nil))
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
		status := gatewayapi.NOTFOUND
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
		return gatewayapi.NOTFOUND
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

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if errors.Is(err, io.EOF) && allowEmpty {
		return true
	}
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "request body is invalid", err))
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "request body must contain one JSON object", errBadRequest))
		return false
	}
	return true
}

func validSessionID(w http.ResponseWriter, r *http.Request, sessionID string) (string, uuid.UUID, bool) {
	id, err := uuid.Parse(sessionID)
	if err != nil || id.Version() != 4 {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "session_id must be a valid UUIDv4", errBadRequest))
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
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "page_token is invalid", err))
		return 0, false
	}
	seq, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || seq < 1 {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "page_token is invalid", errBadRequest))
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
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "page_token is invalid", err))
		return 0, false
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "page_token is invalid", errBadRequest))
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

func newAPIError(status int, code string, message string, cause error) *apiError {
	return &apiError{status: status, code: code, message: message, cause: cause}
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

func (s *Service) handleRouteError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_request", "request is invalid", err))
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
	writeJSON(w, e.status, gatewayapi.Error{
		Code:    e.code,
		Message: e.message,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
