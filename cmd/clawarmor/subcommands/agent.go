package subcommands

import (
	"context"
	"time"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/agent"
	"github.com/accuknox/clawarmor/internal/agent/gateway"
	"github.com/accuknox/clawarmor/internal/agent/repl"
)

var AgentCmd = &cli.Command{
	Name:     "agent",
	Usage:    "ClawArmor agent",
	Commands: []*cli.Command{agentREPLCmd, agentServeCmd, agentGatewayCmd},
}

var agentREPLCmd = &cli.Command{
	Name:  "repl",
	Usage: "Start interactive agent REPL",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "target",
			Usage: "HTTP base URL for the agent gateway service",
			Value: gateway.DefaultBaseURL,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "session-id",
			Usage:    "Session id routed through the gateway",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.IntFlag{
			Name:  "history-limit",
			Usage: "Number of recent chat history events to print on startup",
			Value: 25,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return repl.Run(ctx, repl.Options{
			Target:       c.String("target"),
			SessionID:    c.String("session-id"),
			HistoryLimit: c.Int("history-limit"),
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

var agentGatewayCmd = &cli.Command{
	Name:  "gateway",
	Usage: "Run the agent gateway HTTP server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: gateway.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "namespace",
			Usage: "Kubernetes namespace to resolve Agents from",
			Value: gateway.DefaultNamespace,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "valkey-addr",
			Usage: "Valkey address for durable streams",
			Value: gateway.DefaultValkeyAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN for session history and agent listing",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "target-override",
			Usage: "Override resolved backend target for local port-forward testing",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.DurationFlag{
			Name:  "graceful-shutdown-timeout",
			Usage: "Maximum graceful shutdown period. Use 0 for no timeout.",
			Value: 15 * time.Second,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return gateway.Serve(ctx, gateway.Config{
			Addr:                    c.String("addr"),
			Namespace:               c.String("namespace"),
			ValkeyAddr:              c.String("valkey-addr"),
			PostgresDSN:             c.String("postgres-dsn"),
			GracefulShutdownTimeout: c.Duration("graceful-shutdown-timeout"),
			TargetOverride:          c.String("target-override"),
		})
	},
}
