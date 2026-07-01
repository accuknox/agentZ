package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/observer"
)

var ObserverCmd = &cli.Command{
	Name:     "observer",
	Usage:    "Telemetry observer service",
	Commands: []*cli.Command{observerServeCmd},
}

var observerServeCmd = &cli.Command{
	Name:  "serve",
	Usage: "Run the PostgreSQL-backed telemetry observer",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:     "postgres-dsn",
			Usage:    "PostgreSQL DSN",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "kubearmor-relay-addr",
			Usage: "KubeArmor relay gRPC address",
			Value: observer.DefaultKubeArmorRelayAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "hubble-relay-addr",
			Usage: "Hubble relay gRPC address",
			Value: observer.DefaultHubbleRelayAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "otlp-trace-grpc-addr",
			Usage: "OTLP trace receiver gRPC listen address",
			Value: observer.DefaultOTLPTraceGRPCAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "namespace",
			Usage: "Kubernetes namespace to observe",
			Value: observer.DefaultNamespace,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.IntFlag{
			Name:  "batch-size",
			Usage: "Maximum events per PostgreSQL flush",
			Value: observer.DefaultBatchSize,
		},
		&cli.DurationFlag{
			Name:  "flush-interval",
			Usage: "Maximum PostgreSQL flush interval",
			Value: observer.DefaultFlushInterval,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return observer.Serve(ctx, observer.Config{
			PostgresDSN:        c.String("postgres-dsn"),
			KubeArmorRelayAddr: c.String("kubearmor-relay-addr"),
			HubbleRelayAddr:    c.String("hubble-relay-addr"),
			OTLPTraceGRPCAddr:  c.String("otlp-trace-grpc-addr"),
			Namespace:          c.String("namespace"),
			BatchSize:          c.Int("batch-size"),
			FlushInterval:      c.Duration("flush-interval"),
		})
	},
}
