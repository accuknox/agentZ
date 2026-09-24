package host

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
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

func TestTransportReconnectDoesNotReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	binding := Binding{Namespace: "org", Agent: "agent", Epoch: "assignment-1"}
	server := NewRelay(Callbacks{
		Authorize: func(context.Context) (Binding, error) { return binding, nil },
		Desired: func(context.Context, Binding) (*pb.Runtime, error) {
			return &pb.Runtime{Generation: "one", Configuration: []byte(`{}`)}, nil
		},
		Observe: func(_ context.Context, _ Binding, state Status) error {
			if state.Ready {
				if !state.Connected {
					t.Error("ready heartbeat must report connected")
				}
			}
			return nil
		},
	})
	listener := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	pb.RegisterHostRelayServer(grpcServer, server)
	go grpcServer.Serve(listener)
	t.Cleanup(grpcServer.Stop)
	conn, err := grpc.NewClient("passthrough:///test",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	var mu sync.Mutex
	state := Status{}
	applies := 0
	opens := 0
	client := &Client{
		RPC: pb.NewHostRelayClient(conn),
		Apply: func(_ context.Context, runtime *pb.Runtime) error {
			mu.Lock()
			defer mu.Unlock()
			if state.Generation != runtime.Generation {
				applies++
			}
			state = Status{Generation: runtime.Generation, Ready: true}
			return nil
		},
		Status: func() Status {
			mu.Lock()
			defer mu.Unlock()
			return state
		},
		DialLocal: func(context.Context, pb.Service) (net.Conn, error) {
			mu.Lock()
			opens++
			mu.Unlock()
			local, remote := net.Pipe()
			go func() { defer remote.Close(); io.Copy(remote, remote) }()
			return local, nil
		},
	}
	// Initial status can acknowledge the desired generation immediately, keeping
	// this test independent of the production heartbeat interval.
	state = Status{Generation: "one", Ready: true}
	attempt, cancelAttempt := context.WithCancel(ctx)
	finished := make(chan error, 1)
	go func() { finished <- client.Run(attempt) }()
	for {
		if _, ready := server.Connection(binding); ready {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("host never became ready")
		case <-time.After(time.Millisecond):
		}
	}
	tunnel, err := server.DialConnection(ctx, "org", "agent", "opencode", "")
	if err != nil {
		t.Fatal(err)
	}
	firstConnection, online := server.Connection(Binding{Namespace: "org", Agent: "agent"})
	if !online || firstConnection == "" {
		t.Fatal("ready host has no connection identity")
	}
	id, ready := server.Connection(Binding{
		Namespace: "org", Agent: "agent", Epoch: "previous-assignment",
	})
	if id != "" || ready {
		t.Fatal("replacement assignment exposed another assignment's session")
	}
	if id, ready := server.Connection(binding); id != firstConnection || !ready {
		t.Fatal("current assignment lost its live session")
	}
	payload := bytes.Repeat([]byte("streamed bytes"), 70000)
	written := make(chan error, 1)
	go func() { _, err := tunnel.Write(payload); written <- err }()
	actual := make([]byte, len(payload))
	if _, err := io.ReadFull(tunnel, actual); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, actual) {
		t.Fatal("data changed crossing relay")
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := tunnel.SetReadDeadline(time.Now().Add(10 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := tunnel.Read(make([]byte, 1)); !errors.Is(err, context.DeadlineExceeded) {
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			t.Fatalf("deadline not implemented: %v", err)
		}
	}
	if err := tunnel.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	server.RevokeAssignment("org", "agent", binding.Epoch)
	if _, err := tunnel.Read(make([]byte, 1)); err == nil {
		t.Fatal("revoked data stream remained usable")
	}
	tunnel.Close()
	cancelAttempt()
	<-finished
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		server.mu.Lock()
		offline := server.hosts["org/agent"] == nil
		server.mu.Unlock()
		if offline {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("host did not go offline")
		case <-time.After(time.Millisecond):
		}
	}
	_, err = server.DialConnection(ctx, "org", "agent", "opencode", "")
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("offline host accepted work: %v", err)
	}
	if _, err := server.DialConnection(ctx, "org", "agent", "127.0.0.1:22", ""); err == nil {
		t.Fatal("arbitrary destination accepted")
	}
	attempt, cancelAttempt = context.WithCancel(ctx)
	defer cancelAttempt()
	go func() { finished <- client.Run(attempt) }()
	for {
		if _, ready := server.Connection(binding); ready {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("host did not reconnect")
		case <-time.After(time.Millisecond):
		}
	}
	secondConnection, online := server.Connection(Binding{Namespace: "org", Agent: "agent"})
	if !online || secondConnection == firstConnection {
		t.Fatal("reconnect reused a pending-work connection identity")
	}
	_, err = server.DialConnection(ctx, "org", "agent", "opencode", firstConnection)
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("old admission crossed reconnect: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if opens != 1 {
		t.Fatalf("replayed local dials: %d", opens)
	}
	if applies != 0 {
		t.Fatalf("runtime was restarted for unchanged generation: %d", applies)
	}
	if !state.Ready {
		t.Fatal("disconnect stopped local runtime")
	}
}

