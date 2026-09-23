package host

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/accuknox/agentz/internal/host/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type controlFixture struct {
	pb.UnimplementedRelayControlServer
	opened  atomic.Int32
	session atomic.Pointer[pb.SessionResponse]
	closed  chan struct{}
}

func (f *controlFixture) GetSession(_ context.Context, _ *pb.SessionRequest) (*pb.SessionResponse, error) {
	return f.session.Load(), nil
}

func (f *controlFixture) Dial(stream grpc.BidiStreamingServer[pb.RelayFrame, pb.RelayFrame]) error {
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	if frame.Target == nil || frame.Target.SessionId != f.session.Load().SessionId || frame.Target.Service != pb.Service_SERVICE_OPENCODE {
		return status.Error(codes.Aborted, "session changed")
	}
	f.opened.Add(1)
	defer func() { f.closed <- struct{}{} }()
	local, remote := net.Pipe()
	defer local.Close()
	go func() { defer remote.Close(); _, _ = io.Copy(remote, remote) }()
	if err := stream.Send(&pb.RelayFrame{Ready: true}); err != nil {
		return err
	}
	return BridgeRelay(stream, local)
}

func TestRelayClientSessionFenceAndCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	fixture := &controlFixture{closed: make(chan struct{}, 1)}
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterRelayControlServer(server, fixture)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///relay",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.session.Store(&pb.SessionResponse{SessionId: "first", Ready: true})
	client := &RelayClient{conn: conn, client: pb.NewRelayControlClient(conn)}
	t.Cleanup(func() { client.Close() })
	id, ready, err := client.Connection(ctx, "tenant", "agent")
	if err != nil || id != "first" || !ready {
		t.Fatalf("connection: %q %t %v", id, ready, err)
	}
	streamCtx, stopStream := context.WithCancel(ctx)
	tunnel, err := client.DialConnection(streamCtx, "tenant", "agent", "opencode", id)
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	payload := bytes.Repeat([]byte("bounded transport"), 10000)
	written := make(chan error, 1)
	go func() { _, err := tunnel.Write(payload); written <- err }()
	received := make([]byte, len(payload))
	if _, err := io.ReadFull(tunnel, received); err != nil || !bytes.Equal(payload, received) {
		t.Fatalf("roundtrip: %v", err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := tunnel.SetReadDeadline(time.Now().Add(10 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := tunnel.Read(make([]byte, 1)); err == nil {
		t.Fatal("net.Conn read deadline was ignored")
	}
	fixture.session.Store(&pb.SessionResponse{SessionId: "second", Ready: true})
	if _, err := client.DialConnection(ctx, "tenant", "agent", "opencode", id); status.Code(err) != codes.Aborted {
		t.Fatalf("old admission was not fenced: %v", err)
	}
	if fixture.opened.Load() != 1 {
		t.Fatal("old admission opened a replacement stream")
	}
	stopStream()
	select {
	case <-fixture.closed:
	case <-ctx.Done():
		t.Fatal("cancellation did not close server bridge")
	}
	if _, err := tunnel.Write([]byte("after cancellation")); err == nil {
		t.Fatal("cancelled connection accepted bytes")
	}
}

func TestRelayValidationFailureDoesNotObserveDisconnect(t *testing.T) {
	var observations atomic.Int32
	relay := NewRelay(Callbacks{
		Authorize: func(context.Context) (Binding, error) {
			return Binding{Namespace: "tenant", Agent: "agent", Epoch: "assignment"}, nil
		},
		Validate: func(context.Context, Binding) error {
			return status.Error(codes.AlreadyExists, "invalid assignment")
		},
		Observe: func(context.Context, Binding, Status) error { observations.Add(1); return nil },
	})
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterHostRelayServer(server, relay)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///relay",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	stream, err := pb.NewHostRelayClient(conn).Control(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = stream.Recv()
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("validation rejection lost: %v", err)
	}
	if id, _ := relay.Connection(Binding{Namespace: "tenant", Agent: "agent"}); id != "" || observations.Load() != 0 {
		t.Fatal("failed validation published state")
	}
	if _, err := NewRelayClient("relay", &tls.Config{InsecureSkipVerify: true}); err == nil {
		t.Fatal("unverified relay TLS was accepted")
	}
}

func TestRelayObservationFailureClosesSession(t *testing.T) {
	observed := make(chan Status, 2)
	relay := NewRelay(Callbacks{
		Authorize: func(context.Context) (Binding, error) {
			return Binding{Namespace: "tenant", Agent: "agent", Epoch: "assignment"}, nil
		},
		Observe: func(_ context.Context, _ Binding, state Status) error {
			observed <- state
			return status.Error(codes.Aborted, "assignment revoked")
		},
	})
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterHostRelayServer(server, relay)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///relay",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	stream, err := pb.NewHostRelayClient(conn).Control(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&pb.Heartbeat{Ready: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Recv(); status.Code(err) != codes.Aborted {
		t.Fatalf("failed observation did not close stream: %v", err)
	}
	for _, connected := range []bool{true, false} {
		select {
		case state := <-observed:
			if state.Connected != connected || state.SessionID == "" {
				t.Fatalf("observation lost session identity: %+v", state)
			}
		case <-ctx.Done():
			t.Fatal("missing session observation")
		}
	}
	if id, ready := relay.Connection(Binding{Namespace: "tenant", Agent: "agent"}); id != "" || ready {
		t.Fatal("failed observation retained usable host")
	}
}

func TestRelayReconnectWaitsForDisconnectObservation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var binding atomic.Pointer[Binding]
	binding.Store(&Binding{Namespace: "tenant", Agent: "agent", Epoch: "first"})
	ready := make(chan struct{})
	disconnecting := make(chan struct{})
	finishObservation := make(chan struct{})
	relay := NewRelay(Callbacks{
		Authorize: func(context.Context) (Binding, error) { return *binding.Load(), nil },
		Desired: func(context.Context, Binding) (*pb.Runtime, error) {
			return &pb.Runtime{Generation: "runtime", Configuration: []byte(`{}`)}, nil
		},
		Observe: func(ctx context.Context, b Binding, state Status) error {
			if state.Connected {
				close(ready)
			}
			if b.Epoch == "first" && !state.Connected {
				close(disconnecting)
				select {
				case <-finishObservation:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		},
	})
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterHostRelayServer(server, relay)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///relay",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := pb.NewHostRelayClient(conn)
	firstCtx, disconnect := context.WithCancel(ctx)
	defer disconnect()
	first, err := client.Control(firstCtx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := first.Send(&pb.Heartbeat{Generation: "runtime", Ready: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("host did not become ready")
	}
	disconnect()
	select {
	case <-disconnecting:
	case <-ctx.Done():
		t.Fatal("disconnect did not reach observation")
	}
	if _, err := relay.DialConnection(ctx, "tenant", "agent", "opencode", ""); status.Code(err) != codes.Unavailable {
		t.Fatalf("disconnect retained admission during final observation: %v", err)
	}
	binding.Store(&Binding{Namespace: "tenant", Agent: "agent", Epoch: "replacement"})
	replacement, err := client.Control(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := replacement.Recv(); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("new assignment bypassed pending disconnect observation: %v", err)
	}
	close(finishObservation)
	// Wait for the callback to finish and release the registration before reconnect.
	for {
		replacement, err = client.Control(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = replacement.Recv()
		if err == nil {
			break
		}
		if status.Code(err) != codes.AlreadyExists {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("completed disconnect retained assignment")
		case <-time.After(time.Millisecond):
		}
	}
	if id, _ := relay.Connection(*binding.Load()); id == "" {
		t.Fatal("replacement assignment did not register after disconnect completed")
	}
}
