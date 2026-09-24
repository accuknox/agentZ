package subcommands

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/accuknox/agentz/internal/daemon"
	"github.com/urfave/cli/v3"
)

// DaemonCmd manages the native compute daemon.
var DaemonCmd = &cli.Command{
	Name:  "daemon",
	Usage: "Manage a native AgentZ compute host",
	Commands: []*cli.Command{
		{
			Name:  "unenroll",
			Usage: "Stop AgentZ services and remove local enrollment, preserving work files",
			Action: func(ctx context.Context, _ *cli.Command) error {
				return daemon.Unenroll(ctx, os.Stdout)
			},
		},
		{
			Name:  "status",
			Usage: "Show enrollment, service, connection and runtime readiness",
			Flags: []cli.Flag{
				&cli.StringFlag{
					Name:  "config",
					Value: "/etc/agentz/daemon.json",
				},
			},
			Action: func(ctx context.Context, c *cli.Command) error {
				return daemon.Diagnose(ctx, c.String("config"), false, os.Stdout)
			},
		},
		{
			Name:  "doctor",
			Usage: "Check native host prerequisites and readiness without changing the host",
			Flags: []cli.Flag{
				&cli.StringFlag{
					Name:  "config",
					Value: "/etc/agentz/daemon.json",
				},
			},
			Action: func(ctx context.Context, c *cli.Command) error {
				return daemon.Diagnose(ctx, c.String("config"), true, os.Stdout)
			},
		},
		{
			Name:  "enroll",
			Usage: "Connect this Linux host to an Agent",
			Flags: []cli.Flag{
				&cli.StringFlag{Name: "backend", Required: true},
				&cli.StringFlag{Name: "user", Required: true},
				&cli.StringFlag{Name: "workdir"},
				&cli.StringFlag{Name: "config-home"},
				&cli.StringFlag{Name: "data-home"},
				&cli.StringFlag{Name: "state-home"},
				&cli.StringFlag{Name: "cache-home"},
				&cli.StringFlag{Name: "runtime", Value: "/var/lib/agentz/runtime/opencode"},
			},
			Action: func(ctx context.Context, c *cli.Command) error {
				return daemon.Enroll(
					ctx,
					c.String("backend"), c.String("user"), c.String("workdir"),
					c.String("runtime"), c.String("config-home"), c.String("data-home"),
					c.String("state-home"), c.String("cache-home"),
					os.Stdin, os.Stdout,
				)
			},
		},
		{
			Name:  "run",
			Usage: "Run the enrolled native compute supervisor",
			Flags: []cli.Flag{
				&cli.StringFlag{
					Name: "config", Value: "/etc/agentz/daemon.json",
					Usage: "Root-owned enrollment configuration",
				},
			},
			Action: func(ctx context.Context, c *cli.Command) error {
				path := c.String("config")
				file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
				if err != nil {
					return err
				}
				defer file.Close()
				info, err := file.Stat()
				if err != nil {
					return err
				}
				owner, ok := info.Sys().(*syscall.Stat_t)
				if !ok || owner.Uid != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
					return fmt.Errorf("daemon configuration must be a regular root-owned file readable only by root")
				}
				data, err := io.ReadAll(io.LimitReader(file, 65537))
				if len(data) > 65536 {
					return fmt.Errorf("daemon configuration exceeds 64 KiB")
				}
				if err != nil {
					return err
				}
				var config daemon.Config
				if err := json.Unmarshal(data, &config); err != nil {
					return err
				}
				return daemon.Run(ctx, config)
			},
		},
	},
}
