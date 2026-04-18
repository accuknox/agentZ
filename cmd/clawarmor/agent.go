package main

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/agent"
)

var agentCmd = &cli.Command{
	Name:  "agent",
	Usage: "Run ClawArmor agent",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "config",
			Usage: "Path to ClawArmor agent config YAML",
		},
	},
	Commands: []*cli.Command{agentREPLCmd},
}

var agentREPLCmd = &cli.Command{
	Name:  "repl",
	Usage: "Start interactive agent REPL",
	Action: func(ctx context.Context, c *cli.Command) error {
		return agent.RunREPL(ctx, agent.Options{
			ConfigPath: c.String("config"),
		})
	},
}
