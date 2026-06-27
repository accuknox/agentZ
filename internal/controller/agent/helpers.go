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

package agent

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"

	corev1 "k8s.io/api/core/v1"

	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	opencodeConfigKey              = "opencode.json"
	opencodeInstructionKey         = "instruction.md"
	configVolume                   = "config"
	opencodeConfigDir              = "/etc/clawarmor/opencode"
	opencodeInstructionPath        = "/etc/clawarmor/opencode/instruction.md"
	createWorkflowToolName         = "create_workflow"
	createWorkflowScheduleToolName = "create_workflow_schedule"
	listWorkflowSchedulesToolName  = "list_workflow_schedules"
	getWorkflowToolName            = "get_workflow"
	listWorkflowsToolName          = "list_workflows"
	deleteWorkflowsToolName        = "delete_workflows"
	deleteWorkflowScheduleToolName = "delete_workflow_schedule"
	setWorkflowRunStatusToolName   = "set_workflowrun_status"
	updateWorkflowScheduleToolName = "update_workflow_schedule"
	nixAgentVolume                 = "nix-agent"
	nixRuntimeStoreVolume          = "nix-runtime-store"
	nixAgentMount                  = "/mnt/nix"
	nixRuntimeStoreMount           = "/nix/store"
	nixRuntimeStageMount           = "/runtime-nix-store"
	nixHomeSubPath                 = "home"
	nixStoreSubPath                = "nix"
	nixVolumeRootMount             = "/pvc"
	nixLinkVolume                  = "nix-link"
	nixLinkMount                   = "/tmp/nix-link"
	nixLinkStage                   = "/tmp/nix-link"
	nixInitImage                   = "murtazau/clawarmor-init:latest"
	homeInitName                   = "home-init"
	agentRuntimeUID                = int64(1000)
	agentRuntimeGID                = int64(1000)
	nixPkgEnv                      = "NIX_PACKAGES"
	packageJobLabelKey             = "clawarmor.accuknox.com/agent-package-job"
	packageJobNameSuffix           = "-packages"
	packageJobHashAnnotation       = "clawarmor.accuknox.com/package-job-hash"
	packageJobRootVolume           = "nix-agent-root"
	packageJobSharedVolume         = "nix-shared"
	sinjectorNameSuffix            = "-sinjector"
	sinjectorCAVolume              = "sinjector-ca"
	sinjectorCAMountPath           = "/etc/clawarmor/sinjector-ca"
	sinjectorFinalizer             = "clawarmor.accuknox.com/sinjector"
	gatewayRoleNameSuffix          = "-gateway"
	gatewayTokenVolume             = "gateway-token"
	gatewayTokenMountPath          = "/var/run/secrets/clawarmor/gateway"
	gatewayTokenPath               = gatewayTokenMountPath + "/token"
	egressPolicySuffix             = "-egress"
	opencodeConfigSchema           = "https://opencode.ai/config.json"
)

var (
	errImageEmpty       = errors.New("agent image must not be empty")
	errPackageJobFailed = errors.New("package job failed")
)

// RuntimeConfig configures controller-side launch defaults.
type RuntimeConfig struct {
	AgentDefaultImage                string
	GatewayURL                       string
	SharedNixPVC                     string
	AgentInitImage                   string
	OpenBaoAddr                      string
	ManagerOpenBaoAddr               string
	OpenBaoSecretMountPath           string
	SinjectorImage                   string
	SinjectorCASecretName            string
	SinjectorCASecretCertKey         string
	SinjectorCASecretKeyKey          string
	SinjectorCASecretBundleKey       string
	SinjectorCACertPath              string
	SinjectorCAKeyPath               string
	AgentCABundlePath                string
	OpenBaoK8sAuthMountPath          string
	SinjectorOpenBaoK8sAuthTokenPath string
	ManagerOpenBaoK8sAuthRole        string
	ManagerOpenBaoK8sAuthTokenPath   string
	GatewayTokenAudience             string
}

func selectorLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":         "clawarmor-agent",
		"app.kubernetes.io/instance":     agt.Name,
		"clawarmor.accuknox.com/agent":   agt.Name,
		"clawarmor.accuknox.com/managed": "true",
	}
}

func packageJobLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	labels["app.kubernetes.io/name"] = "clawarmor-agent-packages"
	labels["app.kubernetes.io/instance"] = agt.Name
	labels[packageJobLabelKey] = agt.Name
	labels["clawarmor.accuknox.com/managed"] = "true"
	return labels
}

func packageJobName(agt *clawarmorv1alpha1.Agent) string {
	return agt.Name + packageJobNameSuffix
}

func sinjectorSelectorLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":           "clawarmor-sinjector",
		"app.kubernetes.io/instance":       agt.Name,
		"clawarmor.accuknox.com/sinjector": agt.Name,
		"clawarmor.accuknox.com/managed":   "true",
	}
}

func sinjectorLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, sinjectorSelectorLabels(agt))
	return labels
}

