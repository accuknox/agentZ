package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

var chatHistoryCmd = &cli.Command{
	Name:  "chat-history",
	Usage: "Get agent chat history",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Flags: []cli.Flag{
		&cli.IntFlag{
			Name:  "limit",
			Usage: "Maximum number of events to return",
			Value: 50,
		},
		&cli.StringFlag{
			Name:   "page-token",
			Usage:  "Pagination token from a previous chat-history response",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		sessionID, err := requiredArg(c, "session-id")
		if err != nil {
			return err
		}
		id, err := uuid.Parse(sessionID)
		if err != nil {
			return writeAPIExit(c, "invalid_argument", "session-id must be a UUID")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		params := gatewayapi.GetChatHistoryParams{
			SessionId: id,
		}
		if c.Int("limit") != 0 {
			limit := gatewayapi.LimitQuery(c.Int("limit"))
			params.Limit = &limit
		}
		if c.String("page-token") != "" {
			pageToken := gatewayapi.PageTokenQuery(c.String("page-token"))
			params.PageToken = &pageToken
		}

		res, err := client.GetChatHistoryWithResponse(ctx, &params)
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}

var sendMessageCmd = &cli.Command{
	Name:  "send-message",
	Usage: "Send message to agent",
	Arguments: []cli.Argument{
		&cli.StringArg{
			Name:   "session-id",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringArg{
			Name:   "prompt",
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

		prompt, err := requiredArg(c, "prompt")
		if err != nil {
			return err
		}
		if strings.TrimSpace(prompt) == "" {
			return writeAPIExit(c, "invalid_argument", "prompt is required")
		}

		client, err := newClient(c)
		if err != nil {
			return err
		}

		res, err := client.SendMessageWithResponse(ctx, gatewayapi.SendMessageRequest{
			SessionId: sessionID,
			Prompt:    prompt,
		})
		if err != nil {
			return writeAPIExit(c, "gateway_request_failed", err.Error())
		}

		return writeGatewayBody(c, res.Body, res.JSON200 != nil)
	},
}
