package subcommands

import (
	"context"
	"time"

	"github.com/urfave/cli/v3"

	sessionstore "github.com/accuknox/clawarmor/internal/session"
)

var SessionCmd = &cli.Command{
	Name:     "session",
	Usage:    "Session service",
	Commands: []*cli.Command{sessionServeCmd},
}

var sessionServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the PostgreSQL-backed session gRPC server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: sessionstore.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN",
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
		return sessionstore.Serve(ctx, sessionstore.Config{
			Addr:                    c.String("addr"),
			PostgresDSN:             c.String("postgres-dsn"),
			GracefulShutdownTimeout: c.Duration("graceful-shutdown-timeout"),
		})
	},
}
