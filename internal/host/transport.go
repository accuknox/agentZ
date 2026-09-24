//go:generate protoc --proto_path=../.. --go_out=../.. --go_opt=module=github.com/accuknox/agentz --go-grpc_out=../.. --go-grpc_opt=module=github.com/accuknox/agentz internal/host/proto/host.proto

package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	pb "github.com/accuknox/agentz/internal/host/proto"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const chunkSize = 32 * 1024
const connectionLimit = 64

// Binding is the authenticated assignment and enrollment epoch of a host.
// Authorizers must derive it from the peer identity, never client metadata.
type Binding struct{ Namespace, Agent, Epoch string }

// Status reports host readiness independently of its registration.
type Status struct {
	Generation, Error, Version, WorkDirectory, Hostname, SessionID string
	Ready, Connected                                               bool
}

// Callbacks connect the transport to existing authorization and runtime state.
// Authorize must reject revoked identities on every RPC. Validate checks the
// assignment before registration. Observe must fence assignment and session
// identities, including disconnect notifications. Desired must not mutate
// assignment. DialUpstream accepts only the enumerated backend services.
type Callbacks struct {
	Authorize    func(context.Context) (Binding, error)
	Validate     func(context.Context, Binding) error
	Desired      func(context.Context, Binding) (*pb.Runtime, error)
	Observe      func(context.Context, Binding, Status) error
	DialUpstream func(context.Context, Binding, pb.Service) (net.Conn, error)
}

// Relay bridges authenticated outbound host connections to existing HTTP services.
// Its caller persists enrollment and revocation.
type Relay struct {
	pb.UnimplementedHostRelayServer
	callbacks  Callbacks
	mu         sync.Mutex
	hosts      map[string]*host
	validating map[string]bool
}

type host struct {
	id       string
	binding  Binding
	commands chan *pb.Command
	done     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	pending  map[string]*connection
	forwards int
	ready    bool
}
type connection struct {
	accepted      chan error
	local, remote net.Conn
	claimed       bool
}

// NewRelay constructs the transport registry.
func NewRelay(callbacks Callbacks) *Relay {
	return &Relay{
		callbacks:  callbacks,
		hosts:      make(map[string]*host),
		validating: make(map[string]bool),
	}
}

// Connection returns the live control connection identity and runtime readiness.
// A nonempty epoch restricts the lookup to that exact assignment.
func (s *Relay) Connection(binding Binding) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.hosts[binding.Namespace+"/"+binding.Agent]
	if h == nil || binding.Epoch != "" && h.binding.Epoch != binding.Epoch {
		return "", false
	}
	select {
	case <-h.stop:
		return "", false
	case <-h.done:
		return "", false
	default:
		return h.id, h.ready
	}
}

// RevokeAssignment closes only the named assignment, preserving a newer enrollment.
func (s *Relay) RevokeAssignment(namespace, agent, epoch string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.hosts[namespace+"/"+agent]
	if h == nil || h.binding.Epoch != epoch {
		return
	}
	h.ready = false
	h.stopOnce.Do(func() { close(h.stop) })
	for _, conn := range h.pending {
		conn.local.Close()
		conn.remote.Close()
	}
}

