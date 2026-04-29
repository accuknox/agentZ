package agentcmd

import (
	"context"
	"time"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/cmd/clawarmor/subcommands/agent/api"
	"github.com/accuknox/clawarmor/internal/agent"
	"github.com/accuknox/clawarmor/internal/agent/gateway"
)

// AgentCmd groups commands for running and managing ClawArmor agents.
var AgentCmd = &cli.Command{
	Name:  "agent",
	Usage: "ClawArmor agent",
	Commands: []*cli.Command{
		agentServeCmd,
		agentGatewayCmd,
		api.Cmd,
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
		&cli.StringFlag{
			Name:  "agent-image",
			Usage: "Container image for gateway-created Agents",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "agent-server-address",
			Usage: "gRPC listen address for gateway-created Agents",
			Value: gateway.DefaultAgentServerAddress,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "agent-session-target",
			Usage:    "Session service gRPC target for gateway-created Agents",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "agent-trace-endpoint",
			Usage:    "OTLP/gRPC trace endpoint for gateway-created Agents",
			Required: true,
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
			AgentImage:              c.String("agent-image"),
			AgentServerAddress:      c.String("agent-server-address"),
			AgentSessionTarget:      c.String("agent-session-target"),
			AgentTraceEndpoint:      c.String("agent-trace-endpoint"),
		})
	},
}
