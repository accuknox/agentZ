package api

import (
	"context"

	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var deleteCmd = &cli.Command{
	Name:  "delete",
	Usage: "Delete agent",
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

		client, err := newClient(c)
		if err != nil {
			return err
		}

		req := gatewayapi.DeleteAgentRequest{
			SessionId: sessionID,
		}
		res, err := client.DeleteAgentWithResponse(ctx, req)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.StatusCode() == 204)
	},
}
