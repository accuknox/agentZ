package agent

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"strings"
	"text/template"

	baoapi "github.com/openbao/openbao/api/v2"
)

//go:embed policies/sinjector-readonly.hcl
var sinjectorPolicyTemplate string

var sinjectorPolicy = template.Must(template.New("sinjector-policy").Parse(sinjectorPolicyTemplate))

// OpenBaoProvisioner reconciles SIP-specific OpenBao auth objects.
type OpenBaoProvisioner interface {
	ProvisionSinjector(ctx context.Context, cfg RuntimeConfig, opts SinjectorOpenBaoOptions) error
	CleanupSinjector(ctx context.Context, cfg RuntimeConfig, opts SinjectorOpenBaoOptions) error
}

// SinjectorOpenBaoOptions identifies the SIP OpenBao identity and secret scope.
type SinjectorOpenBaoOptions struct {
	Namespace          string
	ServiceAccountName string
	RoleName           string
	PolicyName         string
	AgentName          string
}

type openBaoProvisioner struct {
	client *baoapi.Client
}

type sinjectorPolicyData struct {
	DataPath     string
	MetadataPath string
}

// NewOpenBaoProvisioner shares the manager's authenticated client so repeated
// provisioning does not create additional tokens or renewal goroutines.
func NewOpenBaoProvisioner(client *baoapi.Client) OpenBaoProvisioner {
	return &openBaoProvisioner{client: client}
}

// ProvisionSinjector binds the service account to its Agent's secret policy.
func (p *openBaoProvisioner) ProvisionSinjector(ctx context.Context, cfg RuntimeConfig, opts SinjectorOpenBaoOptions) error {
	policy, err := renderSinjectorPolicy(cfg.OpenBaoSecretMountPath, opts.Namespace, opts.AgentName)
	if err != nil {
		return err
	}
	if err := p.client.Sys().PutPolicyWithContext(ctx, opts.PolicyName, policy); err != nil {
		return fmt.Errorf("put openbao policy: %w", err)
	}

	rolePath := fmt.Sprintf("auth/%s/role/%s", strings.Trim(cfg.OpenBaoK8sAuthMountPath, "/"), opts.RoleName)
	_, err = p.client.Logical().WriteWithContext(
		ctx,
		rolePath,
		map[string]any{
			"bound_service_account_names":      opts.ServiceAccountName,
			"bound_service_account_namespaces": opts.Namespace,
			"token_policies":                   opts.PolicyName,
			"token_period":                     "1h",
			"token_type":                       "service",
		},
	)
	if err != nil {
		return fmt.Errorf("put openbao kubernetes role: %w", err)
	}
	return nil
}

func renderSinjectorPolicy(mount, namespace, agentName string) (string, error) {
	mount = strings.Trim(mount, "/")
	data := sinjectorPolicyData{
		DataPath: fmt.Sprintf(
			"%s/data/%s/agent-secrets/%s/*",
			mount,
			namespace,
			agentName,
		),
		MetadataPath: fmt.Sprintf(
			"%s/metadata/%s/agent-secrets/%s/*",
			mount,
			namespace,
			agentName,
		),
	}
	var out bytes.Buffer
	if err := sinjectorPolicy.Execute(&out, data); err != nil {
		return "", fmt.Errorf("render openbao policy: %w", err)
	}
	return out.String(), nil
}

// CleanupSinjector removes the Agent's OpenBao role and policy. Cleanup failures
// are logged so an unavailable OpenBao does not block Kubernetes deletion.
func (p *openBaoProvisioner) CleanupSinjector(ctx context.Context, cfg RuntimeConfig, opts SinjectorOpenBaoOptions) error {
	rolePath := fmt.Sprintf("auth/%s/role/%s", strings.Trim(cfg.OpenBaoK8sAuthMountPath, "/"), opts.RoleName)
	if _, err := p.client.Logical().DeleteWithContext(ctx, rolePath); err != nil {
		slog.WarnContext(
			ctx,
			"failed to delete openbao kubernetes role",
			slog.String("role", opts.RoleName),
			slog.Any("err", err),
		)
	}
	if err := p.client.Sys().DeletePolicyWithContext(ctx, opts.PolicyName); err != nil {
		slog.WarnContext(
			ctx,
			"failed to delete openbao policy",
			slog.String("policy", opts.PolicyName),
			slog.Any("err", err),
		)
	}
	return nil
}
