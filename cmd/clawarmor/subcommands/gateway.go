package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/clawarmor/internal/gateway"
)

var GatewayCmd = &cli.Command{
	Name:     "gateway",
	Usage:    "ClawArmor gateway",
	Commands: []*cli.Command{gatewayServeCmd},
}

var gatewayServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the gateway HTTP server",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: gateway.DefaultListenAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "namespace",
			Usage: "Kubernetes namespace to resolve Agents from",
			Value: gateway.DefaultNamespace,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN for session history and agent listing",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "external-jwt-jwks-url",
			Usage:    "JWKS URL for external Better Auth bearer tokens",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "external-jwt-issuer",
			Usage:    "JWT issuer for external Better Auth bearer tokens",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "external-jwt-audience",
			Usage:    "JWT audience for external Better Auth bearer tokens",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "internal-k8s-token-audience",
			Usage:    "Audience required on internal Kubernetes service account bearer tokens",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "target-override",
			Usage: "Override resolved backend target for local port-forward testing",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "agent-image",
			Usage: "Container image for gateway-created Agents",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "agent-trace-endpoint",
			Usage:    "OTLP/gRPC trace endpoint for gateway-created Agents",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
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
			Name:  "mcp-probe-stale-after",
			Usage: "Maximum age of MCP probe results before they are treated as pending",
			Value: gateway.DefaultMCPProbeStaleAfter,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return gateway.Serve(ctx, gateway.Config{
			Addr:                     c.String("addr"),
			Namespace:                c.String("namespace"),
			PostgresDSN:              c.String("postgres-dsn"),
			ExternalJWTJWKSURL:       c.String("external-jwt-jwks-url"),
			ExternalJWTIssuer:        c.String("external-jwt-issuer"),
			ExternalJWTAudience:      c.String("external-jwt-audience"),
			InternalK8sTokenAudience: c.String("internal-k8s-token-audience"),
			TargetOverride:           c.String("target-override"),
			AgentImage:               c.String("agent-image"),
			AgentTraceEndpoint:       c.String("agent-trace-endpoint"),
			OpenBaoAddr:              c.String("openbao-addr"),
			OpenBaoSecretMountPath:   c.String("openbao-secret-mount-path"),
			OpenBaoK8sAuthRole:       c.String("openbao-k8s-auth-role"),
			OpenBaoK8sAuthMountPath:  c.String("openbao-k8s-auth-mount-path"),
			OpenBaoK8sAuthTokenPath:  c.String("openbao-k8s-auth-token-path"),
			MCPProbeStaleAfter:       c.Duration("mcp-probe-stale-after"),
		})
	},
}
