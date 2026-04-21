/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"strings"

	// import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, etc.)
	// to ensure that exec-entrypoint and run can make use of them.
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"github.com/go-logr/logr"
	"github.com/urfave/cli/v3"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	"github.com/accuknox/clawarmor/cmd/clawarmor/subcommands"
	"github.com/accuknox/clawarmor/cmd/clawarmor/util"
	"github.com/accuknox/clawarmor/internal/controller"
	webhookv1alpha1 "github.com/accuknox/clawarmor/internal/webhook/v1alpha1"
	// +kubebuilder:scaffold:imports
)

var (
	scheme                                           = runtime.NewScheme()
	setupLog                                         = ctrl.Log.WithName("setup")
	metricsAddr                                      string
	metricsCertPath, metricsCertName, metricsCertKey string
	webhookCertPath, webhookCertName, webhookCertKey string
	enableLeaderElection                             bool
	probeAddr                                        string
	secureMetrics                                    bool
	enableHTTP2                                      bool
	tlsOpts                                          []func(*tls.Config)
	agentDefaultImage                                string
)

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
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "log-format",
			Usage: "Set log format: text, json",
			Value: "text",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.BoolFlag{
			Name:  "log-with-source",
			Usage: "Include source file and line number in log messages",
			Value: false,
		},
	},
	Commands: []*cli.Command{
		subcommands.AgentCmd,
		managerCmd,
		subcommands.SessionCmd,
		subcommands.ObserverCmd,
	},
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

var managerCmd = &cli.Command{
	Name:  "manager",
	Usage: "Kubernetes controller manager for managing agents",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:        "metrics-bind-address",
			Value:       "0",
			Destination: &metricsAddr,
		},
		&cli.StringFlag{
			Name:        "health-probe-bind-address",
			Value:       ":8081",
			Destination: &probeAddr,
		},
		&cli.BoolFlag{
			Name:        "leader-elect",
			Value:       false,
			Destination: &enableLeaderElection,
		},
		&cli.BoolFlag{
			Name:        "metrics-secure",
			Value:       true,
			Destination: &secureMetrics,
		},
		&cli.StringFlag{
			Name:        "webhook-cert-path",
			Destination: &webhookCertPath,
		},
		&cli.StringFlag{
			Name:        "webhook-cert-name",
			Value:       "tls.crt",
			Destination: &webhookCertName,
		},
		&cli.StringFlag{
			Name:        "webhook-cert-key",
			Value:       "tls.key",
			Destination: &webhookCertKey,
		},
		&cli.StringFlag{
			Name:        "metrics-cert-path",
			Destination: &metricsCertPath,
		},
		&cli.StringFlag{
			Name:        "metrics-cert-name",
			Value:       "tls.crt",
			Destination: &metricsCertName,
		},
		&cli.StringFlag{
			Name:        "metrics-cert-key",
			Value:       "tls.key",
			Destination: &metricsCertKey,
		},
		&cli.BoolFlag{
			Name:        "enable-http2",
			Value:       false,
			Destination: &enableHTTP2,
		},
		&cli.StringFlag{
			Name:        "agent-default-image",
			Usage:       "Default container image for Agent pods",
			Value:       envOr("CLAWARMOR_AGENT_DEFAULT_IMAGE", ""),
			Destination: &agentDefaultImage,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		ctrl.SetLogger(logr.FromSlogHandler(slog.Default().Handler()))

		// if the enable-http2 flag is false (the default), http/2 should be
		// disabled due to its vulnerabilities. More specifically, disabling
		// http/2 will prevent from being vulnerable to the HTTP/2 Stream
		// Cancellation and Rapid Reset CVEs.
		//
		// For more information see:
		// - https://github.com/advisories/GHSA-qppj-fm5r-hxr3
		// - https://github.com/advisories/GHSA-4374-p667-p6c8
		disableHTTP2 := func(c *tls.Config) {
			setupLog.Info("Disabling HTTP/2")
			c.NextProtos = []string{"http/1.1"}
		}

		if !enableHTTP2 {
			tlsOpts = append(tlsOpts, disableHTTP2)
		}

		// initial webhook TLS options
		webhookTLSOpts := tlsOpts
		webhookServerOptions := webhook.Options{
			TLSOpts: webhookTLSOpts,
		}

		if len(webhookCertPath) > 0 {
			setupLog.Info(
				"Initializing webhook certificate watcher using provided certificates",
				"webhook-cert-path", webhookCertPath,
				"webhook-cert-name", webhookCertName,
				"webhook-cert-key", webhookCertKey,
			)
			webhookServerOptions.CertDir = webhookCertPath
			webhookServerOptions.CertName = webhookCertName
			webhookServerOptions.KeyName = webhookCertKey
		}

		webhookServer := webhook.NewServer(webhookServerOptions)

		// metrics endpoint is enabled in 'config/default/kustomization.yaml'.
		// The Metrics options configure the server.
		//
		// More info:
		// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.23.3/pkg/metrics/server
		// - https://book.kubebuilder.io/reference/metrics.html
		metricsServerOptions := metricsserver.Options{
			BindAddress:   metricsAddr,
			SecureServing: secureMetrics,
			TLSOpts:       tlsOpts,
		}

		if secureMetrics {
			// filterProvider is used to protect the metrics endpoint with
			// authn/authz. These configurations ensure that only authorized
			// users and service accounts can access the metrics endpoint. The
			// RBAC are configured in 'config/rbac/kustomization.yaml'.
			//
			// More info:
			// https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.23.3/pkg/metrics/filters#WithAuthenticationAndAuthorization
			metricsServerOptions.FilterProvider = filters.WithAuthenticationAndAuthorization
		}

		// if the certificate is not specified, controller-runtime will
		// automatically generate self-signed certificates for the metrics
		// server. While convenient for development and testing, this setup is
		// not recommended for production.
		//
		// TODO(user): If you enable certManager, uncomment the following lines:
		// - [METRICS-WITH-CERTS] at config/default/kustomization.yaml to
		//   generate and use certificates managed by cert-manager for the metrics
		//   server.
		// - [PROMETHEUS-WITH-CERTS] at config/prometheus/kustomization.yaml for
		//   TLS certification.
		if len(metricsCertPath) > 0 {
			setupLog.Info(
				"Initializing metrics certificate watcher using provided certificates",
				"metrics-cert-path", metricsCertPath,
				"metrics-cert-name", metricsCertName,
				"metrics-cert-key", metricsCertKey,
			)
			metricsServerOptions.CertDir = metricsCertPath
			metricsServerOptions.CertName = metricsCertName
			metricsServerOptions.KeyName = metricsCertKey
		}

		// get the namespace(s) for namespace-scoped mode from WATCH_NAMESPACE
		// environment variable. The manager will only watch and manage
		// resources in the specified namespace(s).
		watchNamespace, err := getWatchNamespace()
		if err != nil {
			setupLog.Error(err, "Unable to get WATCH_NAMESPACE, the manager will watch and manage resources in all namespaces")
			os.Exit(1)
		}

		// configure manager options for namespace-scoped mode
		mgrOptions := ctrl.Options{
			Scheme:                 scheme,
			Metrics:                metricsServerOptions,
			WebhookServer:          webhookServer,
			HealthProbeBindAddress: probeAddr,
			LeaderElection:         enableLeaderElection,
			LeaderElectionID:       "d8e356e5.accuknox.com",
			// LeaderElectionReleaseOnCancel defines if the leader should step
			// down voluntarily when the Manager ends. This requires the binary
			// to immediately end when the Manager is stopped, otherwise, this
			// setting is unsafe. Setting this significantly speeds up voluntary
			// leader transitions as the new leader don't have to wait
			// LeaseDuration time first.
			//
			// In the default scaffold provided, the program ends immediately
			// after the manager stops, so would be fine to enable this option.
			// However, if you are doing or is intended to do any operation such
			// as perform cleanups after the manager stops then its usage might
			// be unsafe.
			// LeaderElectionReleaseOnCancel: true,
		}

		// configure cache to watch namespace(s) specified in WATCH_NAMESPACE
		mgrOptions.Cache = setupCacheNamespaces(watchNamespace)
		setupLog.Info("Watching namespace(s)", "namespaces", watchNamespace)

		mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), mgrOptions)
		if err != nil {
			setupLog.Error(err, "Failed to start manager")
			os.Exit(1)
		}

		reconciler := &controller.AgentReconciler{
			Client: mgr.GetClient(),
			Scheme: mgr.GetScheme(),
			Config: controller.AgentRuntimeConfig{
				DefaultImage: agentDefaultImage,
			},
		}
		if err := reconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create controller", "controller", "Agent")
			os.Exit(1)
		}
		// nolint:goconst
		if os.Getenv("ENABLE_WEBHOOKS") != "false" {
			err = webhookv1alpha1.SetupAgentWebhookWithManager(
				mgr,
				webhookv1alpha1.AgentWebhookConfig{
					DefaultImage: agentDefaultImage,
				},
			)
			if err != nil {
				setupLog.Error(err, "Failed to create webhook", "webhook", "Agent")
				os.Exit(1)
			}
		}
		// +kubebuilder:scaffold:builder

		if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
			setupLog.Error(err, "Failed to set up health check")
			os.Exit(1)
		}
		if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
			setupLog.Error(err, "Failed to set up ready check")
			os.Exit(1)
		}

		setupLog.Info("Starting manager")
		if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
			setupLog.Error(err, "Failed to run manager")
			os.Exit(1)
		}

		return nil
	},
}

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(clawarmorv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
}

