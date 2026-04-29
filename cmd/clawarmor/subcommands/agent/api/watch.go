package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var watchCmd = &cli.Command{
	Name:  "watch",
	Usage: "Watch agents",
	Flags: []cli.Flag{
		&cli.StringSliceFlag{
			Name:   "session-id",
			Usage:  "Session UUID filter; may be repeated",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		client, err := newClient(c)
		if err != nil {
			return err
		}

		req := gatewayapi.WatchAgentsRequest{}
		rawSessionIDs := c.StringSlice("session-id")
		if len(rawSessionIDs) > 0 {
			sessionIDs := make([]gatewayapi.SessionIDInput, 0, len(rawSessionIDs))
			for _, raw := range rawSessionIDs {
				if _, err := uuid.Parse(raw); err != nil {
					return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
				}
				sessionIDs = append(sessionIDs, raw)
			}
			req.SessionIds = &sessionIDs
		}

		res, err := client.WatchAgents(ctx, req, acceptSSE)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeSSEData(c, res)
	},
}

func acceptSSE(_ context.Context, req *http.Request) error {
	req.Header.Set("Accept", "text/event-stream")
	return nil
}

func writeSSEData(c *cli.Command, res *http.Response) error {
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, err := io.ReadAll(res.Body)
		if err != nil {
			return err
		}
		return writeGatewayBody(c, body, false)
	}

	scanner := bufio.NewScanner(res.Body)
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
		if err := writeRawJSON(writer(c), []byte(data)); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stream: %w", err)
	}
	return nil
}
