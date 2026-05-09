package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/sinjector"
)

// SinjectorCmd runs the secret injection proxy.
var SinjectorCmd = &cli.Command{
	Name:  "sinjector",
	Usage: "Secret injection proxy",
	Commands: []*cli.Command{
		sinjectorServeCmd,
	},
}

var sinjectorServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the secret injection proxy",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: sinjector.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "openbao-addr",
			Usage:    "OpenBao server address",
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
			Usage: "Path to Kubernetes service account JWT for OpenBao auth",
			Value: "/var/run/secrets/kubernetes.io/serviceaccount/token",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "agent-name",
			Usage:    "Agent name",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "ca-cert-path",
			Usage:    "MITM CA certificate path",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "ca-key-path",
			Usage:    "MITM CA private key path",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.BoolFlag{
			Name:  "verbose",
			Usage: "Enable verbose proxy logging",
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return sinjector.Serve(ctx, sinjector.Config{
			Addr:                    c.String("addr"),
			OpenBaoAddr:             c.String("openbao-addr"),
			OpenBaoSecretMountPath:  c.String("openbao-secret-mount-path"),
			OpenBaoK8sAuthRole:      c.String("openbao-k8s-auth-role"),
			OpenBaoK8sAuthMountPath: c.String("openbao-k8s-auth-mount-path"),
			OpenBaoK8sAuthTokenPath: c.String("openbao-k8s-auth-token-path"),
			AgentName:               c.String("agent-name"),
			CACertPath:              c.String("ca-cert-path"),
			CAKeyPath:               c.String("ca-key-path"),
			Verbose:                 c.Bool("verbose"),
		})
	},
}
