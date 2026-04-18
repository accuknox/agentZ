package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/cmd/clawarmor/util"
)

func main() {
	ctx := context.Background()
	err := cmd.Run(ctx, os.Args)
	if err != nil {
		slog.ErrorContext(ctx, err.Error())
		os.Exit(1)
	}
}

var cmd = &cli.Command{
	Name:                  "clawarmor",
	Usage:                 "The AI that actually does things - SECURELY.",
	EnableShellCompletion: true,
	Authors:               []any{"Murtaza U <murtaza@accuknox.com>"},
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "log-level",
			Usage: "Set log level: debug, info, warn, error",
			Value: "info",
		},
		&cli.StringFlag{
			Name:  "log-format",
			Usage: "Set log format: text, json",
			Value: "text",
		},
		&cli.BoolFlag{
			Name:  "log-with-source",
			Usage: "Include source file and line number in log messages",
			Value: false,
		},
	},
	Commands: []*cli.Command{agentCmd, sessionCmd},
	Before: func(ctx context.Context, c *cli.Command) (context.Context, error) {
		level := c.String("log-level")
		if level != "debug" && level != "info" && level != "warn" && level != "error" {
			return ctx, fmt.Errorf("invalid log level %q", level)
		}
		format := c.String("log-format")
		if format != "text" && format != "json" && format != "pretty" {
			return ctx, fmt.Errorf("invalid log format %q", format)
		}
		withSource := c.Bool("log-with-source")
		slog.SetDefault(util.NewLogger(level, format, withSource))
		return ctx, nil
	},
}
