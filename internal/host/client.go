package host

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	pb "github.com/accuknox/agentz/internal/host/proto"
)

// Client maintains an outbound control session and fixed local service bridges.
// Apply must update desired runtime state independently of the connection lifetime.
type Client struct {
	RPC       pb.HostRelayClient
	Apply     func(context.Context, *pb.Runtime) error
	Status    func() Status
	DialLocal func(context.Context, pb.Service) (net.Conn, error)
	mu        sync.Mutex
	active    bool
	slots     chan struct{}
}

// Run serves one connection attempt. The caller owns reconnect backoff and must
// never use this attempt's context as the lifetime of local runtime processes.
func (c *Client) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := c.RPC.Control(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.active = true
	if c.slots == nil {
		c.slots = make(chan struct{}, connectionLimit)
	}
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.active = false; c.mu.Unlock() }()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			state := c.Status()
			err := stream.Send(&pb.Heartbeat{
				Generation: state.Generation, Ready: state.Ready, Error: state.Error,
				Version: state.Version, WorkDirectory: state.WorkDirectory, Hostname: state.Hostname,
			})
			if err != nil {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	for {
		command, err := stream.Recv()
		if err != nil {
			return err
		}
		switch body := command.Body.(type) {
		case *pb.Command_Runtime:
			if body.Runtime == nil || body.Runtime.Generation == "" {
				return fmt.Errorf("invalid desired runtime")
			}
			// Apply persists desired state and signals a separate supervisor. It must
			// not execute or wait for Nix/systemd work on this receive loop.
			if err := c.Apply(ctx, body.Runtime); err != nil {
				return err
			}
		case *pb.Command_Open:
			if body.Open == nil || body.Open.Id == "" {
				return fmt.Errorf("invalid open request")
			}
			select {
			case c.slots <- struct{}{}:
				go func() { defer func() { <-c.slots }(); c.open(ctx, body.Open) }()
			default:
				return fmt.Errorf("host connection limit exceeded")
			}
		default:
			return fmt.Errorf("unknown control command")
		}
	}
}

func (c *Client) open(ctx context.Context, request *pb.Open) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, err := c.DialLocal(ctx, request.Service)
	handshake := &pb.DataFrame{Id: request.Id}
	if err != nil {
		handshake.Error = "local service unavailable"
	} else {
		defer conn.Close()
	}
	stream, streamErr := c.RPC.Data(ctx)
	if streamErr != nil {
		return
	}
	if stream.Send(handshake) != nil {
		return
	}
	if err != nil {
		_, _ = stream.Recv()
		return
	}
	if _, err := stream.Recv(); err != nil {
		return
	}
	_ = relay(stream, conn)
}

// ServeForward forwards loopback connections to one enumerated backend service.
// The listener must be private to the managed runtime; no destination address
// from the incoming request is used to select a backend connection.
func (c *Client) ServeForward(ctx context.Context, listener net.Listener, service pb.Service) error {
	_, known := pb.Service_name[int32(service)]
	if !known || service < pb.Service_SERVICE_MCP || service > pb.Service_SERVICE_TRACES {
		return fmt.Errorf("invalid backend service")
	}
	go func() { <-ctx.Done(); listener.Close() }()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		c.mu.Lock()
		active := c.active
		slots := c.slots
		c.mu.Unlock()
		if !active {
			conn.Close()
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			conn.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			defer conn.Close()
			forwardCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			stream, err := c.RPC.Forward(forwardCtx)
			if err != nil {
				return
			}
			if err := stream.Send(&pb.DataFrame{Service: service}); err != nil {
				return
			}
			if _, err := stream.Recv(); err != nil {
				return
			}
			_ = relay(stream, conn)
		}()
	}
}
