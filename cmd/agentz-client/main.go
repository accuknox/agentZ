package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/launcher"
)

var version = "dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer cancel()

	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)

	command := &cli.Command{
		Name:    "agentz",
		Version: version,
		Usage:   "Launch coding agents through AgentZ",
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:      "config",
				Usage:     "AgentZ configuration file",
				TakesFile: true,
			},
			&cli.StringFlag{
				Name:   "profile",
				Usage:  "AgentZ profile to use",
				Config: cli.StringConfig{TrimSpace: true},
			},
		},
		Commands: []*cli.Command{
			{
				Name:            "launch",
				Usage:           "Connect CLI and desktop agents through AgentZ",
				ArgsUsage:       "[claude|codex|copilot|chatgpt-desktop|claude-desktop|github-copilot-desktop] [--profile NAME] [-- native flags]",
				SkipFlagParsing: true,
				Action:          launcher.Run,
			},
			{
				Name:            "login",
				Usage:           "Sign in to external agents through AgentZ",
				ArgsUsage:       "[codex|copilot|chatgpt-desktop|claude-desktop|github-copilot-desktop] [--profile NAME] [--mcp]",
				SkipFlagParsing: true,
				Action:          launcher.Run,
			},
			{
				Name:  "relay",
				Usage: "Manage the local AgentZ relay",
				Commands: []*cli.Command{
					{Name: "serve", Hidden: true, Action: launcher.Run},
					{Name: "headers", Hidden: true, Flags: []cli.Flag{&cli.StringFlag{Name: "profile-directory", Required: true}}, Action: launcher.Run},
					{Name: "status", Action: launcher.Run},
					{Name: "stop", Action: launcher.Run},
				},
			},
		},
	}
	if err := command.Run(ctx, os.Args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code := 1
		if exit, ok := errors.AsType[cli.ExitCoder](err); ok {
			code = exit.ExitCode()
		}
		os.Exit(code)
	}
}
