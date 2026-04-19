package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/agent"
)

var AgentCmd = &cli.Command{
	Name:     "agent",
	Usage:    "ClawArmor agent",
	Commands: []*cli.Command{agentREPLCmd, agentServeCmd},
}

var agentREPLCmd = &cli.Command{
	Name:  "repl",
	Usage: "Start interactive agent REPL",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "target",
			Usage: "gRPC target for the agent service",
			Value: agent.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return agent.RunREPL(ctx, agent.REPLOptions{
			Target: c.String("target"),
		})
	},
}

var agentServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the agent gRPC server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "config",
			Usage: "Path to ClawArmor agent config YAML",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return agent.Serve(ctx, agent.ServiceConfig{
			ConfigPath: c.String("config"),
		})
	},
}