func sinjectorName(agt *clawarmorv1alpha1.Agent) string {
	return agt.Name + sinjectorNameSuffix
}

func egressPolicyName(agt *clawarmorv1alpha1.Agent) string {
	return agt.Name + egressPolicySuffix
}

func resourceLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, selectorLabels(agt))
	return labels
}

func renderOpencodeConfig(agt *clawarmorv1alpha1.Agent, envCfg environmentConfig) ([]byte, string, error) {
	cfg := opencodeConfigFile{
		Schema: opencodeConfigSchema,
		Permission: map[string]opencodePermissionRule{
			"*": "allow",
		},
	}
	if agt.Spec.Model != "" {
		cfg.Model = agt.Spec.Model
	}
	if agt.Spec.SmallModel != "" {
		cfg.SmallModel = agt.Spec.SmallModel
	}
	instruction := strings.TrimSpace(agt.Spec.Instruction)
	if instruction != "" {
		cfg.Instructions = []string{opencodeInstructionPath}
	}
	if len(agt.Spec.Providers) > 0 {
		cfg.Provider = make(map[string]opencodeProviderFile, len(agt.Spec.Providers))
		for name, provider := range agt.Spec.Providers {
			item := opencodeProviderFile{}
			if len(provider.Env) > 0 {
				item.Env = append([]string{}, provider.Env...)
			}
			if strings.TrimSpace(provider.BaseURL) != "" {
				item.Options = &opencodeProviderOptionsFile{
					BaseURL: provider.BaseURL,
				}
			}
			cfg.Provider[name] = item
		}
	}
	cfg.Tools = map[string]bool{
		createWorkflowToolName:         true,
		createWorkflowScheduleToolName: true,
		listWorkflowSchedulesToolName:  true,
		getWorkflowToolName:            true,
		listWorkflowsToolName:          true,
		deleteWorkflowsToolName:        true,
		deleteWorkflowScheduleToolName: true,
		setWorkflowRunStatusToolName:   false,
		updateWorkflowScheduleToolName: true,
	}
	if envCfg.MCPURL != "" {
		cfg.MCP = map[string]opencodeMCPRemoteFile{
			mcp.OpenCodeGatewayToolsetName: {
				Type: "remote",
				URL:  envCfg.MCPURL,
			},
		}
	}
	var singleMCPConnectionName string
	if len(envCfg.MCPRefs) == 1 {
		singleMCPConnectionName = envCfg.MCPRefs[0].Name
	}
	if len(envCfg.MCPConsentPermissionIDs) > 0 {
		for _, permissionID := range envCfg.MCPConsentPermissionIDs {
			cfg.Permission[mcp.OpenCodeGatewayToolsetName+"_"+permissionID] = "ask"
			if singleMCPConnectionName == "" {
				continue
			}
			aliasPermissionID, ok := strings.CutPrefix(
				permissionID,
				singleMCPConnectionName+"_",
			)
			if ok && aliasPermissionID != "" {
				cfg.Permission[mcp.OpenCodeGatewayToolsetName+"_"+aliasPermissionID] = "ask"
			}
		}
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, "", fmt.Errorf("marshal opencode json: %w", err)
	}
	return append(data, '\n'), instruction, nil
}

type opencodeConfigFile struct {
	Schema       string                            `json:"$schema"`
	Model        string                            `json:"model,omitempty"`
	SmallModel   string                            `json:"small_model,omitempty"`
	Instructions []string                          `json:"instructions,omitempty"`
	Provider     map[string]opencodeProviderFile   `json:"provider,omitempty"`
	MCP          map[string]opencodeMCPRemoteFile  `json:"mcp,omitempty"`
	Permission   map[string]opencodePermissionRule `json:"permission,omitempty"`
	Tools        map[string]bool                   `json:"tools,omitempty"`
}

type opencodePermissionRule string

type opencodeMCPRemoteFile struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type opencodeProviderFile struct {
	Env     []string                     `json:"env,omitempty"`
	Options *opencodeProviderOptionsFile `json:"options,omitempty"`
}

type opencodeProviderOptionsFile struct {
	BaseURL string `json:"baseURL,omitempty"`
}

type configHashInput struct {
	Config json.RawMessage   `json:"config"`
	Env    []corev1.EnvVar   `json:"env"`
	EnvCfg environmentConfig `json:"envConfig"`
}

type packageJobHashInput struct {
	Image    string   `json:"image"`
	Packages []string `json:"packages"`
}

func configHash(opencodeCfg []byte, env []corev1.EnvVar, envCfg environmentConfig) string {
	hashInput, _ := json.Marshal(configHashInput{
		Config: opencodeCfg,
		Env:    env,
		EnvCfg: envCfg,
	})
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum)
}

func packageJobHash(image string, packages []string) string {
	hashInput, _ := json.Marshal(packageJobHashInput{
		Image:    strings.TrimSpace(image),
		Packages: packages,
	})
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum)
}
