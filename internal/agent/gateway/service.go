package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	grpcHealth "google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	gatewaypb "github.com/accuknox/clawarmor/internal/agent/gateway/proto"
	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

var (
	errAgentNotFound = errors.New("agent not found")
	errRunNotFound   = errors.New("run not found")
)

// Config describes how to start the gateway.
type Config struct {
	Addr                    string
	Namespace               string
	ValkeyAddr              string
	GracefulShutdownTimeout time.Duration
	TargetOverride          string
}

// Service implements the agent gateway gRPC API.
type Service struct {
	gatewaypb.UnimplementedAgentGatewayServiceServer

	ctx      context.Context
	resolver *resolver
	store    *valkeyStore

	mu             sync.Mutex
	consumers      map[string]struct{}
	sessionWaiters map[string]map[chan struct{}]struct{}
}

type activeRun struct {
	sessionID string
	runID     string
	requestID string
}

// Serve starts the agent gateway gRPC server and blocks until shutdown.
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

	lis, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Addr, err)
	}
	defer lis.Close()

	healthSvc := grpcHealth.NewServer()
	srv := grpc.NewServer()
	gatewaypb.RegisterAgentGatewayServiceServer(srv, &Service{
		ctx:            ctx,
		resolver:       resolver,
		store:          store,
		consumers:      make(map[string]struct{}),
		sessionWaiters: make(map[string]map[chan struct{}]struct{}),
	})
	healthpb.RegisterHealthServer(srv, healthSvc)
	healthSvc.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting agent gateway gRPC server",
			slog.String("addr", cfg.Addr),
			slog.String("namespace", cfg.Namespace),
			slog.String("valkey_addr", cfg.ValkeyAddr),
		)
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		healthSvc.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
		stopped := make(chan struct{})
		go func() {
			srv.GracefulStop()
			close(stopped)
		}()
		if cfg.GracefulShutdownTimeout == 0 {
			<-stopped
		} else {
			select {
			case <-stopped:
			case <-time.After(cfg.GracefulShutdownTimeout):
				srv.Stop()
			}
		}
		err = <-errCh
	case err = <-errCh:
	}
	if err != nil && err != grpc.ErrServerStopped {
		return fmt.Errorf("serve grpc: %w", err)
	}
	return nil
}

// SendMessage starts one run routed by session id.
func (s *Service) SendMessage(ctx context.Context, req *gatewaypb.SendMessageRequest) (*gatewaypb.SendMessageResponse, error) {
	sessionID := strings.TrimSpace(req.GetSessionId())
	prompt := strings.TrimSpace(req.GetPrompt())
	if sessionID == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id is required")
	}
	if prompt == "" {
		return nil, status.Error(codes.InvalidArgument, "prompt is required")
	}

	resolved, err := s.resolver.resolveSession(ctx, sessionID)
	if err != nil {
		return nil, mapResolverError(err)
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "dial backend: %v", err)
	}
	defer backend.Close()

	callCtx, cancel := backendCallContext(ctx)
	defer cancel()

	resp, err := backend.client.SendUserMessage(callCtx, &agentpb.SendUserMessageRequest{
		Prompt: prompt,
	})
	if err != nil {
		return nil, err
	}

	meta := runMeta{
		SessionID: resp.GetSessionId(),
		RunID:     resp.GetRunId(),
		RequestID: resp.GetRequestId(),
	}
	if err := s.store.initRun(ctx, meta); err != nil {
		return nil, status.Errorf(codes.Internal, "init run: %v", err)
	}

	if err := s.startConsumer(resp.GetRunId(), resolved.Target); err != nil {
		return nil, status.Errorf(codes.Internal, "start stream consumer: %v", err)
	}
	s.notifySession(resp.GetSessionId())

	return &gatewaypb.SendMessageResponse{
		SessionId: resp.GetSessionId(),
		RunId:     resp.GetRunId(),
		RequestId: resp.GetRequestId(),
	}, nil
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
		slog.ErrorContext(ctx, "dial backend stream failed",
			slog.String("run_id", runID),
			slog.Any("err", err),
		)
		return
	}
	defer backend.Close()

	stream, err := backend.client.StreamRun(ctx, &agentpb.StreamRunRequest{
		RunId: runID,
	})
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
		out := convertBackendEvent(evt)
		if out == nil {
			continue
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
	return s.store.appendEvent(ctx, runID, &gatewaypb.SessionStreamEvent{
		SessionId: run.SessionID,
		RunId:     run.RunID,
		RequestId: run.RequestID,
		Type:      gatewaypb.EventType_EVENT_TYPE_RUN_COMPLETED,
	})
}