// Control owns one host connection. Local processes outlive this RPC.
func (s *Relay) Control(stream grpc.BidiStreamingServer[pb.Heartbeat, pb.Command]) error {
	if s.callbacks.Authorize == nil {
		return status.Error(codes.Unauthenticated, "host authorization unavailable")
	}
	binding, err := s.callbacks.Authorize(stream.Context())
	if err != nil {
		return err
	}
	if binding.Namespace == "" || binding.Agent == "" || binding.Epoch == "" {
		return status.Error(codes.PermissionDenied, "unassigned host")
	}
	h := &host{
		id: uuid.NewString(), binding: binding,
		commands: make(chan *pb.Command, connectionLimit),
		done:     make(chan struct{}), stop: make(chan struct{}),
		pending: make(map[string]*connection),
	}
	key := binding.Namespace + "/" + binding.Agent
	s.mu.Lock()
	old := s.hosts[key]
	if s.validating[key] || old != nil {
		s.mu.Unlock()
		return status.Error(codes.AlreadyExists, "host already connected")
	}
	s.validating[key] = true
	s.mu.Unlock()
	if s.callbacks.Validate != nil {
		if err := s.callbacks.Validate(stream.Context(), binding); err != nil {
			s.mu.Lock()
			delete(s.validating, key)
			s.mu.Unlock()
			return err
		}
	}
	s.mu.Lock()
	delete(s.validating, key)
	s.hosts[key] = h
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		h.ready = false
		close(h.done)
		for _, p := range h.pending {
			p.local.Close()
			p.remote.Close()
		}
		s.mu.Unlock()
		if s.callbacks.Observe != nil {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(stream.Context()), 5*time.Second)
			defer cancel()
			_ = s.callbacks.Observe(ctx, binding, Status{SessionID: h.id, Error: "host disconnected"})
		}
		// Keep the assignment occupied until its final observation completes,
		// so a reconnect cannot be overwritten by this disconnect notification.
		s.mu.Lock()
		delete(s.hosts, key)
		s.mu.Unlock()
	}()
	heartbeats := make(chan *pb.Heartbeat, 1)
	failures := make(chan error, 1)
	go func() {
		for {
			v, err := stream.Recv()
			if err != nil {
				failures <- err
				return
			}
			select {
			case heartbeats <- v:
			case <-stream.Context().Done():
				return
			case <-h.done:
				return
			}
		}
	}()
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	poll := time.NewTicker(5 * time.Second)
	defer poll.Stop()
	var generation string
	send := func(command *pb.Command) error {
		result := make(chan error, 1)
		go func() { result <- stream.Send(command) }()
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		select {
		case err := <-result:
			return err
		case <-h.stop:
			return status.Error(codes.Aborted, "host connection revoked")
		case <-stream.Context().Done():
			return stream.Context().Err()
		case <-timer.C:
			return status.Error(codes.DeadlineExceeded, "host control send stalled")
		}
	}
	refresh := func() error {
		if s.callbacks.Desired == nil {
			return nil
		}
		runtime, err := s.callbacks.Desired(stream.Context(), binding)
		if err != nil {
			return err
		}
		if runtime == nil || runtime.Generation == generation {
			return nil
		}
		if runtime.Generation == "" || len(runtime.Configuration) > 4*1024*1024 {
			return status.Error(codes.InvalidArgument, "invalid runtime configuration")
		}
		s.mu.Lock()
		h.ready = false
		s.mu.Unlock()
		if err := send(&pb.Command{Body: &pb.Command_Runtime{Runtime: runtime}}); err != nil {
			return err
		}
		generation = runtime.Generation
		return nil
	}
	if err := refresh(); err != nil {
		return err
	}
	for {
		select {
		case <-h.stop:
			return status.Error(codes.Aborted, "host assignment revoked")
		case <-stream.Context().Done():
			return stream.Context().Err()
		case err := <-failures:
			return err
		case <-timer.C:
			return status.Error(codes.DeadlineExceeded, "host heartbeat expired")
		case heartbeat := <-heartbeats:
			timer.Reset(30 * time.Second)
			ready := heartbeat.Ready && generation != "" && heartbeat.Generation == generation
			if s.callbacks.Observe != nil {
				err := s.callbacks.Observe(stream.Context(), binding, Status{
					SessionID: h.id, Generation: heartbeat.Generation, Connected: true,
					Ready: ready, Error: heartbeat.Error, Version: heartbeat.Version,
					WorkDirectory: heartbeat.WorkDirectory, Hostname: heartbeat.Hostname,
				})
				if err != nil {
					return err
				}
			}
			s.mu.Lock()
			select {
			case <-h.stop:
				s.mu.Unlock()
				return status.Error(codes.Aborted, "host assignment revoked")
			default:
				h.ready = ready
			}
			s.mu.Unlock()
		case command := <-h.commands:
			if err := send(command); err != nil {
				return err
			}
		case <-poll.C:
			if err := refresh(); err != nil {
				return err
			}
		}
	}
}

