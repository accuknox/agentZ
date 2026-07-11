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
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"

	corev1 "k8s.io/api/core/v1"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	opencodeConfigKey              = "opencode.json"
	immutableSkillsManifestKey     = "immutable-skills.json"
	configVolume                   = "config"
	opencodeConfigDir              = "/etc/agentz/opencode"
	opencodeInstructionPreamble    = "These instructions are part of the agent context and should be followed."
	opencodePhilosophyKey          = "philosophy.md"
	opencodeInstructionKey         = "instruction.md"
	opencodePhilosophyPath         = opencodeConfigDir + "/" + opencodePhilosophyKey
	opencodeInstructionPath        = opencodeConfigDir + "/" + opencodeInstructionKey
	createWorkflowToolName         = "create_workflow"
	createWorkflowScheduleToolName = "create_workflow_schedule"
	listWorkflowSchedulesToolName  = "list_workflow_schedules"
	getWorkflowToolName            = "get_workflow"
	listWorkflowsToolName          = "list_workflows"
	skillToolName                  = "skill"
	listSkillsToolName             = "list_skills"
	deleteWorkflowsToolName        = "delete_workflows"
	deleteWorkflowScheduleToolName = "delete_workflow_schedule"
	setWorkflowRunStatusToolName   = "set_workflowrun_status"
	updateWorkflowScheduleToolName = "update_workflow_schedule"
	nixAgentVolume                 = "nix-agent"
	homeAgentVolume                = "home-agent"
	nixRuntimeStoreVolume          = "nix-runtime-store"
	nixAgentMount                  = "/mnt/nix"
	nixRuntimeStoreMount           = "/nix/store"
	nixRuntimeStageMount           = "/runtime-nix-store"
	nixStoreSubPath                = "nix"
	homeStoreSubPath               = "home"
	immutableSkillsSubPath         = "immutable-skills"
	nixVolumeRootMount             = "/pvc"
	homeVolumeRootMount            = "/pvc-home"
	nixLinkVolume                  = "nix-link"
	nixLinkMount                   = "/tmp/nix-link"
	nixLinkStage                   = "/tmp/nix-link"
	nixInitImage                   = "murtazau/agentz-init:latest"
	homeInitName                   = "home-init"
	agentRuntimeUID                = int64(1000)
	agentRuntimeGID                = int64(1000)
	nixPkgEnv                      = "NIX_PACKAGES"
	packageJobLabelKey             = "agentz.accuknox.com/agent-package-job"
	packageJobNameSuffix           = "-packages"
	packageJobHashAnnotation       = "agentz.accuknox.com/package-job-hash"
	packageJobRootVolume           = "nix-agent-root"
	packageJobSharedVolume         = "nix-shared"
	sinjectorNameSuffix            = "-sinjector"
	sinjectorCAVolume              = "sinjector-ca"
	sinjectorCAMountPath           = "/etc/agentz/sinjector-ca"
	sinjectorFinalizer             = "agentz.accuknox.com/sinjector"
	gatewayRoleNameSuffix          = "-gateway"
	gatewayTokenVolume             = "gateway-token"
	gatewayTokenMountPath          = "/var/run/secrets/agentz/gateway"
	gatewayTokenPath               = gatewayTokenMountPath + "/token"
	egressPolicySuffix             = "-egress"
	opencodeConfigSchema           = "https://opencode.ai/config.json"
	agentHomeDir                   = "/home/agentz"
	opencodeImmutableSkillsPath    = "/var/lib/agentz/skills/immutable"
	opencodeWritableSkillsPath     = agentHomeDir + "/.agents/skills"
	opencodeBundledSkillsPath      = "/etc/opencode/skills/defaults"
	immutableSkillsBucketVolume    = "immutable-skills-bucket"
	immutableSkillsSecretMount     = "/var/run/secrets/agentz/immutable-skills-bucket"
	immutableSkillsInitName        = "immutable-skills-init"
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
	AgentHomeStorageClass            string
	SkillStore                       skill.Config
}

func selectorLabels(agt *agentzv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":      "agentz-agent",
		"app.kubernetes.io/instance":  agt.Name,
		"agentz.accuknox.com/agent":   agt.Name,
		"agentz.accuknox.com/managed": "true",
	}
}

func packageJobLabels(agt *agentzv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	labels["app.kubernetes.io/name"] = "agentz-agent-packages"
	labels["app.kubernetes.io/instance"] = agt.Name
	labels[packageJobLabelKey] = agt.Name
	labels["agentz.accuknox.com/managed"] = "true"
	return labels
}

func packageJobName(agt *agentzv1alpha1.Agent) string {
	return agt.Name + packageJobNameSuffix
}

func sinjectorSelectorLabels(agt *agentzv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":        "agentz-sinjector",
		"app.kubernetes.io/instance":    agt.Name,
		"agentz.accuknox.com/sinjector": agt.Name,
		"agentz.accuknox.com/managed":   "true",
	}
}

func sinjectorLabels(agt *agentzv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, sinjectorSelectorLabels(agt))
	return labels
}

func sinjectorName(agt *agentzv1alpha1.Agent) string {
	return agt.Name + sinjectorNameSuffix
}

