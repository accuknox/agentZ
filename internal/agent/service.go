package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	grpcHealth "google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/runner"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"

	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
	sessionstore "github.com/accuknox/clawarmor/internal/session"
)

const (
	DefaultListenAddr = "localhost:8080"
	maxRunBuffer      = 512
)

// ServiceConfig describes how to start the agent gRPC server.
type ServiceConfig struct {
	ConfigPath string
}

type service struct {
	agentpb.UnimplementedAgentServiceServer

	rt *Runtime

	mu     sync.Mutex
	active *runState
}

type runState struct {
	sessionID string
	runID     string
	requestID string

	mu          sync.RWMutex
	state       agentpb.RunState
	errMsg      string
	interrupted bool
	buffer      []*agentpb.AgentEvent
	subscribers map[chan *agentpb.AgentEvent]struct{}
	done        chan struct{}
}

// Serve starts the agent gRPC server and blocks until shutdown.
func Serve(ctx context.Context, cfg ServiceConfig) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rt, err := NewRuntime(ctx, RuntimeOptions(cfg))
	if err != nil {
		return err
	}
	defer rt.Close()

	addr := rt.listenAddr
	if addr == "" {
		addr = DefaultListenAddr
	}
	gracefulShutdownTimeout := rt.gracefulShutdownTimeout

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	defer lis.Close()

	healthSvc := grpcHealth.NewServer()
	srv := grpc.NewServer()
	agentpb.RegisterAgentServiceServer(srv, &service{
		rt: rt,
	})
	healthpb.RegisterHealthServer(srv, healthSvc)
	healthSvc.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting agent gRPC server", slog.String("addr", addr))
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

		if gracefulShutdownTimeout == 0 {
			<-stopped
		} else {
			select {
			case <-stopped:
			case <-time.After(gracefulShutdownTimeout):
				srv.Stop()
			}
		}

		err = <-errCh
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve grpc: %w", err)
		}
		return nil
	case err = <-errCh:
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve grpc: %w", err)
		}
		return nil
	}
}

func (s *service) SendUserMessage(ctx context.Context, req *agentpb.SendUserMessageRequest) (*agentpb.SendUserMessageResponse, error) {
	prompt := strings.TrimSpace(req.GetPrompt())
	if prompt == "" {
		return nil, status.Error(codes.InvalidArgument, "prompt is required")
	}
	if s.rt != nil && s.rt.blockedMsg != "" {
		return nil, status.Error(codes.FailedPrecondition, s.rt.blockedMsg)
	}

	s.mu.Lock()
	if s.active != nil {
		active := s.active
		s.mu.Unlock()
		return nil, status.Errorf(codes.FailedPrecondition, "run %q is already active", active.runID)
	}

	runID := uuid.NewString()
	requestID := uuid.NewString()
	run := &runState{
		sessionID:   s.rt.sessionID,
		runID:       runID,
		requestID:   requestID,
		state:       agentpb.RunState_RUN_STATE_RUNNING,
		subscribers: make(map[chan *agentpb.AgentEvent]struct{}),
		done:        make(chan struct{}),
	}
	s.active = run
	s.mu.Unlock()

	evtCh, err := s.rt.runner.Run(
		context.Background(),
		sessionstore.DefaultUserID,
		s.rt.sessionID,
		model.NewUserMessage(prompt),
		agent.WithRequestID(requestID),
	)
	if err != nil {
		s.finishRun(run, agentpb.RunState_RUN_STATE_FAILED, err.Error())
		return nil, status.Errorf(codes.Internal, "run prompt failed: %v", err)
	}

	s.publish(run, &agentpb.AgentEvent{
		SessionId: run.sessionID,
		RunId:     run.runID,
		RequestId: run.requestID,
		Type:      agentpb.EventType_EVENT_TYPE_RUN_STARTED,
		Content:   prompt,
	})

	go s.consumeRun(run, evtCh)

	return &agentpb.SendUserMessageResponse{
		SessionId: run.sessionID,
		RunId:     run.runID,
		RequestId: run.requestID,
	}, nil
}

