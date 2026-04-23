package repl

import (
	"context"
	"fmt"
	"io"
	"time"

	retry "github.com/avast/retry-go/v4"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/accuknox/clawarmor/internal/agent/gateway"
	gatewaypb "github.com/accuknox/clawarmor/internal/agent/gateway/proto"
)

type gatewayClientConfig struct {
	Target    string
	SessionID string
	Timeout   time.Duration
}

type gatewayClient struct {
	conn      *grpc.ClientConn
	client    gatewaypb.AgentGatewayServiceClient
	sessionID string
	timeout   time.Duration

	status *statusPrinter
}

func newGatewayClient(cfg gatewayClientConfig) (*gatewayClient, error) {
	target := cfg.Target
	if target == "" {
		target = gateway.DefaultListenAddr
	}
	if cfg.SessionID == "" {
		return nil, fmt.Errorf("session id is required")
	}
	conn, err := grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial gateway service: %w", err)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &gatewayClient{
		conn:      conn,
		client:    gatewaypb.NewAgentGatewayServiceClient(conn),
		sessionID: cfg.SessionID,
		timeout:   timeout,
	}, nil
}

func (c *gatewayClient) close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

func (c *gatewayClient) subscribeSession(ctx context.Context, w io.Writer) {
	go func() {
		retryStream(ctx, w, "session", func() error {
			stream, err := c.client.SubscribeSession(ctx, &gatewaypb.SubscribeSessionRequest{
				SessionId: c.sessionID,
			})
			if err != nil {
				return fmt.Errorf("subscribe: %w", err)
			}

			var sawDelta bool
			for {
				evt, recvErr := stream.Recv()
				if recvErr != nil {
					return recvErr
				}
				sawDelta = renderGatewayEvent(w, evt, sawDelta)
				if isGatewayTerminal(evt) {
					sawDelta = false
				}
			}
		})
	}()
}

func (c *gatewayClient) watchStatus(ctx context.Context, w io.Writer) {
	c.status = newStatusPrinter(w)
	go func() {
		retryStream(ctx, w, "status", func() error {
			stream, err := c.client.WatchAgentStatus(ctx, &gatewaypb.WatchAgentStatusRequest{
				SessionIds: []string{c.sessionID},
			})
			if err != nil {
				return fmt.Errorf("watch: %w", err)
			}
			for {
				resp, recvErr := stream.Recv()
				if recvErr != nil {
					return recvErr
				}
				c.status.print(resp.GetStatuses())
			}
		})
	}()
}

func (c *gatewayClient) printStatus(ctx context.Context, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.client.ListAgentStatus(callCtx, &gatewaypb.ListAgentStatusRequest{
		SessionIds: []string{c.sessionID},
	})
	if err != nil {
		return err
	}
	for _, item := range resp.GetStatuses() {
		fmt.Fprintf(
			w,
			"session=%s agent=%s phase=%s reason=%s message=%s\n",
			item.GetSessionId(),
			item.GetAgentName(),
			item.GetPhase().String(),
			item.GetReason(),
			item.GetMessage(),
		)
	}
	return nil
}

func (c *gatewayClient) compact(ctx context.Context, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.client.CompactSession(callCtx, &gatewaypb.CompactSessionRequest{
		SessionId: c.sessionID,
	})
	if err != nil {
		return err
	}
	fmt.Fprintln(w, resp.GetMessage())
	return nil
}

func (c *gatewayClient) streamPrompt(ctx context.Context, prompt string) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.client.SendMessage(callCtx, &gatewaypb.SendMessageRequest{
		SessionId: c.sessionID,
		Prompt:    prompt,
	})
	return err
}

func (c *gatewayClient) interrupt(ctx context.Context) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	_, err := c.client.InterruptSession(callCtx, &gatewaypb.InterruptSessionRequest{
		SessionId: c.sessionID,
	})
	return err
}

func retryStream(ctx context.Context, w io.Writer, name string, fn func() error) {
	err := retry.Do(
		fn,
		retry.Context(ctx),
		retry.Attempts(0),
		retry.Delay(time.Second),
		retry.MaxDelay(10*time.Second),
		retry.DelayType(retry.BackOffDelay),
		retry.LastErrorOnly(true),
		retry.RetryIf(func(error) bool {
			return ctx.Err() == nil
		}),
		retry.OnRetry(func(_ uint, err error) {
			fmt.Fprintf(w, "\n[%s] reconnecting: %v\n", name, err)
		}),
	)
	if err != nil && ctx.Err() == nil {
		fmt.Fprintf(w, "\n[%s] stream stopped: %v\n", name, err)
	}
}

func isGatewayTerminal(evt *gatewaypb.SessionStreamEvent) bool {
	switch evt.GetType() {
	case gatewaypb.EventType_EVENT_TYPE_RUN_COMPLETED,
		gatewaypb.EventType_EVENT_TYPE_RUN_INTERRUPTED,
		gatewaypb.EventType_EVENT_TYPE_RUN_ERROR:
		return true
	default:
		return false
	}
}