// SubscribeSession streams live events for the latest active run in a session.
func (s *Service) SubscribeSession(req *gatewaypb.SubscribeSessionRequest, stream grpc.ServerStreamingServer[gatewaypb.SessionStreamEvent]) error {
	sessionID := strings.TrimSpace(req.GetSessionId())
	if sessionID == "" {
		return status.Error(codes.InvalidArgument, "session_id is required")
	}

	resolved, err := s.resolver.resolveSession(stream.Context(), sessionID)
	if err != nil {
		return mapResolverError(err)
	}

	var runID string
	var afterSeq int64
	for stream.Context().Err() == nil && s.ctx.Err() == nil {
		active, ok, err := s.activeRun(stream.Context(), sessionID, resolved.Target)
		if err != nil {
			return err
		}
		if !ok {
			if runID != "" {
				if err := s.finishRunIfRunning(stream.Context(), runID); err != nil {
					return status.Errorf(codes.Internal, "finish run: %v", err)
				}
				done, err := s.streamRunEvents(stream, runID, &afterSeq)
				if err != nil {
					return err
				}
				if !done {
					return status.Error(codes.Internal, "run ended without terminal event")
				}
			}
			runID = ""
			afterSeq = 0
			if !s.waitForSession(stream.Context(), sessionID, statusPollInterval) {
				return nil
			}
			continue
		}

		if active.runID != runID {
			runID = active.runID
			afterSeq = 0
		}

		err = s.store.initRun(stream.Context(), runMeta{
			SessionID: active.sessionID,
			RunID:     active.runID,
			RequestID: active.requestID,
		})
		if err != nil {
			return status.Errorf(codes.Internal, "init run: %v", err)
		}

		if err := s.startConsumer(active.runID, resolved.Target); err != nil {
			return status.Errorf(codes.Internal, "start stream consumer: %v", err)
		}

		done, err := s.streamRunEvents(stream, active.runID, &afterSeq)
		if err != nil {
			return err
		}
		if done {
			runID = ""
			afterSeq = 0
			if !s.waitForSession(stream.Context(), sessionID, statusPollInterval) {
				return nil
			}
			continue
		}

		if !s.store.waitForAppend(stream.Context(), active.runID, statusPollInterval) {
			return nil
		}
	}
	return nil
}

func (s *Service) streamRunEvents(stream grpc.ServerStreamingServer[gatewaypb.SessionStreamEvent], runID string, afterSeq *int64) (bool, error) {
	items, err := s.store.replay(stream.Context(), runID, *afterSeq)
	if err != nil {
		if errors.Is(err, errRunNotFound) {
			return false, nil
		}
		return false, status.Errorf(codes.Internal, "replay stream: %v", err)
	}
	for _, evt := range items {
		if err := stream.Send(evt); err != nil {
			return false, nil
		}
		*afterSeq = evt.GetSequence()
		if isTerminalState(eventState(evt)) {
			return true, nil
		}
	}
	run, err := s.store.getRun(stream.Context(), runID)
	if err == nil && isTerminalState(run.State) {
		return true, nil
	}
	return false, nil
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

// InterruptSession interrupts the latest active run.
func (s *Service) InterruptSession(ctx context.Context, req *gatewaypb.InterruptSessionRequest) (*gatewaypb.InterruptSessionResponse, error) {
	sessionID := strings.TrimSpace(req.GetSessionId())
	if sessionID == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id is required")
	}
	resolved, err := s.resolver.resolveSession(ctx, sessionID)
	if err != nil {
		return nil, mapResolverError(err)
	}

	active, ok, err := s.activeRun(ctx, sessionID, resolved.Target)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, status.Error(codes.NotFound, "active run not found")
	}

	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "dial backend: %v", err)
	}
	defer backend.Close()
	callCtx, cancel := backendCallContext(ctx)
	defer cancel()
	resp, err := backend.client.Interrupt(callCtx, &agentpb.InterruptRequest{
		RunId: active.runID,
	})
	if err != nil {
		return nil, err
	}
	return &gatewaypb.InterruptSessionResponse{Interrupted: resp.GetInterrupted()}, nil
}

// CompactSession asks the backend to compact the session.
func (s *Service) CompactSession(ctx context.Context, req *gatewaypb.CompactSessionRequest) (*gatewaypb.CompactSessionResponse, error) {
	resolved, err := s.resolver.resolveSession(ctx, req.GetSessionId())
	if err != nil {
		return nil, mapResolverError(err)
	}
	backend, err := newBackendClient(resolved.Target)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "dial backend: %v", err)
	}
	defer backend.Close()
	callCtx, cancel := backendCallContext(ctx)
	defer cancel()
	resp, err := backend.client.Compact(callCtx, &agentpb.CompactRequest{})
	if err != nil {
		return nil, err
	}
	return &gatewaypb.CompactSessionResponse{Message: resp.GetMessage()}, nil
}

