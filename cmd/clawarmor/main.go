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
	"net/http"
	"os"
	"strings"

	// import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, etc.)
	// to ensure that exec-entrypoint and run can make use of them.
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	agentgatewayclientset "github.com/agentgateway/agentgateway/controller/pkg/client/clientset/versioned"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
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
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/clawarmor/cmd/clawarmor/subcommands"
	"github.com/accuknox/clawarmor/cmd/clawarmor/util"
	"github.com/accuknox/clawarmor/internal/controller/agent"
	environmentcontroller "github.com/accuknox/clawarmor/internal/controller/environment"
	"github.com/accuknox/clawarmor/internal/controller/mcpconn"
	workflowruncontroller "github.com/accuknox/clawarmor/internal/controller/workflowrun"
	workflowschedulecontroller "github.com/accuknox/clawarmor/internal/controller/workflowschedule"
	"github.com/accuknox/clawarmor/internal/envutil"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/mcp"
	webhookv1alpha1 "github.com/accuknox/clawarmor/internal/webhook/v1alpha1"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
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
	agentImage                                       string
	controllerImage                                  string
	gatewayURL                                       string
	nixStorePVC                                      string
	agentInitImage                                   string
	openBaoAddr                                      string
	managerOpenBaoAddr                               string
	openBaoSecretMountPath                           string
	openBaoK8sAuthMountPath                          string
	sinjectorOpenBaoK8sAuthTokenPath                 string
	managerOpenBaoK8sAuthRole                        string
	managerOpenBaoK8sAuthTokenPath                   string
	sinjectorCASecretName                            string
	sinjectorCASecretCertKey                         string
	sinjectorCASecretKeyKey                          string
	sinjectorCASecretBundleKey                       string
	sinjectorCACertPath                              string
	sinjectorCAKeyPath                               string
	agentCABundlePath                                string
	watchNamespace                                   string
	enableWebhooks                                   bool
)

type silentExitCoder interface {
	ExitCode() int
	Silent() bool
}