func (s *service) StreamRun(req *agentpb.StreamRunRequest, stream grpc.ServerStreamingServer[agentpb.AgentEvent]) error {
	run := s.lookupRun(req.GetRunId())
	if run == nil {
		return status.Error(codes.NotFound, "run not found")
	}

	ch := make(chan *agentpb.AgentEvent, 32)
	snapshot := s.subscribe(run, ch)
	defer s.unsubscribe(run, ch)

	for _, evt := range snapshot {
		if err := stream.Send(evt); err != nil {
			return nil
		}
	}

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case <-run.done:
			for {
				select {
				case evt := <-ch:
					if evt == nil {
						return nil
					}
					if err := stream.Send(evt); err != nil {
						return nil
					}
				default:
					return nil
				}
			}
		case evt := <-ch:
			if evt == nil {
				return nil
			}
			if err := stream.Send(evt); err != nil {
				return nil
			}
		}
	}
}

func (s *service) Interrupt(_ context.Context, req *agentpb.InterruptRequest) (*agentpb.InterruptResponse, error) {
	run := s.lookupRun(req.GetRunId())
	if run == nil {
		return nil, status.Error(codes.NotFound, "run not found")
	}
	if s.rt == nil || s.rt.runner == nil {
		return nil, status.Error(codes.Internal, "runner is not available")
	}
	mr, ok := s.rt.runner.(runner.ManagedRunner)
	if !ok {
		return nil, status.Error(codes.Internal, "runner does not support interruption")
	}
	interrupted := mr.Cancel(run.requestID)
	if interrupted {
		run.mu.Lock()
		run.state = agentpb.RunState_RUN_STATE_INTERRUPTED
		run.errMsg = interruptedRunMessage
		alreadyInterrupted := run.interrupted
		run.interrupted = true
		run.mu.Unlock()
		if !alreadyInterrupted {
			s.publish(run, &agentpb.AgentEvent{
				SessionId: run.sessionID,
				RunId:     run.runID,
				RequestId: run.requestID,
				Type:      agentpb.EventType_EVENT_TYPE_RUN_INTERRUPTED,
				Content:   interruptedRunMessage,
			})
		}
	}
	return &agentpb.InterruptResponse{Interrupted: interrupted}, nil
}

func (s *service) Compact(ctx context.Context, _ *agentpb.CompactRequest) (*agentpb.CompactResponse, error) {
	err := s.rt.compactCurrentSession(ctx)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, status.Error(codes.Canceled, err.Error())
		}
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &agentpb.CompactResponse{Message: "compaction checked"}, nil
}

func (r *Runtime) compactCurrentSession(ctx context.Context) error {
	if r != nil && r.blockedMsg != "" {
		return fmt.Errorf("%s", r.blockedMsg)
	}
	if r == nil || r.sessionSvc == nil {
		return fmt.Errorf("session service is not available")
	}

	sess, err := r.sessionSvc.GetSession(ctx, agentsession.Key{
		AppName:   sessionstore.DefaultAppName,
		UserID:    sessionstore.DefaultUserID,
		SessionID: r.sessionID,
	})
	if err != nil {
		return fmt.Errorf("load session: %w", err)
	}

	err = r.sessionSvc.CreateSessionSummary(
		ctx,
		sess,
		sessionstore.DefaultAppName,
		true,
	)
	if err != nil {
		return fmt.Errorf("compact session: %w", err)
	}
	return nil
}

func (s *service) GetActiveRunStatus(_ context.Context, _ *emptypb.Empty) (*agentpb.GetActiveRunStatusResponse, error) {
	s.mu.Lock()
	run := s.active
	s.mu.Unlock()
	if run == nil {
		return nil, status.Error(codes.NotFound, "run not found")
	}
	run.mu.RLock()
	defer run.mu.RUnlock()
	return &agentpb.GetActiveRunStatusResponse{
		Status: &agentpb.RunStatus{
			SessionId: run.sessionID,
			RunId:     run.runID,
			RequestId: run.requestID,
			State:     run.state,
			Error:     run.errMsg,
		},
	}, nil
}

func (s *service) consumeRun(run *runState, evtCh <-chan *event.Event) {
	for evt := range evtCh {
		for _, out := range convertEvent(run, evt) {
			s.publish(run, out)
		}
	}
	run.mu.RLock()
	state := run.state
	interrupted := run.interrupted
	run.mu.RUnlock()
	if interrupted || state == agentpb.RunState_RUN_STATE_INTERRUPTED {
		s.finishRun(run, agentpb.RunState_RUN_STATE_INTERRUPTED, interruptedRunMessage)
		return
	}
	if state == agentpb.RunState_RUN_STATE_RUNNING {
		s.publish(run, &agentpb.AgentEvent{
			SessionId: run.sessionID,
			RunId:     run.runID,
			RequestId: run.requestID,
			Type:      agentpb.EventType_EVENT_TYPE_RUN_COMPLETED,
		})
		s.finishRun(run, agentpb.RunState_RUN_STATE_COMPLETED, "")
	}
}

