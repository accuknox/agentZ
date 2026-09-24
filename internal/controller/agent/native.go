package agent

import (
	"context"
	"fmt"
	"net/url"
	"path"
	"reflect"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/host"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// NativeRuntime resolves the same sandbox, inference, MCP, skills and OpenCode
// configuration used by Kubernetes Agents, targeting daemon-owned local bridges.
func (r *Reconciler) NativeRuntime(ctx context.Context, agt *agentzv1alpha1.Agent, endpoints host.NativeEndpoints) (host.RuntimeSpec, error) {
	if agt.Spec.Execution != agentzv1alpha1.AgentExecutionNative {
		return host.RuntimeSpec{}, fmt.Errorf("agent does not use native execution")
	}
	cfg, err := r.resolveSandbox(ctx, agt)
	if err != nil {
		return host.RuntimeSpec{}, err
	}
	if endpoints.MCP == "" || endpoints.Inference == "" || endpoints.Platform == "" {
		return host.RuntimeSpec{}, fmt.Errorf("native MCP, inference and platform bridges are required")
	}
	cfg.RuntimePaths = &endpoints
	if cfg.MCPURL != "" {
		route, err := url.Parse(cfg.MCPURL)
		if err != nil {
			return host.RuntimeSpec{}, fmt.Errorf("parse MCP route: %w", err)
		}
		cfg.MCPURL = endpoints.MCP + route.RequestURI()
	}
	for _, provider := range cfg.Providers {
		if provider.Options != nil && provider.Options.BaseURL != "" {
			route, err := url.Parse(provider.Options.BaseURL)
			if err != nil {
				return host.RuntimeSpec{}, fmt.Errorf("parse inference route: %w", err)
			}
			provider.Options.BaseURL = endpoints.Inference + route.RequestURI()
		}
		for name, model := range provider.Models {
			if model.Provider == nil || model.Provider.API == "" {
				continue
			}
			route, err := url.Parse(model.Provider.API)
			if err != nil {
				return host.RuntimeSpec{}, fmt.Errorf("parse model route: %w", err)
			}
			model.Provider.API = endpoints.Inference + route.RequestURI()
			provider.Models[name] = model
		}
	}
	config, instructions, err := renderOpencodeConfig(agt, cfg)
	if err != nil {
		return host.RuntimeSpec{}, err
	}
	result := host.RuntimeSpec{
		OpenCodeConfig: config,
		Instructions:   make(map[string]string, len(instructions)),
		Packages:       cfg.Packages,
		AllowedHosts:   cfg.AllowedHosts,
		Skills:         cfg.Skills,
		Env:            make(map[string]string),
		SecretProxy:    agt.Spec.SecretProxy == nil || *agt.Spec.SecretProxy,
		WorkDirectory:  endpoints.WorkDirectory,
	}
	for _, file := range instructions {
		result.Instructions[path.Base(file.Path)] = file.Content
	}
	for _, env := range r.agentEnv(agt, cfg, true) {
		if env.ValueFrom != nil {
			return host.RuntimeSpec{}, fmt.Errorf("native environment %q cannot use Kubernetes valueFrom", env.Name)
		}
		result.Env[env.Name] = env.Value
	}
	delete(result.Env, "NIX_PROFILES")
	delete(result.Env, "PATH")
	result.Env["OPENCODE_CONFIG"] = path.Join(endpoints.ConfigDirectory, opencodeConfigKey)
	result.Env["AGENTZ_GATEWAY_URL"] = endpoints.Platform
	if agt.Spec.Telemetry.Enabled {
		result.Env["OPENCODE_OTLP_ENDPOINT"] = "http://127.0.0.1:4187"
		result.Env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:4187"
	}
	result.Env["AGENTZ_GATEWAY_TOKEN_PATH"] = endpoints.GatewayTokenPath
	result.Env["AGENTZ_IMMUTABLE_SKILLS_PATH"] = endpoints.ImmutableSkillsDirectory
	if result.SecretProxy {
		if endpoints.Proxy == "" || endpoints.CABundlePath == "" {
			return host.RuntimeSpec{}, fmt.Errorf("secret proxy requires local proxy and CA bundle")
		}
		result.Env["https_proxy"] = endpoints.Proxy
		result.Env["HTTPS_PROXY"] = endpoints.Proxy
		result.Env["no_proxy"] = "localhost,127.0.0.1,::1"
		result.Env["NO_PROXY"] = "localhost,127.0.0.1,::1"
		certificateVariables := []string{
			"SSL_CERT_FILE",
			"REQUESTS_CA_BUNDLE",
			"CURL_CA_BUNDLE",
			"NODE_EXTRA_CA_CERTS",
		}
		for _, name := range certificateVariables {
			result.Env[name] = endpoints.CABundlePath
		}
	}
	return result, nil
}

func (r *Reconciler) reconcileNative(ctx context.Context, agt *agentzv1alpha1.Agent, cfg sandboxConfig) (ctrl.Result, error) {
	if err := r.reconcileServiceAccount(ctx, agt, agt.Name, resourceLabels(agt)); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile native Agent service account: %w", err)
	}
	if err := r.reconcileGatewayAccess(ctx, agt); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile native gateway access: %w", err)
	}
	ready, err := r.reconcileSecretProxy(ctx, agt, cfg.AllowedHosts)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !ready {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}
	status := agt.Status.DeepCopy()
	status.ObservedGeneration = agt.Generation
	status.ServiceName = ""
	status.URL = ""
	if len(status.Conditions) == 0 {
		status.SetCondition(metav1.Condition{
			Type:               agentzv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             "WaitingForHost",
			Message:            "Waiting for the enrolled Linux host to start the Agent",
			ObservedGeneration: agt.Generation,
		})
	}
	if reflect.DeepEqual(agt.Status, *status) {
		return ctrl.Result{}, nil
	}
	patch := client.MergeFrom(agt.DeepCopy())
	agt.Status = *status
	return ctrl.Result{}, r.Status().Patch(ctx, agt, patch)
}
