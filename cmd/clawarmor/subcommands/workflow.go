package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/workflow"
)

var WorkflowCmd = &cli.Command{
	Name:     "workflow",
	Usage:    "Workflow definition service",
	Commands: []*cli.Command{workflowServeCmd},
}

var workflowServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the workflow HTTP server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: workflow.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN for workflow storage",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return workflow.Serve(ctx, workflow.Config{
			Addr:        c.String("addr"),
			PostgresDSN: c.String("postgres-dsn"),
		})
	},
}
