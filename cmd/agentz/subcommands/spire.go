package subcommands

import (
	"context"
	"os/signal"
	"syscall"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/host"
)

// SpireCmd maintains signing validity for hosts that remain offline for months.
// Run one maintainer beside the singleton SPIRE server, using its admin socket.
var SpireCmd = &cli.Command{
	Name: "spire", Usage: "Maintain SPIRE signing authority for enrolled hosts",
	Commands: []*cli.Command{{
		Name: "maintain", Usage: "Advance the signing authority using SPIRE's built-in API",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "socket", Value: "/run/spire/api.sock", Usage: "Local SPIRE administrator socket"},
			&cli.StringFlag{Name: "trust-domain", Required: true, Usage: "SPIFFE trust domain"},
		},
		Action: func(ctx context.Context, c *cli.Command) error {
			ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
			defer stop()
			identity, err := host.NewIdentityAdmin(c.String("socket"), c.String("trust-domain"))
			if err != nil {
				return err
			}
			defer identity.Close()
			return identity.MaintainAuthority(ctx)
		},
	}},
}