var cmd = &cli.Command{
	Name:                  "clawarmor",
	Usage:                 "The AI that actually does things - SECURELY.",
	EnableShellCompletion: true,
	Authors:               []any{"Murtaza U <murtaza@accuknox.com>"},
	ExitErrHandler: func(_ context.Context, _ *cli.Command, err error) {
		if e, ok := err.(silentExitCoder); ok && e.Silent() {
			os.Exit(e.ExitCode())
		}
		cli.HandleExitCoder(err)
	},
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
		subcommands.ExtAuthCmd,
		managerCmd,
		subcommands.GatewayCmd,
		subcommands.ObserverCmd,
		subcommands.SinjectorCmd,
		subcommands.WorkflowCmd,
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
			Name:        "controller-image",
			Usage:       "Container image for workflow schedule CronJob pods",
			Destination: &controllerImage,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "agent-image",
			Usage:       "Default container image for Agent pods",
			Destination: &agentImage,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "gateway-url",
			Usage:       "Gateway base URL exposed to Agent workflow tools",
			Value:       "http://localhost:8090",
			Destination: &gatewayURL,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "nix-store-pvc",
			Usage:       "Name of the shared nix store PVC (pre-created by admin)",
			Destination: &nixStorePVC,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "agent-init-image",
			Usage:       "Container image for nix agent init containers",
			Destination: &agentInitImage,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "openbao-addr",
			Usage:       "OpenBao server address",
			Value:       "http://openbao.openbao.svc.cluster.local:8200",
			Destination: &openBaoAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "manager-openbao-addr",
			Usage:       "Controller-manager OpenBao address for provisioning",
			Hidden:      true,
			Destination: &managerOpenBaoAddr,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "openbao-secret-mount-path",
			Usage:       "OpenBao KV v2 secret engine mount path",
			Value:       "kv",
			Destination: &openBaoSecretMountPath,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "openbao-k8s-auth-mount-path",
			Usage:       "OpenBao Kubernetes auth mount path",
			Value:       "kubernetes",
			Destination: &openBaoK8sAuthMountPath,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "sinjector-openbao-k8s-auth-token-path",
			Usage:       "SIP Kubernetes service account token path",
			Value:       "/var/run/secrets/kubernetes.io/serviceaccount/token",
			Destination: &sinjectorOpenBaoK8sAuthTokenPath,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "manager-openbao-k8s-auth-role",
			Usage:       "OpenBao Kubernetes auth role for controller-manager provisioning",
			Value:       "manager",
			Destination: &managerOpenBaoK8sAuthRole,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "manager-openbao-k8s-auth-token-path",
			Usage:       "Controller-manager Kubernetes token path for OpenBao auth",
			Value:       "/var/run/secrets/kubernetes.io/serviceaccount/token",
			Destination: &managerOpenBaoK8sAuthTokenPath,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-secret-name",
			Usage:       "Shared cert-manager Secret containing SIP CA cert/key/bundle",
			Value:       "sinjector",
			Destination: &sinjectorCASecretName,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-secret-cert-key",
			Usage:       "Secret key holding the SIP CA certificate",
			Value:       "tls.crt",
			Destination: &sinjectorCASecretCertKey,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-secret-key-key",
			Usage:       "Secret key holding the SIP CA private key",
			Value:       "tls.key",
			Destination: &sinjectorCASecretKeyKey,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-secret-bundle-key",
			Usage:       "Secret key holding the SIP CA bundle",
			Value:       "ca.crt",
			Destination: &sinjectorCASecretBundleKey,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-cert-path",
			Usage:       "Path to SIP CA certificate inside the sinjector container",
			Value:       "/etc/clawarmor/sinjector-ca/tls.crt",
			Destination: &sinjectorCACertPath,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "sinjector-ca-key-path",
			Usage:       "Path to SIP CA private key inside the sinjector container",
			Value:       "/etc/clawarmor/sinjector-ca/tls.key",
			Destination: &sinjectorCAKeyPath,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "agent-ca-bundle-path",
			Usage:       "Path to CA bundle mounted in Agent containers",
			Value:       "/etc/clawarmor/sinjector-ca/ca.crt",
			Destination: &agentCABundlePath,
			Hidden:      true,
		},
		&cli.StringFlag{
			Name:        "watch-namespace",
			Usage:       "Namespace(s) to watch and manage. Use commas for multiple.",
			Destination: &watchNamespace,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.BoolFlag{
			Name:        "enable-webhooks",
			Usage:       "Enable admission webhooks",
			Value:       true,
			Destination: &enableWebhooks,
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
				"initializing webhook certificate watcher using provided certificates",
				"webhook-cert-path", webhookCertPath,
				"webhook-cert-name", webhookCertName,
				"webhook-cert-key", webhookCertKey,
			)
			webhookServerOptions.CertDir = webhookCertPath
			webhookServerOptions.CertName = webhookCertName
			webhookServerOptions.KeyName = webhookCertKey
		}

		webhookServer := webhook.NewServer(webhookServerOptions)

		// metrics endpoint is enabled in 'deploy/kustomize/default/kustomization.yaml'.
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
			// RBAC are configured in 'deploy/kustomize/rbac/kustomization.yaml'.
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
		if len(metricsCertPath) > 0 {
			setupLog.Info(
				"initializing metrics certificate watcher using provided certificates",
				"metrics-cert-path", metricsCertPath,
				"metrics-cert-name", metricsCertName,
				"metrics-cert-key", metricsCertKey,
			)
			metricsServerOptions.CertDir = metricsCertPath
			metricsServerOptions.CertName = metricsCertName
			metricsServerOptions.KeyName = metricsCertKey
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
			// This process exits when the manager stops, so opting into release-on-cancel
			// is safe if faster voluntary leader handoff becomes important.
			// LeaderElectionReleaseOnCancel: true,
		}

		// configure cache to watch namespace(s) specified by --watch-namespace
		if strings.TrimSpace(watchNamespace) != "" {
			defaultNamespaces := make(map[string]cache.Config)
			for ns := range strings.SplitSeq(watchNamespace, ",") {
				defaultNamespaces[strings.TrimSpace(ns)] = cache.Config{}
			}
			mgrOptions.Cache = cache.Options{DefaultNamespaces: defaultNamespaces}
			setupLog.Info("watching namespace(s)", "namespaces", watchNamespace)
		}

		restCfg, err := ctrl.GetConfig()
		if err != nil {
			setupLog.Error(err, "failed to load Kubernetes config")
			os.Exit(1)
		}

		mgr, err := ctrl.NewManager(restCfg, mgrOptions)
		if err != nil {
			setupLog.Error(err, "failed to start manager")
			os.Exit(1)
		}
		err = mcp.IndexEnvironmentMCPConnections(
			context.Background(),
			mgr.GetFieldIndexer(),
		)
		if err != nil {
			setupLog.Error(
				err,
				"failed to register shared field index",
				"index", mcp.EnvironmentByMCPConnectionIndex,
			)
			os.Exit(1)
		}
		err = envutil.IndexAgentsByEnvironment(
			context.Background(),
			mgr.GetFieldIndexer(),
		)
		if err != nil {
			setupLog.Error(
				err,
				"failed to register shared field index",
				"index", envutil.AgentByEnvironmentIndex,
			)
			os.Exit(1)
		}
		err = workflowschedulecontroller.IndexWorkflowRunsBySchedule(
			context.Background(),
			mgr.GetFieldIndexer(),
		)
		if err != nil {
			setupLog.Error(
				err,
				"failed to register shared field index",
				"index", workflowschedulecontroller.WorkflowRunByScheduleIndex,
			)
			os.Exit(1)
		}

		gwClient, err := gatewayapi.NewClientWithResponses(gatewayURL, gatewayapi.WithHTTPClient(&http.Client{}))
		if err != nil {
			setupLog.Error(
				err,
				"failed to create gateway client",
				"gatewayURL", gatewayURL,
			)
			os.Exit(1)
		}
		agClient, err := agentgatewayclientset.NewForConfig(restCfg)
		if err != nil {
			setupLog.Error(err, "failed to create agentgateway clientset")
			os.Exit(1)
		}
		if openBaoAddr == "" {
			return fmt.Errorf("openbao addr is required")
		}
		if openBaoSecretMountPath == "" {
			return fmt.Errorf("openbao secret mount path is required")
		}
		if sinjectorCASecretName == "" {
			return fmt.Errorf("sinjector ca secret name is required")
		}

		runtimeConfig := agent.RuntimeConfig{
			AgentDefaultImage:                agentImage,
			GatewayURL:                       gatewayURL,
			SharedNixPVC:                     nixStorePVC,
			AgentInitImage:                   agentInitImage,
			OpenBaoAddr:                      openBaoAddr,
			ManagerOpenBaoAddr:               managerOpenBaoAddr,
			OpenBaoSecretMountPath:           openBaoSecretMountPath,
			OpenBaoK8sAuthMountPath:          openBaoK8sAuthMountPath,
			SinjectorOpenBaoK8sAuthTokenPath: sinjectorOpenBaoK8sAuthTokenPath,
			ManagerOpenBaoK8sAuthRole:        managerOpenBaoK8sAuthRole,
			ManagerOpenBaoK8sAuthTokenPath:   managerOpenBaoK8sAuthTokenPath,
			SinjectorImage:                   controllerImage,
			SinjectorCASecretName:            sinjectorCASecretName,
			SinjectorCASecretCertKey:         sinjectorCASecretCertKey,
			SinjectorCASecretKeyKey:          sinjectorCASecretKeyKey,
			SinjectorCASecretBundleKey:       sinjectorCASecretBundleKey,
			SinjectorCACertPath:              sinjectorCACertPath,
			SinjectorCAKeyPath:               sinjectorCAKeyPath,
			AgentCABundlePath:                agentCABundlePath,
		}

		bao, err := agent.NewOpenBaoProvisioner(ctx, runtimeConfig)
		if err != nil {
			setupLog.Error(err, "failed to create OpenBao provisioner")
			os.Exit(1)
		}

		reconciler := &agent.Reconciler{
			Client: mgr.GetClient(),
			Scheme: mgr.GetScheme(),
			Config: runtimeConfig,
			Bao:    bao,
		}
		if err := reconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "failed to create controller", "controller", "Agent")
			os.Exit(1)
		}

		envReconciler := &environmentcontroller.Reconciler{
			Client:       mgr.GetClient(),
			Scheme:       mgr.GetScheme(),
			AgentGateway: agClient,
		}
		if err := envReconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "failed to create controller", "controller", "Environment")
			os.Exit(1)
		}

		if enableWebhooks {
			err = webhookv1alpha1.SetupAgentWebhookWithManager(mgr, webhookv1alpha1.AgentWebhookConfig{
				AgentDefaultImage: agentImage,
			})
			if err != nil {
				setupLog.Error(err, "failed to create webhook", "webhook", "Agent")
				os.Exit(1)
			}
			if err := webhookv1alpha1.SetupEnvironmentWebhookWithManager(mgr); err != nil {
				setupLog.Error(err, "failed to create webhook", "webhook", "Environment")
				os.Exit(1)
			}
			if err := webhookv1alpha1.SetupWorkflowScheduleWebhookWithManager(mgr, gwClient); err != nil {
				setupLog.Error(err, "failed to create webhook", "webhook", "WorkflowSchedule")
				os.Exit(1)
			}
			if err := webhookv1alpha1.SetupWorkflowRunWebhookWithManager(mgr, gwClient); err != nil {
				setupLog.Error(err, "failed to create webhook", "webhook", "WorkflowRun")
				os.Exit(1)
			}
			if err := webhookv1alpha1.SetupMCPConnectionWebhookWithManager(mgr, mgr.GetClient()); err != nil {
				setupLog.Error(err, "failed to create webhook", "webhook", "MCPConnection")
				os.Exit(1)
			}
		}

		workflowScheduleReconciler := &workflowschedulecontroller.Reconciler{
			Client:          mgr.GetClient(),
			Scheme:          mgr.GetScheme(),
			ControllerImage: controllerImage,
		}
		if err := workflowScheduleReconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "failed to create controller", "controller", "WorkflowSchedule")
			os.Exit(1)
		}

		workflowRunReconciler := &workflowruncontroller.Reconciler{
			Client:        mgr.GetClient(),
			GatewayClient: gwClient,
		}
		if err := workflowRunReconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "failed to create controller", "controller", "WorkflowRun")
			os.Exit(1)
		}

		mcpConnReconciler := &mcpconn.MCPConnectionReconciler{
			Client:                  mgr.GetClient(),
			Scheme:                  mgr.GetScheme(),
			AgentGateway:            agClient,
			ControllerImage:         controllerImage,
			OpenBaoAddr:             openBaoAddr,
			ManagerOpenBaoAddr:      managerOpenBaoAddr,
			OpenBaoSecretMountPath:  openBaoSecretMountPath,
			OpenBaoK8sAuthRole:      managerOpenBaoK8sAuthRole,
			OpenBaoK8sAuthMountPath: openBaoK8sAuthMountPath,
			OpenBaoK8sAuthTokenPath: managerOpenBaoK8sAuthTokenPath,
		}
		if err := mcpConnReconciler.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "failed to create controller", "controller", "MCPConnection")
			os.Exit(1)
		}

		// +kubebuilder:scaffold:builder

		if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
			setupLog.Error(err, "failed to set up health check")
			os.Exit(1)
		}
		if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
			setupLog.Error(err, "failed to set up ready check")
			os.Exit(1)
		}

		setupLog.Info("Starting manager")
		if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
			setupLog.Error(err, "failed to run manager")
			os.Exit(1)
		}

		return nil
	},
}

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(clawarmorv1alpha1.AddToScheme(scheme))
	utilruntime.Must(ciliumv2.AddToScheme(scheme))
	utilruntime.Must(gwv1.Install(scheme))
	utilruntime.Must(agentgatewayv1alpha1.Install(scheme))
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