func openBaoSinjectorName(agt *agentzv1alpha1.Agent) string {
	name := "sinjector-" + agt.Namespace + "-" + agt.Name
	if len(name) <= 63 {
		return name
	}

	sum := sha256.Sum256([]byte(name))
	suffix := hex.EncodeToString(sum[:])[:10]
	limit := 63 - len("sinjector---") - len(suffix)
	agentLimit := min(len(agt.Name), limit/2)
	if agentLimit < 8 {
		agentLimit = min(len(agt.Name), 8)
	}
	namespaceLimit := limit - agentLimit
	if namespaceLimit < 8 {
		namespaceLimit = 8
		agentLimit = limit - namespaceLimit
	}

	namespace := strings.Trim(agt.Namespace[:min(len(agt.Namespace), namespaceLimit)], "-")
	agent := strings.Trim(agt.Name[:min(len(agt.Name), agentLimit)], "-")
	if namespace == "" {
		namespace = "tenant"
	}
	if agent == "" {
		agent = "agent"
	}
	return "sinjector-" + namespace + "-" + agent + "-" + suffix
}

func egressPolicyName(agt *agentzv1alpha1.Agent) string {
	return agt.Name + egressPolicySuffix
}

func resourceLabels(agt *agentzv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, selectorLabels(agt))
	return labels
}

type opencodeInstructionFile struct {
	Path    string
	Content string
}

func renderOpencodeConfig(agt *agentzv1alpha1.Agent, envCfg sandboxConfig) ([]byte, []opencodeInstructionFile, error) {
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
	instructionFiles := renderOpencodeInstructions(agt.Spec)
	if len(instructionFiles) > 0 {
		cfg.Instructions = make([]string, 0, len(instructionFiles))
		for _, item := range instructionFiles {
			cfg.Instructions = append(cfg.Instructions, item.Path)
		}
	}
	cfg.Skills = &opencodeSkillsFile{
		Paths: []string{
			opencodeBundledSkillsPath,
			opencodeImmutableSkillsPath,
			opencodeWritableSkillsPath,
		},
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
		skillToolName:                  true,
		listSkillsToolName:             true,
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
		return nil, nil, fmt.Errorf("marshal opencode json: %w", err)
	}
	return append(data, '\n'), instructionFiles, nil
}

type opencodeConfigFile struct {
	Schema       string                            `json:"$schema"`
	Model        string                            `json:"model,omitempty"`
	SmallModel   string                            `json:"small_model,omitempty"`
	Instructions []string                          `json:"instructions,omitempty"`
	Skills       *opencodeSkillsFile               `json:"skills,omitempty"`
	Provider     map[string]opencodeProviderFile   `json:"provider,omitempty"`
	MCP          map[string]opencodeMCPRemoteFile  `json:"mcp,omitempty"`
	Permission   map[string]opencodePermissionRule `json:"permission,omitempty"`
	Tools        map[string]bool                   `json:"tools,omitempty"`
}

type opencodeSkillsFile struct {
	Paths []string `json:"paths,omitempty"`
	URLs  []string `json:"urls,omitempty"`
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
	Config                  json.RawMessage       `json:"config"`
	Instructions            []string              `json:"instructions"`
	Env                     []corev1.EnvVar       `json:"env"`
	Packages                []string              `json:"packages"`
	MCPURL                  string                `json:"mcpUrl"`
	MCPConsentPermissionIDs []string              `json:"mcpConsentPermissionIds"`
	MCPRefs                 []mcpRefConfig        `json:"mcpRefs"`
	Skills                  []skill.ManifestSkill `json:"skills"`
}

type packageJobHashInput struct {
	Image    string                `json:"image"`
	Endpoint string                `json:"endpoint"`
	Region   string                `json:"region"`
	Bucket   string                `json:"bucket"`
	Packages []string              `json:"packages"`
	Skills   []skill.ManifestSkill `json:"skills"`
}

func configHash(opencodeCfg []byte, instructionFiles []opencodeInstructionFile, env []corev1.EnvVar, envCfg sandboxConfig) (string, error) {
	instructions := make([]string, 0, len(instructionFiles))
	for _, item := range instructionFiles {
		instructions = append(instructions, item.Path+"\n"+item.Content)
	}

	hashInput, err := json.Marshal(configHashInput{
		Config:                  opencodeCfg,
		Instructions:            instructions,
		Env:                     env,
		Packages:                envCfg.Packages,
		MCPURL:                  envCfg.MCPURL,
		MCPConsentPermissionIDs: envCfg.MCPConsentPermissionIDs,
		MCPRefs:                 envCfg.MCPRefs,
		Skills:                  envCfg.Skills,
	})
	if err != nil {
		return "", fmt.Errorf("marshal agent config hash input: %w", err)
	}
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum), nil
}

func packageJobHash(image string, store skill.Config, envCfg sandboxConfig) (string, error) {
	hashInput, err := json.Marshal(packageJobHashInput{
		Image:    strings.TrimSpace(image),
		Endpoint: store.Endpoint,
		Region:   store.Region,
		Bucket:   store.Bucket,
		Packages: envCfg.Packages,
		Skills:   envCfg.Skills,
	})
	if err != nil {
		return "", fmt.Errorf("marshal package job hash input: %w", err)
	}
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum), nil
}

func renderOpencodeInstructions(spec agentzv1alpha1.AgentSpec) []opencodeInstructionFile {
	files := []opencodeInstructionFile{{
		Path:    opencodePhilosophyPath,
		Content: renderInstructionFile(agentPhilosophy),
	}}

	if instruction := strings.TrimSpace(spec.Instruction); instruction != "" {
		files = append(files, opencodeInstructionFile{
			Path:    opencodeInstructionPath,
			Content: renderInstructionFile(instruction),
		})
	}

	return files
}

func renderInstructionFile(body string) string {
	text := strings.TrimSpace(body)
	if text == "" {
		return ""
	}

	return opencodeInstructionPreamble + "\n\n" + text
}