// DialConnection refuses to cross a control reconnect when expected is nonempty.
func (s *Relay) DialConnection(ctx context.Context, namespace, agent, service, expected string) (net.Conn, error) {
	var target pb.Service
	switch service {
	case "opencode":
		target = pb.Service_SERVICE_OPENCODE
	case "filesystem":
		target = pb.Service_SERVICE_FILESYSTEM
	default:
		return nil, fmt.Errorf("unsupported host service %q", service)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	p := &connection{accepted: make(chan error, 1)}
	p.local, p.remote = net.Pipe()
	id := uuid.NewString()
	s.mu.Lock()
	h := s.hosts[namespace+"/"+agent]
	if h == nil || !h.ready || (expected != "" && h.id != expected) {
		s.mu.Unlock()
		p.local.Close()
		p.remote.Close()
		return nil, status.Error(codes.Unavailable, "host offline or runtime not ready")
	}
	if len(h.pending)+h.forwards >= connectionLimit {
		s.mu.Unlock()
		p.local.Close()
		p.remote.Close()
		return nil, status.Error(codes.ResourceExhausted, "host connection limit")
	}
	h.pending[id] = p
	s.mu.Unlock()
	cleanup := func() {
		s.mu.Lock()
		delete(h.pending, id)
		s.mu.Unlock()
		p.local.Close()
		p.remote.Close()
	}
	select {
	case h.commands <- &pb.Command{Body: &pb.Command_Open{Open: &pb.Open{Id: id, Service: target}}}:
	case <-ctx.Done():
		cleanup()
		return nil, ctx.Err()
	case <-h.done:
		cleanup()
		return nil, io.EOF
	}
	select {
	case err := <-p.accepted:
		if err != nil {
			cleanup()
			return nil, err
		}
		return p.local, nil
	case <-ctx.Done():
		cleanup()
		return nil, ctx.Err()
	case <-h.done:
		cleanup()
		return nil, io.EOF
	}
}

// Data attaches a host-originated data stream to a pending, authorized dial.
func (s *Relay) Data(stream grpc.BidiStreamingServer[pb.DataFrame, pb.DataFrame]) error {
	if s.callbacks.Authorize == nil {
		return status.Error(codes.Unauthenticated, "host authorization unavailable")
	}
	binding, err := s.callbacks.Authorize(stream.Context())
	if err != nil {
		return err
	}
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	if frame.Id == "" || len(frame.Data) != 0 || frame.Service != pb.Service_SERVICE_UNSPECIFIED {
		return status.Error(codes.InvalidArgument, "invalid data handshake")
	}
	s.mu.Lock()
	h := s.hosts[binding.Namespace+"/"+binding.Agent]
	if h == nil || h.binding != binding {
		s.mu.Unlock()
		return status.Error(codes.PermissionDenied, "stale host connection")
	}
	p := h.pending[frame.Id]
	if p == nil || p.claimed {
		s.mu.Unlock()
		return status.Error(codes.NotFound, "connection no longer pending")
	}
	p.claimed = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(h.pending, frame.Id); s.mu.Unlock(); p.remote.Close() }()
	if frame.Error != "" {
		p.accepted <- status.Error(codes.Unavailable, "host service unavailable")
		return nil
	}
	if err := stream.Send(&pb.DataFrame{}); err != nil {
		p.accepted <- err
		return err
	}
	p.accepted <- nil
	return relay(stream, p.remote)
}

// Forward exposes only backend services selected by the authenticated host binding.
func (s *Relay) Forward(stream grpc.BidiStreamingServer[pb.DataFrame, pb.DataFrame]) error {
	if s.callbacks.Authorize == nil || s.callbacks.DialUpstream == nil {
		return status.Error(codes.Unauthenticated, "forwarding unavailable")
	}
	binding, err := s.callbacks.Authorize(stream.Context())
	if err != nil {
		return err
	}
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	_, known := pb.Service_name[int32(frame.Service)]
	forwardService := known && frame.Service >= pb.Service_SERVICE_MCP && frame.Service <= pb.Service_SERVICE_TRACES
	if !forwardService || frame.Id != "" || len(frame.Data) != 0 || frame.Error != "" {
		return status.Error(codes.InvalidArgument, "invalid forwarding service")
	}
	// Forward streams share the host's aggregate budget with inbound connections.
	s.mu.Lock()
	h := s.hosts[binding.Namespace+"/"+binding.Agent]
	if h == nil || h.binding != binding {
		s.mu.Unlock()
		return status.Error(codes.PermissionDenied, "host is not connected")
	}
	if len(h.pending)+h.forwards >= connectionLimit {
		s.mu.Unlock()
		return status.Error(codes.ResourceExhausted, "host connection limit")
	}
	select {
	case <-h.stop:
		s.mu.Unlock()
		return status.Error(codes.PermissionDenied, "host assignment revoked")
	case <-h.done:
		s.mu.Unlock()
		return status.Error(codes.PermissionDenied, "host disconnected")
	default:
	}
	h.forwards++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); h.forwards--; s.mu.Unlock() }()
	conn, err := s.callbacks.DialUpstream(stream.Context(), binding, frame.Service)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Closing the control connection must also release the upstream socket.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-h.stop:
			conn.Close()
		case <-h.done:
			conn.Close()
		case <-done:
		}
	}()
	if err := stream.Send(&pb.DataFrame{}); err != nil {
		return err
	}
	return relay(stream, conn)
}

type dataStream interface {
	Send(*pb.DataFrame) error
	Recv() (*pb.DataFrame, error)
}

// relay uses a fixed-size send buffer and one outstanding received frame. The
// caller closes the connection and cancels the RPC on return to release both
// directions, including a peer blocked in Recv. Half-close is not supported.
func relay(stream dataStream, conn net.Conn) error {
	done := make(chan error, 2)
	go func() {
		for {
			buf := make([]byte, chunkSize)
			n, err := conn.Read(buf)
			if n > 0 {
				if sendErr := stream.Send(&pb.DataFrame{Data: buf[:n]}); sendErr != nil {
					done <- sendErr
					return
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				done <- err
				return
			}
			dataOnly := frame.Id == "" && frame.Error == "" && frame.Service == pb.Service_SERVICE_UNSPECIFIED
			if !dataOnly || len(frame.Data) == 0 || len(frame.Data) > chunkSize {
				done <- status.Error(codes.InvalidArgument, "invalid data frame")
				return
			}
			if _, err := conn.Write(frame.Data); err != nil {
				done <- err
				return
			}
		}
	}()
	err := <-done
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
