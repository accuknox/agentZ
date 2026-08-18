package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/extauth"
)

// ExtAuthCmd runs the MCP ext-auth gRPC service.
var ExtAuthCmd = &cli.Command{
	Name:  "extauth",
	Usage: "MCP external authorization service",
	Commands: []*cli.Command{
		extAuthServeCmd,
	},
}

var extAuthServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the MCP ext-auth gRPC service",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: extauth.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "namespace",
			Usage: "Kubernetes namespace that owns MCP resources",
			Value: extauth.DefaultNamespace,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringSliceFlag{
			Name:  "source-namespace",
			Usage: "Workspace namespace allowed to originate requests; repeat for multiple namespaces",
		},
		&cli.StringFlag{
			Name:     "openbao-addr",
			Usage:    "OpenBao server address (e.g. http://openbao:8200)",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "openbao-secret-mount-path",
			Usage:    "OpenBao KV v2 secret engine mount path",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "openbao-k8s-auth-role",
			Usage:    "OpenBao Kubernetes auth role name",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "openbao-k8s-auth-mount-path",
			Usage: "OpenBao Kubernetes auth mount path",
			Value: "kubernetes",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "openbao-k8s-auth-token-path",
			Usage: "Path to Kubernetes service account JWT for OpenBao auth. Defaults to in-pod path.",
			Value: "/var/run/secrets/kubernetes.io/serviceaccount/token",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.DurationFlag{
			Name:  "mcp-probe-interval",
			Usage: "Interval between MCP health probe cycles",
			Value: extauth.DefaultMCPProbeInterval,
		},
		&cli.DurationFlag{
			Name:  "mcp-probe-timeout",
			Usage: "Timeout for one MCP health probe",
			Value: extauth.DefaultMCPProbeTimeout,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return extauth.Serve(
			ctx,
			extauth.Config{
				Addr:                    c.String("addr"),
				Namespace:               c.String("namespace"),
				SourceNamespaces:        c.StringSlice("source-namespace"),
				OpenBaoAddr:             c.String("openbao-addr"),
				OpenBaoSecretMountPath:  c.String("openbao-secret-mount-path"),
				OpenBaoK8sAuthRole:      c.String("openbao-k8s-auth-role"),
				OpenBaoK8sAuthMountPath: c.String("openbao-k8s-auth-mount-path"),
				OpenBaoK8sAuthTokenPath: c.String("openbao-k8s-auth-token-path"),
				MCPProbeInterval:        c.Duration("mcp-probe-interval"),
				MCPProbeTimeout:         c.Duration("mcp-probe-timeout"),
			},
		)
	},
}
