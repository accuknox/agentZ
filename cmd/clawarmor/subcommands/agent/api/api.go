package api

import (
	"context"
	"net/url"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/agent/gateway"
)

// Cmd defines agent gateway API client commands.
var Cmd = &cli.Command{
	Name:  "api",
	Usage: "Interact with the agent gateway API",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:   "base-url",
			Usage:  "Gateway API base URL",
			Config: cli.StringConfig{TrimSpace: true},
		},
	},
	Commands: []*cli.Command{
		createCmd,
		deleteCmd,
		listCmd,
		watchCmd,
		chatHistoryCmd,
		sendMessageCmd,
		interruptCmd,
		compactCmd,
		subscribeCmd,
	},
	Before: func(ctx context.Context, c *cli.Command) (context.Context, error) {
		baseURL := strings.TrimRight(strings.TrimSpace(c.String("base-url")), "/")
		if baseURL == "" {
			baseURL = gateway.DefaultBaseURL
		}
		if !strings.Contains(baseURL, "://") {
			baseURL = "http://" + baseURL
		}
		if _, err := url.ParseRequestURI(baseURL); err != nil {
			return ctx, writeAPIExit(c, "invalid_base_url", err.Error())
		}
		if err := c.Set("base-url", baseURL); err != nil {
			return ctx, writeAPIExit(c, "invalid_base_url", err.Error())
		}
		return ctx, nil
	},
}
