package api

import (
	"context"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var compactCmd = &cli.Command{
	Name:  "compact",
	Usage: "Compact agent session history",
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

		res, err := client.CompactSessionWithResponse(ctx, gatewayapi.SessionActionRequest{
			SessionId: sessionID,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}