func TestForwardRequiresControlAndEnumeratedService(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	called := false
	server := NewRelay(Callbacks{Authorize: func(context.Context) (Binding, error) {
		return Binding{Namespace: "org", Agent: "agent", Epoch: "epoch"}, nil
	}, DialUpstream: func(context.Context, Binding, pb.Service) (net.Conn, error) {
		called = true
		return nil, errors.New("unexpected")
	}})
	listener := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	pb.RegisterHostRelayServer(grpcServer, server)
	go grpcServer.Serve(listener)
	defer grpcServer.Stop()
	conn, err := grpc.NewClient("passthrough:///test",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, service := range []pb.Service{pb.Service_SERVICE_OPENCODE, pb.Service_SERVICE_MCP} {
		stream, err := pb.NewHostRelayClient(conn).Forward(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := stream.Send(&pb.DataFrame{Service: service}); err != nil {
			t.Fatal(err)
		}
		_, err = stream.Recv()
		if err == nil {
			t.Fatal("unregistered host stream accepted")
		}
	}
	if called {
		t.Fatal("dialed upstream without active authorized control")
	}
}

func TestForwardSharesConnectionBudgetAndReleasesSlots(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var failDial atomic.Bool
	binding := Binding{Namespace: "org", Agent: "agent", Epoch: "assignment"}
	server := NewRelay(Callbacks{
		Authorize: func(context.Context) (Binding, error) { return binding, nil },
		Desired: func(context.Context, Binding) (*pb.Runtime, error) {
			return &pb.Runtime{Generation: "ready", Configuration: []byte(`{}`)}, nil
		},
		DialUpstream: func(context.Context, Binding, pb.Service) (net.Conn, error) {
			if failDial.Swap(false) {
				return nil, status.Error(codes.Unavailable, "upstream unavailable")
			}
			local, remote := net.Pipe()
			go func() { defer remote.Close(); _, _ = io.Copy(remote, remote) }()
			return local, nil
		},
	})
	listener := bufconn.Listen(1 << 20)
	grpcServer := grpc.NewServer()
	pb.RegisterHostRelayServer(grpcServer, server)
	go grpcServer.Serve(listener)
	defer grpcServer.Stop()
	conn, err := grpc.NewClient("passthrough:///test",
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
	control, err := client.Control(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.Recv(); err != nil {
		t.Fatal(err)
	}
	if err := control.Send(&pb.Heartbeat{Ready: true, Generation: "ready"}); err != nil {
		t.Fatal(err)
	}
	for {
		if _, ready := server.Connection(binding); ready {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("host did not become ready")
		case <-time.After(time.Millisecond):
		}
	}
	cancellations := make([]context.CancelFunc, 0, connectionLimit)
	for range connectionLimit - 1 {
		forwardCtx, stop := context.WithCancel(ctx)
		cancellations = append(cancellations, stop)
		forward, err := client.Forward(forwardCtx)
		if err != nil {
			t.Fatal(err)
		}
		if err := forward.Send(&pb.DataFrame{Service: pb.Service_SERVICE_MCP}); err != nil {
			t.Fatal(err)
		}
		if _, err := forward.Recv(); err != nil {
			t.Fatal(err)
		}
	}
	dialCtx, stopDial := context.WithCancel(ctx)
	defer stopDial()
	dialDone := make(chan error, 1)
	go func() {
		_, err := server.DialConnection(dialCtx, "org", "agent", "opencode", "")
		dialDone <- err
	}()
	if command, err := control.Recv(); err != nil || command.GetOpen() == nil {
		t.Fatalf("inbound connection did not consume remaining slot: %v", err)
	}
	excess, err := client.Forward(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := excess.Send(&pb.DataFrame{Service: pb.Service_SERVICE_MCP}); err != nil {
		t.Fatal(err)
	}
	if _, err := excess.Recv(); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("forward bypassed aggregate connection budget: %v", err)
	}
	stopDial()
	if err := <-dialDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel pending dial: %v", err)
	}
	failDial.Store(true)
	failed, err := client.Forward(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := failed.Send(&pb.DataFrame{Service: pb.Service_SERVICE_MCP}); err != nil {
		t.Fatal(err)
	}
	if _, err := failed.Recv(); status.Code(err) != codes.Unavailable {
		t.Fatalf("dial failure: %v", err)
	}
	replacement, err := client.Forward(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := replacement.Send(&pb.DataFrame{Service: pb.Service_SERVICE_MCP}); err != nil {
		t.Fatal(err)
	}
	if _, err := replacement.Recv(); err != nil {
		t.Fatalf("failed dial leaked budget: %v", err)
	}
	cancellations[0]()
	for {
		replacement, err = client.Forward(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := replacement.Send(&pb.DataFrame{Service: pb.Service_SERVICE_MCP}); err != nil {
			t.Fatal(err)
		}
		_, err = replacement.Recv()
		if err == nil {
			break
		}
		if status.Code(err) != codes.ResourceExhausted {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("cancelled forward leaked budget")
		case <-time.After(time.Millisecond):
		}
	}
	server.RevokeAssignment("org", "agent", binding.Epoch)
	if _, err := replacement.Recv(); err == nil {
		t.Fatal("revocation retained upstream forward")
	}
}