func (s *service) lookupRun(runID string) *runState {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil {
		return nil
	}
	if s.active.runID != runID {
		return nil
	}
	return s.active
}

func (s *service) subscribe(run *runState, ch chan *agentpb.AgentEvent) []*agentpb.AgentEvent {
	run.mu.Lock()
	defer run.mu.Unlock()
	run.subscribers[ch] = struct{}{}
	snapshot := make([]*agentpb.AgentEvent, len(run.buffer))
	copy(snapshot, run.buffer)
	return snapshot
}

func (s *service) unsubscribe(run *runState, ch chan *agentpb.AgentEvent) {
	run.mu.Lock()
	delete(run.subscribers, ch)
	run.mu.Unlock()
}

func (s *service) publish(run *runState, evt *agentpb.AgentEvent) {
	if evt == nil {
		return
	}
	run.mu.Lock()
	run.buffer = append(run.buffer, evt)
	if len(run.buffer) > maxRunBuffer {
		run.buffer = append([]*agentpb.AgentEvent(nil), run.buffer[len(run.buffer)-maxRunBuffer:]...)
	}
	subs := make([]chan *agentpb.AgentEvent, 0, len(run.subscribers))
	for ch := range run.subscribers {
		subs = append(subs, ch)
	}
	run.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (s *service) finishRun(run *runState, state agentpb.RunState, errMsg string) {
	run.mu.Lock()
	run.state = state
	run.errMsg = errMsg
	select {
	case <-run.done:
	default:
		close(run.done)
	}
	run.mu.Unlock()

	s.mu.Lock()
	if s.active == run {
		s.active = nil
	}
	s.mu.Unlock()
}

func convertEvent(run *runState, evt *event.Event) []*agentpb.AgentEvent {
	if evt == nil {
		return nil
	}
	if evt.Error != nil {
		return []*agentpb.AgentEvent{{
			SessionId: run.sessionID,
			RunId:     run.runID,
			RequestId: run.requestID,
			Type:      agentpb.EventType_EVENT_TYPE_RUN_ERROR,
			Error:     strings.TrimSpace(evt.Error.Message),
		}}
	}
	if evt.Response == nil || len(evt.Choices) == 0 {
		return nil
	}

	choice := evt.Choices[0]
	items := make([]*agentpb.AgentEvent, 0, 4)
	for _, tc := range choice.Delta.ToolCalls {
		items = append(items, &agentpb.AgentEvent{
			SessionId:   run.sessionID,
			RunId:       run.runID,
			RequestId:   run.requestID,
			Type:        agentpb.EventType_EVENT_TYPE_TOOL_CALL,
			ToolName:    tc.Function.Name,
			ToolPayload: string(tc.Function.Arguments),
		})
	}
	for _, tc := range choice.Message.ToolCalls {
		items = append(items, &agentpb.AgentEvent{
			SessionId:   run.sessionID,
			RunId:       run.runID,
			RequestId:   run.requestID,
			Type:        agentpb.EventType_EVENT_TYPE_TOOL_CALL,
			ToolName:    tc.Function.Name,
			ToolPayload: string(tc.Function.Arguments),
		})
	}
	if choice.Message.Role == model.RoleTool {
		items = append(items, &agentpb.AgentEvent{
			SessionId:   run.sessionID,
			RunId:       run.runID,
			RequestId:   run.requestID,
			Type:        agentpb.EventType_EVENT_TYPE_TOOL_RESULT,
			ToolName:    choice.Message.ToolName,
			ToolPayload: choice.Message.Content,
		})
	}
	if choice.Delta.Content != "" {
		items = append(items, &agentpb.AgentEvent{
			SessionId: run.sessionID,
			RunId:     run.runID,
			RequestId: run.requestID,
			Type:      agentpb.EventType_EVENT_TYPE_ASSISTANT_DELTA,
			Content:   choice.Delta.Content,
		})
	}
	if choice.Delta.Content == "" &&
		choice.Message.Role != model.RoleTool &&
		choice.Message.Content != "" {
		items = append(items, &agentpb.AgentEvent{
			SessionId: run.sessionID,
			RunId:     run.runID,
			RequestId: run.requestID,
			Type:      agentpb.EventType_EVENT_TYPE_ASSISTANT_MESSAGE,
			Content:   choice.Message.Content,
		})
	}
	return items
}
