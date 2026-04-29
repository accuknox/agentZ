package api

import (
	"context"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var interruptCmd = &cli.Command{
	Name:  "interrupt",
	Usage: "Interrupt active agent run",
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

		res, err := client.InterruptSessionWithResponse(ctx, gatewayapi.SessionActionRequest{
			SessionId: sessionID,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}
