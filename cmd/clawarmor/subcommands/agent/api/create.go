package api

import (
	"context"

	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var createCmd = &cli.Command{
	Name:  "create",
	Usage: "Create new agent",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "name",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:   "primary-model",
			Usage:  "Primary model name",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.IntFlag{
			Name:  "primary-context-window",
			Usage: "Primary model context window",
		},
		&cli.StringFlag{
			Name:   "summary-model",
			Usage:  "Summary model name",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.IntFlag{
			Name:  "summary-context-window",
			Usage: "Summary model context window",
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		name, err := requiredArg(c, "name")
		if err != nil {
			return err
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		res, err := client.CreateAgentWithResponse(ctx, gatewayapi.CreateAgentRequest{
			Name: name,
			Model: gatewayapi.CreateAgentModel{
				Primary: gatewayapi.CreateAgentModelConfig{
					Name:          c.String("primary-model"),
					ContextWindow: int32(c.Int("primary-context-window")),
				},
				Summary: &gatewayapi.CreateAgentModelConfig{
					Name:          c.String("summary-model"),
					ContextWindow: int32(c.Int("summary-context-window")),
				},
			},
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON201 != nil)
	},
}