// ListAgentStatus returns Kubernetes-backed agent statuses.
func (s *Service) ListAgentStatus(ctx context.Context, req *gatewaypb.ListAgentStatusRequest) (*gatewaypb.ListAgentStatusResponse, error) {
	statuses := make([]*gatewaypb.AgentStatus, 0, len(req.GetSessionIds()))
	for _, sessionID := range req.GetSessionIds() {
		view, err := s.resolver.statusForSession(ctx, sessionID)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "list status: %v", err)
		}
		statuses = append(statuses, statusProto(view))
	}
	sort.Slice(statuses, func(i, j int) bool {
		return statuses[i].GetSessionId() < statuses[j].GetSessionId()
	})
	return &gatewaypb.ListAgentStatusResponse{Statuses: statuses}, nil
}

// WatchAgentStatus streams status changes for the provided sessions.
func (s *Service) WatchAgentStatus(req *gatewaypb.WatchAgentStatusRequest, stream grpc.ServerStreamingServer[gatewaypb.WatchAgentStatusResponse]) error {
	if len(req.GetSessionIds()) == 0 {
		return status.Error(codes.InvalidArgument, "session_ids are required")
	}

	prev := make(map[string]*gatewaypb.AgentStatus, len(req.GetSessionIds()))
	initial := make([]*gatewaypb.AgentStatus, 0, len(req.GetSessionIds()))
	for _, sessionID := range req.GetSessionIds() {
		view, err := s.resolver.statusForSession(stream.Context(), sessionID)
		if err != nil {
			return status.Errorf(codes.Internal, "watch status: %v", err)
		}
		item := statusProto(view)
		prev[sessionID] = item
		initial = append(initial, item)
	}

	err := stream.Send(&gatewaypb.WatchAgentStatusResponse{Statuses: initial})
	if err != nil {
		return nil
	}

	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return nil
		case <-stream.Context().Done():
			return nil
		case <-ticker.C:
			changed := make([]*gatewaypb.AgentStatus, 0, len(req.GetSessionIds()))
			for _, sessionID := range req.GetSessionIds() {
				view, err := s.resolver.statusForSession(stream.Context(), sessionID)
				if err != nil {
					return status.Errorf(codes.Internal, "watch status: %v", err)
				}
				cur := statusProto(view)
				if !sameStatus(prev[sessionID], cur) {
					prev[sessionID] = cur
					changed = append(changed, cur)
				}
			}
			if len(changed) == 0 {
				continue
			}
			err := stream.Send(&gatewaypb.WatchAgentStatusResponse{Statuses: changed})
			if err != nil {
				return nil
			}
		}
	}
}

func convertBackendEvent(evt *agentpb.AgentEvent) *gatewaypb.SessionStreamEvent {
	if evt == nil {
		return nil
	}
	return &gatewaypb.SessionStreamEvent{
		SessionId:        evt.GetSessionId(),
		RunId:            evt.GetRunId(),
		RequestId:        evt.GetRequestId(),
		Type:             gatewaypb.EventType(evt.GetType()),
		Content:          evt.GetContent(),
		ToolName:         evt.GetToolName(),
		ToolPayload:      evt.GetToolPayload(),
		Error:            evt.GetError(),
		ReasoningContent: evt.GetReasoningContent(),
	}
}

func statusProto(view *agentStatusView) *gatewaypb.AgentStatus {
	phase := gatewaypb.AgentPhase_AGENT_PHASE_PROGRESSING
	switch view.Phase {
	case agentPhaseReady:
		phase = gatewaypb.AgentPhase_AGENT_PHASE_READY
	case agentPhaseProgressing:
		phase = gatewaypb.AgentPhase_AGENT_PHASE_PROGRESSING
	case agentPhaseDegraded:
		phase = gatewaypb.AgentPhase_AGENT_PHASE_DEGRADED
	case agentPhaseNotFound:
		phase = gatewaypb.AgentPhase_AGENT_PHASE_NOT_FOUND
	}
	return &gatewaypb.AgentStatus{
		SessionId: view.SessionID,
		AgentName: view.Name,
		Namespace: view.Namespace,
		Phase:     phase,
		Reason:    view.Reason,
		Message:   view.Message,
	}
}

func mapResolverError(err error) error {
	if errors.Is(err, errAgentNotFound) {
		return status.Error(codes.NotFound, "agent not found for session")
	}
	return status.Errorf(codes.Internal, "resolve session: %v", err)
}

func sameStatus(a, b *gatewaypb.AgentStatus) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.GetSessionId() == b.GetSessionId() &&
		a.GetAgentName() == b.GetAgentName() &&
		a.GetNamespace() == b.GetNamespace() &&
		a.GetPhase() == b.GetPhase() &&
		a.GetReason() == b.GetReason() &&
		a.GetMessage() == b.GetMessage()
}
