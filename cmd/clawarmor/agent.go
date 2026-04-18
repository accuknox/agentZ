package main

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/agent"
	sessionstore "github.com/accuknox/clawarmor/internal/session"
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

var sessionCmd = &cli.Command{
	Name:     "session",
	Usage:    "Run session-service commands",
	Commands: []*cli.Command{sessionServeCmd},
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

var sessionServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the PostgreSQL-backed session gRPC server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: sessionstore.DefaultListenAddr,
		},
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN",
			Required: true,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return sessionstore.Serve(ctx, sessionstore.Config{
			Addr:        c.String("addr"),
			PostgresDSN: c.String("postgres-dsn"),
		})
	},
}
