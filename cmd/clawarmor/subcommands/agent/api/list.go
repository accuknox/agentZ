package api

import (
	"context"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var listCmd = &cli.Command{
	Name:    "list",
	Aliases: []string{"ls"},
	Usage:   "List agents",
	Flags: []cli.Flag{
		&cli.IntFlag{
			Name:  "limit",
			Usage: "Maximum number of agents to return",
			Value: 50,
		},
		&cli.StringFlag{
			Name:   "page-token",
			Usage:  "Pagination token from a previous list response",
			Config: cli.StringConfig{TrimSpace: true},
		},
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

		params := gatewayapi.ListAgentsParams{}
		if c.Int("limit") != 0 {
			limit := gatewayapi.LimitQuery(c.Int("limit"))
			params.Limit = &limit
		}

		if c.String("page-token") != "" {
			//nolint:unconvert
			pageToken := gatewayapi.PageTokenQuery(c.String("page-token"))
			params.PageToken = &pageToken
		}

		rawSessionIDs := c.StringSlice("session-id")
		if len(rawSessionIDs) > 0 {
			sessionIDs := make(gatewayapi.SessionIDFilterQuery, 0, len(rawSessionIDs))
			for _, raw := range rawSessionIDs {
				id, err := uuid.Parse(raw)
				if err != nil {
					return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
				}
				sessionIDs = append(sessionIDs, id)
			}
			params.SessionId = &sessionIDs
		}

		res, err := client.ListAgentsWithResponse(ctx, &params)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}
