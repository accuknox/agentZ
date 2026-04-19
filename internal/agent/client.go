package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	agentpb "github.com/accuknox/clawarmor/internal/agent/proto"
)

// ClientConfig configures the remote agent service adapter.
type ClientConfig struct {
	Target  string
	Timeout time.Duration
}

// Client implements the remote agent REPL transport over gRPC.
type Client struct {
	conn    *grpc.ClientConn
	client  agentpb.AgentServiceClient
	timeout time.Duration
}

// NewClient dials the remote agent service.
func NewClient(cfg ClientConfig) (*Client, error) {
	target := cfg.Target
	if target == "" {
		target = DefaultListenAddr
	}
	conn, err := grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial agent service: %w", err)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{
		conn:    conn,
		client:  agentpb.NewAgentServiceClient(conn),
		timeout: timeout,
	}, nil
}

// Close closes the underlying gRPC connection.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Compact requests remote session compaction.
func (c *Client) Compact(ctx context.Context, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.client.Compact(callCtx, &agentpb.CompactRequest{})
	if err != nil {
		return err
	}
	fmt.Fprintln(w, resp.GetMessage())
	return nil
}

// StreamPrompt sends one user message and streams the remote run output.
func (c *Client) StreamPrompt(ctx context.Context, prompt string, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	started, err := c.client.SendUserMessage(callCtx, &agentpb.SendUserMessageRequest{
		Prompt: prompt,
	})
	if err != nil {
		return err
	}

	streamCtx, streamCancel := context.WithCancel(ctx)
	defer streamCancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT)
	defer signal.Stop(sigCh)

	go func() {
		select {
		case <-streamCtx.Done():
			return
		case <-sigCh:
		}
		interruptCtx, cancelInterrupt := context.WithTimeout(context.Background(), c.timeout)
		defer cancelInterrupt()
		_, _ = c.client.Interrupt(interruptCtx, &agentpb.InterruptRequest{
			RunId: started.GetRunId(),
		})
	}()

	stream, err := c.client.StreamRun(streamCtx, &agentpb.StreamRunRequest{
		RunId: started.GetRunId(),
	})
	if err != nil {
		return err
	}

	var sawDelta bool
	for {
		evt, recvErr := stream.Recv()
		if recvErr != nil {
			if errors.Is(recvErr, io.EOF) {
				fmt.Fprintln(w)
				return nil
			}
			return recvErr
		}
		sawDelta = renderAgentEvent(w, evt, sawDelta)
		if evt.GetType() == agentpb.EventType_EVENT_TYPE_RUN_COMPLETED ||
			evt.GetType() == agentpb.EventType_EVENT_TYPE_RUN_INTERRUPTED {
			fmt.Fprintln(w)
			return nil
		}
	}
}