func main() {
	ctx := context.Background()
	err := cmd.Run(ctx, os.Args)
	if err != nil {
		slog.ErrorContext(ctx, err.Error())
		os.Exit(1)
	}
}

// getWatchNamespace returns the namespace(s) the manager should watch for changes.
// It reads the value from the WATCH_NAMESPACE environment variable.
// - If WATCH_NAMESPACE is not set, an error is returned
// - If WATCH_NAMESPACE contains a single namespace, the manager watches that namespace
// - If WATCH_NAMESPACE contains comma-separated namespaces, the manager watches those namespaces
func getWatchNamespace() (string, error) {
	watchNamespaceEnvVar := "WATCH_NAMESPACE"
	ns, found := os.LookupEnv(watchNamespaceEnvVar)
	if !found {
		return "", fmt.Errorf("%s must be set", watchNamespaceEnvVar)
	}
	return ns, nil
}

// setupCacheNamespaces configures the cache to watch specific namespace(s).
// It supports both single namespace ("ns1") and multi-namespace ("ns1,ns2,ns3")
// formats.
func setupCacheNamespaces(namespaces string) cache.Options {
	defaultNamespaces := make(map[string]cache.Config)
	for ns := range strings.SplitSeq(namespaces, ",") {
		defaultNamespaces[strings.TrimSpace(ns)] = cache.Config{}
	}
	return cache.Options{
		DefaultNamespaces: defaultNamespaces,
	}
}

func envOr(key, fallback string) string {
	val := os.Getenv(key)
	if val != "" {
		return val
	}
	return fallback
}
