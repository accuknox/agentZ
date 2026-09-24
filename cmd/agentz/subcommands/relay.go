package subcommands

import (
	"context"
	"os"

	"github.com/accuknox/agentz/internal/relay"
	"github.com/accuknox/agentz/internal/skill"

	"github.com/urfave/cli/v3"
)

// RelayCmd runs the host connection service independently of the HTTP gateway.
var RelayCmd = &cli.Command{
	Name: "relay", Usage: "Host relay service",
	Commands: []*cli.Command{{
		Name:  "serve",
		Usage: "Serve authenticated host tunnels and gateway forwarding",
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:  "addr",
				Value: "0.0.0.0:9443",
				Usage: "Host gRPC listen address",
			},
			&cli.StringFlag{
				Name:  "control-addr",
				Value: "0.0.0.0:9444",
				Usage: "Internal gateway gRPC listen address",
			},
			&cli.StringFlag{
				Name:  "health-addr",
				Value: "0.0.0.0:8082",
				Usage: "Health and readiness HTTP listen address",
			},
			&cli.StringFlag{
				Name:     "public-address",
				Required: true,
				Usage:    "Public host relay address",
			},
			&cli.StringFlag{
				Name:     "spire-address",
				Required: true,
				Usage:    "SPIRE server's internal TCP address",
			},
			&cli.StringFlag{
				Name:     "spire-public-address",
				Required: true,
				Usage:    "SPIRE server address reachable by enrolled hosts",
			},
			&cli.StringFlag{
				Name:     "trust-domain",
				Required: true,
				Usage:    "SPIFFE trust domain",
			},
			&cli.StringFlag{
				Name:     "identity-cert",
				Required: true,
				Usage:    "SPIRE administrator client certificate",
			},
			&cli.StringFlag{
				Name:     "identity-key",
				Required: true,
				Usage:    "SPIRE administrator private key",
			},
			&cli.StringFlag{
				Name:     "trust-bundle",
				Required: true,
				Usage:    "SPIFFE PEM trust bundle",
			},
			&cli.StringFlag{
				Name:     "gateway-url",
				Required: true,
				Usage:    "Internal HTTP gateway URL",
			},
			&cli.StringFlag{
				Name:  "internal-k8s-token-audience",
				Value: "agentz-gateway",
				Usage: "Audience of platform service-account tokens",
			},
			&cli.StringFlag{
				Name:  "proxy-ca-secret-name",
				Value: "sinjector",
				Usage: "Tenant secret proxy CA Secret name",
			},
			&cli.StringFlag{
				Name:  "proxy-ca-secret-key",
				Value: "ca.crt",
				Usage: "Tenant secret proxy CA certificate key",
			},
			&cli.StringFlag{
				Name:     "agent-trace-endpoint",
				Required: true,
				Usage:    "Observer OTLP/gRPC address",
			},
			&cli.StringFlag{
				Name:     "postgres-dsn",
				Required: true,
				Sources:  cli.EnvVars("AGENTZ_POSTGRES_DSN"),
				Usage:    "PostgreSQL connection for host registrations",
			},
			&cli.StringFlag{
				Name:     "skills-s3-endpoint",
				Required: true,
				Usage:    "Immutable skills object store endpoint",
			},
			&cli.StringFlag{
				Name:  "skills-s3-region",
				Value: "us-east-1",
				Usage: "Immutable skills object store region",
			},
			&cli.StringFlag{
				Name:     "skills-s3-bucket",
				Required: true,
				Usage:    "Immutable skills object store bucket",
			},
		},
		Action: func(ctx context.Context, c *cli.Command) error {
			return relay.Serve(ctx, relay.Config{
				Addr:                     c.String("addr"),
				ControlAddr:              c.String("control-addr"),
				HealthAddr:               c.String("health-addr"),
				PublicAddress:            c.String("public-address"),
				SPIREAddress:             c.String("spire-address"),
				SPIREPublicAddress:       c.String("spire-public-address"),
				TrustDomain:              c.String("trust-domain"),
				IdentityCert:             c.String("identity-cert"),
				IdentityKey:              c.String("identity-key"),
				TrustBundle:              c.String("trust-bundle"),
				GatewayURL:               c.String("gateway-url"),
				InternalK8sTokenAudience: c.String("internal-k8s-token-audience"),
				AgentTraceEndpoint:       c.String("agent-trace-endpoint"),
				ProxyCASecretName:        c.String("proxy-ca-secret-name"),
				ProxyCASecretKey:         c.String("proxy-ca-secret-key"),
				PostgresDSN:              c.String("postgres-dsn"),
				SkillStore: skill.Config{
					Endpoint:        c.String("skills-s3-endpoint"),
					Region:          c.String("skills-s3-region"),
					Bucket:          c.String("skills-s3-bucket"),
					AccessKeyID:     os.Getenv("AGENTZ_SKILLS_S3_ACCESS_KEY_ID"),
					SecretAccessKey: os.Getenv("AGENTZ_SKILLS_S3_SECRET_ACCESS_KEY"),
				},
			})
		},
	}},
}
