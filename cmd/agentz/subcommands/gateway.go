package subcommands

import (
	"context"
	"os"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/gateway"
	"github.com/accuknox/agentz/internal/skill"
)

// GatewayCmd runs the HTTP API gateway.
var GatewayCmd = &cli.Command{
	Name:     "gateway",
	Usage:    "AgentZ gateway",
	Commands: []*cli.Command{gatewayServeCmd},
}

var gatewayServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the gateway HTTP server",
	Flags: []cli.Flag{
		&cli.StringFlag{Name: "compute-addr", Value: "", Usage: "Native compute gRPC listen address; empty disables compute"},
		&cli.StringFlag{Name: "compute-spire-socket", Value: "/run/spire/api.sock", Usage: "SPIRE local administrative Unix socket"},
		&cli.StringFlag{Name: "compute-trust-domain", Value: "agentz.local", Usage: "SPIFFE trust domain"},
		&cli.StringFlag{Name: "compute-public-address", Value: "", Usage: "Public native compute gRPC address"},
		&cli.StringFlag{Name: "compute-spire-public-address", Value: "", Usage: "Public SPIRE address"},
		&cli.StringFlag{Name: "compute-ca-secret-name", Value: "sinjector", Usage: "Tenant proxy CA Secret name"},
		&cli.StringFlag{Name: "compute-ca-secret-key", Value: "ca.crt", Usage: "Proxy CA bundle key"},

		&cli.StringFlag{
			Name:    "coding-github-client-id",
			Usage:   "Coding GitHub App client ID shared with the web app",
			Sources: cli.EnvVars("CODING_GITHUB_CLIENT_ID"),
		},
		&cli.StringFlag{
			Name:    "coding-github-client-secret",
			Usage:   "Coding GitHub App client secret shared with the web app",
			Sources: cli.EnvVars("CODING_GITHUB_CLIENT_SECRET"),
		},
		&cli.StringFlag{
			Name:    "coding-github-encryption-key",
			Usage:   "64-character hex token encryption key shared with the web app",
			Sources: cli.EnvVars("CODING_GITHUB_ENCRYPTION_KEY"),
		},
		&cli.StringFlag{
			Name:  "addr",
			Usage: "Listen address",
			Value: gateway.DefaultListenAddr,
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
			Name:  "filesystem-target-override",
			Usage: "Override the filesystem target for local port-forward testing",
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
		&cli.StringSliceFlag{
			Name:     "allowed-web-origin",
			Usage:    "Web origin allowed to call the gateway; repeat for multiple origins",
			Required: true,
		},
		&cli.StringFlag{
			Name:     "skills-s3-endpoint",
			Usage:    "S3-compatible endpoint for immutable skill storage",
			Required: true,
			Config:   cli.StringConfig{TrimSpace: true},
		},
		&cli.StringFlag{
			Name:   "skills-s3-region",
			Usage:  "S3 region for immutable skill storage",
			Value:  "us-east-1",
			Config: cli.StringConfig{TrimSpace: true},
		},
		&cli.StringFlag{
			Name:     "skills-s3-bucket",
			Usage:    "S3 bucket for immutable skill storage",
			Required: true,
			Config:   cli.StringConfig{TrimSpace: true},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return gateway.Serve(
			ctx,
			gateway.Config{
				ComputeAddr:               c.String("compute-addr"),
				ComputeSPIRESocket:        c.String("compute-spire-socket"),
				ComputeTrustDomain:        c.String("compute-trust-domain"),
				ComputePublicAddress:      c.String("compute-public-address"),
				ComputeSPIREPublicAddress: c.String("compute-spire-public-address"),
				ComputeCASecretName:       c.String("compute-ca-secret-name"),
				ComputeCASecretKey:        c.String("compute-ca-secret-key"),

				Addr:                      c.String("addr"),
				CodingGitHubClientID:      c.String("coding-github-client-id"),
				CodingGitHubClientSecret:  c.String("coding-github-client-secret"),
				CodingGitHubEncryptionKey: c.String("coding-github-encryption-key"),
				PostgresDSN:               c.String("postgres-dsn"),
				ExternalJWTJWKSURL:        c.String("external-jwt-jwks-url"),
				ExternalJWTIssuer:         c.String("external-jwt-issuer"),
				ExternalJWTAudience:       c.String("external-jwt-audience"),
				InternalK8sTokenAudience:  c.String("internal-k8s-token-audience"),
				TargetOverride:            c.String("target-override"),
				FilesystemTargetOverride:  c.String("filesystem-target-override"),
				AgentImage:                c.String("agent-image"),
				AgentTraceEndpoint:        c.String("agent-trace-endpoint"),
				OpenBaoAddr:               c.String("openbao-addr"),
				OpenBaoSecretMountPath:    c.String("openbao-secret-mount-path"),
				OpenBaoK8sAuthRole:        c.String("openbao-k8s-auth-role"),
				OpenBaoK8sAuthMountPath:   c.String("openbao-k8s-auth-mount-path"),
				OpenBaoK8sAuthTokenPath:   c.String("openbao-k8s-auth-token-path"),
				MCPProbeStaleAfter:        c.Duration("mcp-probe-stale-after"),
				AllowedWebOrigins:         c.StringSlice("allowed-web-origin"),
				SkillStore: skill.Config{
					Endpoint:        c.String("skills-s3-endpoint"),
					Region:          c.String("skills-s3-region"),
					Bucket:          c.String("skills-s3-bucket"),
					AccessKeyID:     strings.TrimSpace(os.Getenv("AGENTZ_SKILLS_S3_ACCESS_KEY_ID")),
					SecretAccessKey: strings.TrimSpace(os.Getenv("AGENTZ_SKILLS_S3_SECRET_ACCESS_KEY")),
				},
			},
		)
	},
}
