package compute

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/accuknox/agentz/internal/compute/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

func TestTransportReconnectDoesNotReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	ready := make(chan struct{}, 4)
	binding := Binding{Namespace: "org", Agent: "agent", Epoch: "lease-1"}
	server := NewServer(Callbacks{
		Authorize: func(context.Context) (Binding, error) { return binding, nil },
		Desired: func(context.Context, Binding) (*pb.Runtime, error) {
			return &pb.Runtime{Generation: "one", Configuration: []byte(`{}`)}, nil
		},
		Observe: func(_ context.Context, _ Binding, state Status) error {
			if state.Ready {
				if !state.Connected {
					t.Error("ready heartbeat must report connected")
				}
				select {
				case ready <- struct{}{}:
				default:
				}
			}
			return nil
		},
	})
	listener := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	pb.RegisterComputeServer(grpcServer, server)
	go grpcServer.Serve(listener)
	t.Cleanup(grpcServer.Stop)
	conn, err := grpc.NewClient("passthrough:///test", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	var mu sync.Mutex
	state := Status{}
	applies := 0
	opens := 0
	client := &Client{RPC: pb.NewComputeClient(conn), Apply: func(_ context.Context, runtime *pb.Runtime) error {
		mu.Lock()
		defer mu.Unlock()
		if state.Generation != runtime.Generation {
			applies++
		}
		state = Status{Generation: runtime.Generation, Ready: true}
		return nil
	}, Status: func() Status { mu.Lock(); defer mu.Unlock(); return state }, DialLocal: func(context.Context, pb.Service) (net.Conn, error) {
		mu.Lock()
		opens++
		mu.Unlock()
		local, remote := net.Pipe()
		go func() { defer remote.Close(); io.Copy(remote, remote) }()
		return local, nil
	}}
	// Initial status can acknowledge the desired generation immediately, keeping
	// this test independent of the production heartbeat interval.
	state = Status{Generation: "one", Ready: true}
	attempt, cancelAttempt := context.WithCancel(ctx)
	finished := make(chan error, 1)
	go func() { finished <- client.Run(attempt) }()
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("host never became ready")
	}
	tunnel, err := server.DialContext(ctx, "org", "agent", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	firstConnection, online := server.Connection("org", "agent")
	if !online || firstConnection == "" {
		t.Fatal("ready host has no connection identity")
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
	server.Revoke("org", "agent")
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
	if _, err := server.DialContext(ctx, "org", "agent", "opencode"); status.Code(err) != codes.Unavailable {
		t.Fatalf("offline host accepted work: %v", err)
	}
	if _, err := server.DialContext(ctx, "org", "agent", "127.0.0.1:22"); err == nil {
		t.Fatal("arbitrary destination accepted")
	}
	attempt, cancelAttempt = context.WithCancel(ctx)
	defer cancelAttempt()
	go func() { finished <- client.Run(attempt) }()
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("host did not reconnect")
	}
	secondConnection, online := server.Connection("org", "agent")
	if !online || secondConnection == firstConnection {
		t.Fatal("reconnect reused a pending-work connection identity")
	}
	if _, err := server.DialConnection(ctx, "org", "agent", "opencode", firstConnection); status.Code(err) != codes.Unavailable {
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
	server := NewServer(Callbacks{Authorize: func(context.Context) (Binding, error) {
		return Binding{Namespace: "org", Agent: "agent", Epoch: "epoch"}, nil
	}, DialUpstream: func(context.Context, Binding, pb.Service) (net.Conn, error) {
		called = true
		return nil, errors.New("unexpected")
	}})
	listener := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	pb.RegisterComputeServer(grpcServer, server)
	go grpcServer.Serve(listener)
	defer grpcServer.Stop()
	conn, err := grpc.NewClient("passthrough:///test", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, service := range []pb.Service{pb.Service_SERVICE_OPENCODE, pb.Service_SERVICE_MCP} {
		stream, err := pb.NewComputeClient(conn).Forward(ctx)
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
