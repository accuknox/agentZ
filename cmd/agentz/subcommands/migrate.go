package subcommands

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	"github.com/urfave/cli/v3"
)

// MigrateCmd applies Go-owned migrations after the web schema is ready.
var MigrateCmd = &cli.Command{
	Name:  "migrate",
	Usage: "Apply pending gateway, observer, workflow, and dashboard migrations",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL migration connection",
			Required: true,
			Sources:  cli.EnvVars("AGENTZ_POSTGRES_DSN"),
		},
		&cli.StringFlag{
			Name:  "dir",
			Usage: "Root containing the internal migration directories",
			Value: ".",
		},
		&cli.DurationFlag{
			Name:  "timeout",
			Usage: "Deadline for the complete Go migration phase",
			Value: 90 * time.Second,
		},
	},
	Action: func(ctx context.Context, cmd *cli.Command) error {
		if cmd.Args().Len() != 0 {
			return errors.New("migrate does not accept positional arguments")
		}

		timeout := cmd.Duration("timeout")
		if timeout < time.Second {
			return errors.New("timeout must be at least one second")
		}

		ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
		defer stop()

		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		cfg, err := pgx.ParseConfig(cmd.String("postgres-dsn"))
		if err != nil {
			// parse errors can include the DSN and its password.
			return errors.New("invalid PostgreSQL migration DSN")
		}
		cfg.ConnectTimeout = 10 * time.Second
		cfg.RuntimeParams["application_name"] = "agentz-migrate"
		cfg.RuntimeParams["lock_timeout"] = "30000"
		cfg.RuntimeParams["statement_timeout"] = strconv.FormatInt(timeout.Milliseconds(), 10)

		db := stdlib.OpenDB(*cfg)
		defer db.Close()

		db.SetMaxOpenConns(1)

		if err := db.PingContext(ctx); err != nil {
			return fmt.Errorf("connect to migration database: %w", err)
		}

		owners := []string{
			"gateway", "observer", "gateway/workflow", "gateway/dashboard",
		}
		for _, owner := range owners {
			// give each stream its own lock retry budget.
			locker, err := lock.NewPostgresSessionLocker(
				lock.WithLockTimeout(1, 30),
				lock.WithUnlockTimeout(1, 5),
			)
			if err != nil {
				return fmt.Errorf("create migration locker: %w", err)
			}

			name := filepath.Base(owner)
			dir := filepath.Join(cmd.String("dir"), "internal", owner, "db", "migrations")
			provider, err := goose.NewProvider(goose.DialectPostgres, db, os.DirFS(dir),
				goose.WithTableName("goose_"+name+"_version"),
				goose.WithSessionLocker(locker),
				goose.WithDisableGlobalRegistry(true),
			)
			if err != nil {
				return fmt.Errorf("load %s migrations: %w", name, err)
			}

			start := time.Now()
			slog.InfoContext(ctx, "Applying migrations", "owner", name)

			results, err := provider.Up(ctx)
			if err != nil {
				return fmt.Errorf("apply %s migrations: %w", name, err)
			}
			slog.InfoContext(
				ctx,
				"Migrations complete",
				"owner", name,
				"applied", len(results),
				"duration", time.Since(start),
			)
		}
		return nil
	},
}
