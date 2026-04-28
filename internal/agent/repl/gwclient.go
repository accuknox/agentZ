package repl

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	retry "github.com/avast/retry-go/v4"
	"github.com/google/uuid"

	"github.com/accuknox/clawarmor/internal/agent/gateway"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

type gatewayClientConfig struct {
	Target    string
	SessionID string
	Timeout   time.Duration
}

type gatewayClient struct {
	api     *gatewayapi.ClientWithResponses
	session uuid.UUID
	timeout time.Duration

	status          *statusPrinter
	sawMu           sync.Mutex
	sawContentDelta bool
}

func newGatewayClient(cfg gatewayClientConfig) (*gatewayClient, error) {
	target := strings.TrimRight(strings.TrimSpace(cfg.Target), "/")
	if target == "" {
		target = gateway.DefaultBaseURL
	}
	if !strings.Contains(target, "://") {
		target = "http://" + target
	}
	if _, err := url.ParseRequestURI(target); err != nil {
		return nil, fmt.Errorf("parse gateway target: %w", err)
	}
	if cfg.SessionID == "" {
		return nil, fmt.Errorf("session id is required")
	}
	sessionID, err := uuid.Parse(cfg.SessionID)
	if err != nil || sessionID.Version() != 4 {
		return nil, fmt.Errorf("session id must be a valid UUIDv4")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	api, err := gatewayapi.NewClientWithResponses(target, gatewayapi.WithHTTPClient(&http.Client{}))
	if err != nil {
		return nil, fmt.Errorf("create gateway client: %w", err)
	}
	return &gatewayClient{
		api:     api,
		session: sessionID,
		timeout: timeout,
	}, nil
}

func (c *gatewayClient) printChatHistory(ctx context.Context, w io.Writer, limit int) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	queryLimit := gatewayapi.LimitQuery(limit)
	resp, err := c.api.GetChatHistoryWithResponse(callCtx, &gatewayapi.GetChatHistoryParams{
		SessionId: c.session,
		Limit:     &queryLimit,
	})
	if err != nil {
		return fmt.Errorf("gateway request: %w", err)
	}
	if resp.JSON200 == nil {
		return gatewayResponseError(resp.HTTPResponse, resp.Body)
	}
	if len(resp.JSON200.Events) == 0 {
		return nil
	}
	fmt.Fprintln(w, "\n[history]")
	for _, item := range resp.JSON200.Events {
		renderHistoryEvent(w, item)
	}
	return nil
}

func (c *gatewayClient) subscribeSession(ctx context.Context, w io.Writer) {
	go func() {
		retryStream(ctx, w, "session", func() error {
			body := gatewayapi.SessionActionRequest{SessionId: c.session.String()}
			resp, err := c.api.SubscribeSession(ctx, body, acceptSSE)
			if err != nil {
				return fmt.Errorf("open stream: %w", err)
			}
			return c.readSSE(resp, func(raw []byte) {
				var evt gatewayapi.SessionStreamEvent
				if err := json.Unmarshal(raw, &evt); err != nil {
					fmt.Fprintf(w, "\n[session] decode error: %v\n", err)
					return
				}
				c.renderSessionEvent(w, &evt)
			})
		})
	}()
}

func (c *gatewayClient) watchStatus(ctx context.Context, w io.Writer) {
	c.status = newStatusPrinter(w)
	go func() {
		retryStream(ctx, w, "status", func() error {
			ids := []gatewayapi.SessionIDInput{c.session.String()}
			body := gatewayapi.WatchAgentsRequest{
				SessionIds: &ids,
			}
			resp, err := c.api.WatchAgents(ctx, body, acceptSSE)
			if err != nil {
				return fmt.Errorf("open stream: %w", err)
			}
			return c.readSSE(resp, func(raw []byte) {
				var evt gatewayapi.WatchAgentsEvent
				if err := json.Unmarshal(raw, &evt); err != nil {
					fmt.Fprintf(w, "\n[status] decode error: %v\n", err)
					return
				}
				c.status.print(evt.Agents)
			})
		})
	}()
}

func (c *gatewayClient) printStatus(ctx context.Context, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	ids := []gatewayapi.SessionID{c.session}
	resp, err := c.api.ListAgents(callCtx, &gatewayapi.ListAgentsParams{SessionId: &ids})
	if err != nil {
		return fmt.Errorf("gateway request: %w", err)
	}
	var out gatewayapi.ListAgentsResponse
	if err := decodeJSONResponse(resp, &out); err != nil {
		return err
	}
	for _, item := range out.Agents {
		fmt.Fprintf(
			w,
			"session=%s agent=%s phase=%s\n",
			item.SessionId,
			item.Name,
			item.Status,
		)
	}
	return nil
}

func (c *gatewayClient) compact(ctx context.Context, w io.Writer) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.api.CompactSession(callCtx,
		gatewayapi.SessionActionRequest{SessionId: c.session.String()},
	)
	if err != nil {
		return fmt.Errorf("gateway request: %w", err)
	}
	var out gatewayapi.CompactSessionResponse
	if err := decodeJSONResponse(resp, &out); err != nil {
		return err
	}
	fmt.Fprintln(w, out.Message)
	return nil
}

func (c *gatewayClient) streamPrompt(ctx context.Context, prompt string) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.api.SendMessage(callCtx,
		gatewayapi.SendMessageRequest{
			SessionId: c.session.String(),
			Prompt:    prompt,
		},
	)
	if err != nil {
		return fmt.Errorf("gateway request: %w", err)
	}
	var out gatewayapi.SendMessageResponse
	return decodeJSONResponse(resp, &out)
}

func (c *gatewayClient) interrupt(ctx context.Context) error {
	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.api.InterruptSession(callCtx,
		gatewayapi.SessionActionRequest{SessionId: c.session.String()},
	)
	if err != nil {
		return fmt.Errorf("gateway request: %w", err)
	}
	var out gatewayapi.InterruptSessionResponse
	return decodeJSONResponse(resp, &out)
}

func decodeJSONResponse(resp *http.Response, out any) error {
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return decodeGatewayError(resp)
	}
	if out == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (c *gatewayClient) readSSE(resp *http.Response, fn func([]byte)) error {
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return decodeGatewayError(resp)
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		fn([]byte(data))
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stream: %w", err)
	}
	return io.EOF
}

func acceptSSE(_ context.Context, req *http.Request) error {
	req.Header.Set("Accept", "text/event-stream")
	return nil
}

func decodeGatewayError(resp *http.Response) error {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read gateway error: %w", err)
	}
	return gatewayResponseError(resp, body)
}

func gatewayResponseError(resp *http.Response, body []byte) error {
	if resp == nil {
		return fmt.Errorf("gateway returned an empty response")
	}
	var out gatewayapi.Error
	if err := json.Unmarshal(body, &out); err != nil {
		return fmt.Errorf("gateway returned %s", resp.Status)
	}
	if out.Message != "" {
		return fmt.Errorf("%s", out.Message)
	}
	return fmt.Errorf("gateway returned %s", resp.Status)
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
