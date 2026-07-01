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

	baoclient "github.com/accuknox/agentz/internal/openbao"
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

// NewOpenBaoProvisioner creates an OpenBao provisioner for controller use.
func NewOpenBaoProvisioner(ctx context.Context, cfg RuntimeConfig) (OpenBaoProvisioner, error) {
	addr := strings.TrimSpace(cfg.ManagerOpenBaoAddr)
	if addr == "" {
		addr = strings.TrimSpace(cfg.OpenBaoAddr)
	}
	if addr == "" {
		return nil, fmt.Errorf("openbao addr is required")
	}
	role := strings.TrimSpace(cfg.ManagerOpenBaoK8sAuthRole)
	if role == "" {
		return nil, fmt.Errorf("manager openbao k8s auth role is required")
	}

	client, err := baoclient.NewClient(
		ctx,
		addr,
		role,
		cfg.OpenBaoK8sAuthMountPath,
		cfg.ManagerOpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return nil, err
	}
	return &openBaoProvisioner{client: client}, nil
}

func (p *openBaoProvisioner) ProvisionSinjector(ctx context.Context, cfg RuntimeConfig, opts SinjectorOpenBaoOptions) error {
	policy, err := renderSinjectorPolicy(cfg.OpenBaoSecretMountPath, opts.Namespace, opts.AgentName)
	if err != nil {
		return err
	}
	if err := p.client.Sys().PutPolicyWithContext(ctx, opts.PolicyName, policy); err != nil {
		return fmt.Errorf("put openbao policy: %w", err)
	}

	rolePath := fmt.Sprintf("auth/%s/role/%s", strings.Trim(cfg.OpenBaoK8sAuthMountPath, "/"), opts.RoleName)
	_, err = p.client.Logical().WriteWithContext(ctx, rolePath, map[string]any{
		"bound_service_account_names":      opts.ServiceAccountName,
		"bound_service_account_namespaces": opts.Namespace,
		"token_policies":                   opts.PolicyName,
		"token_period":                     "1h",
		"token_type":                       "service",
	})
	if err != nil {
		return fmt.Errorf("put openbao kubernetes role: %w", err)
	}
	return nil
}

func renderSinjectorPolicy(mount, namespace, agentName string) (string, error) {
	mount = strings.Trim(mount, "/")
	data := sinjectorPolicyData{
		DataPath:     fmt.Sprintf("%s/data/%s/%s/*", mount, namespace, agentName),
		MetadataPath: fmt.Sprintf("%s/metadata/%s/%s/*", mount, namespace, agentName),
	}
	var out bytes.Buffer
	if err := sinjectorPolicy.Execute(&out, data); err != nil {
		return "", fmt.Errorf("render openbao policy: %w", err)
	}
	return out.String(), nil
}

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
