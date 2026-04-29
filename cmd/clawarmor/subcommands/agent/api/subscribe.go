package api

import (
	"context"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var subscribeCmd = &cli.Command{
	Name:  "subscribe",
	Usage: "Subscribe to agent session events",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredArg(c, "session-id")
		if err != nil {
			return err
		}
		if _, err := uuid.Parse(sessionID); err != nil {
			return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		res, err := client.SubscribeSession(
			ctx,
			gatewayapi.SessionActionRequest{
				SessionId: sessionID,
			},
			acceptSSE,
		)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeSSEData(c, res)
	},
}
