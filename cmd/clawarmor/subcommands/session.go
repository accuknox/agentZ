package subcommands

import (
	"context"

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
