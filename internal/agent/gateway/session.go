package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

type activeRun struct {
	sessionID string
	runID     string
	requestID string
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

	backend, err := s.backendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}

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
		writeInternalError(w, r, err)
		return
	}
	if err := s.startConsumer(resp.GetRunId(), resolved.Target); err != nil {
		writeInternalError(w, r, err)
		return
	}
	s.notifySession(resp.GetSessionId())

	sessionUUID, runUUID, requestUUID, err := parseStreamIDs(
		resp.GetSessionId(),
		resp.GetRunId(),
		resp.GetRequestId(),
	)
	if err != nil {
		writeInternalError(w, r, err)
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

	backend, err := s.backendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}

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

	backend, err := s.backendClient(resolved.Target)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"unavailable",
			"agent backend is unavailable",
			err,
		))
		return
	}

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
		if err := s.store.initRun(r.Context(), runMeta{
			SessionID: active.sessionID,
			RunID:     active.runID,
			RequestID: active.requestID,
		}); err != nil {
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
		slog.ErrorContext(ctx, "replay stream failed",
			slog.String("run_id", runID),
			slog.Any("err", err),
		)
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
	backend, err := s.backendClient(target)
	if err != nil {
		slog.ErrorContext(ctx, "dial backend stream failed",
			slog.String("run_id", runID),
			slog.Any("err", err),
		)
		return
	}

	stream, err := backend.client.StreamRun(ctx, &agentpb.StreamRunRequest{RunId: runID})
	if err != nil {
		slog.ErrorContext(ctx, "open backend stream failed",
			slog.String("run_id", runID),
			slog.Any("err", err),
		)
		return
	}

	for {
		evt, recvErr := stream.Recv()
		if recvErr != nil {
			if err := s.finishRunIfRunning(ctx, runID); err != nil {
				slog.ErrorContext(ctx, "finish stream event failed",
					slog.String("run_id", runID),
					slog.Any("err", err),
				)
			}
			return
		}

		out, err := convertBackendEvent(evt)
		if err != nil {
			slog.ErrorContext(ctx, "convert stream event failed",
				slog.String("run_id", runID),
				slog.Any("err", err),
			)
			return
		}
		if err := s.store.appendEvent(ctx, runID, out); err != nil {
			slog.ErrorContext(ctx, "persist stream event failed",
				slog.String("run_id", runID),
				slog.Any("err", err),
			)
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

	sessionID, runUUID, requestID, err := parseStreamIDs(
		run.SessionID,
		run.RunID,
		run.RequestID,
	)
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
	backend, err := s.backendClient(target)
	if err != nil {
		return activeRun{}, false, status.Errorf(codes.Unavailable, "dial backend: %v", err)
	}

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

func convertBackendEvent(evt *agentpb.AgentEvent) (*gatewayapi.SessionStreamEvent, error) {
	if evt == nil {
		return nil, fmt.Errorf("event is nil")
	}

	sessionID, runID, requestID, err := parseStreamIDs(
		evt.GetSessionId(),
		evt.GetRunId(),
		evt.GetRequestId(),
	)
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
