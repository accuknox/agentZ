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
	"slices"
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
	memoryToolName                 = "memory"
	journalToolName                = "journal"
	deleteWorkflowsToolName        = "delete_workflows"
	deleteWorkflowScheduleToolName = "delete_workflow_schedule"
	setWorkflowRunStatusToolName   = "set_workflowrun_status"
	updateWorkflowScheduleToolName = "update_workflow_schedule"
	nixAgentVolume                 = "nix-agent"
	nixRuntimeStoreVolume          = "nix-runtime-store"
	nixAgentMount                  = "/mnt/nix"
	nixRuntimeStoreMount           = "/nix/store"
	nixRuntimeStageMount           = "/runtime-nix-store"
	nixStoreSubPath                = "nix"
	homeStoreSubPath               = "home"
	immutableSkillsSubPath         = "immutable-skills"
	nixVolumeRootMount             = "/pvc"
	nixLinkVolume                  = "nix-link"
	nixLinkMount                   = "/tmp/nix-link"
	nixLinkStage                   = "/tmp/nix-link"
	nixInitImage                   = "murtazau/agentz-init:latest"
	homeInitName                   = "home-init"
	agentRuntimeUID                = int64(1000)
	agentRuntimeGID                = int64(1000)
	nixPkgEnv                      = "NIX_PACKAGES"
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
	filesystemContainerName        = "filesystem"
	filesystemTempVolume           = "filesystem-tmp"
	filesystemPort                 = int32(4097)
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
	NixCacheEndpoint                 string
	AgentInitImage                   string
	OpenBaoAddr                      string
	ManagerOpenBaoAddr               string
	OpenBaoSecretMountPath           string
	ControllerImage                  string
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
	labels[agentzv1alpha1.AgentPackageJobLabel] = agt.Name
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
	agent := opencodeAgentFile{
		Prompt: "{file:" + opencodePhilosophyPath + "}",
		Permission: opencodeAgentPermissionFile{
			Skill: map[string]opencodePermissionRule{
				"customize-opencode": "deny",
			},
		},
	}
	cfg := opencodeConfigFile{
		Schema: opencodeConfigSchema,
		Agent: map[string]opencodeAgentFile{
			"build":   agent,
			"general": agent,
			"plan":    agent,
		},
		Permission: map[string]opencodePermissionRule{
			"*": "allow",
		},
	}
	cfg.Model = envCfg.Model
	cfg.SmallModel = envCfg.SmallModel
	instructionFiles, err := renderOpencodeInstructions(agt)
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(agt.Spec.Instruction) != "" {
		cfg.Instructions = []string{opencodeInstructionPath}
	}
	cfg.Skills = &opencodeSkillsFile{
		Paths: []string{
			opencodeBundledSkillsPath,
			opencodeImmutableSkillsPath,
			opencodeWritableSkillsPath,
		},
	}
	cfg.Provider = envCfg.Providers
	cfg.EnabledProviders = make([]string, 0, len(envCfg.Providers))
	for provider := range envCfg.Providers {
		cfg.EnabledProviders = append(cfg.EnabledProviders, provider)
	}
	slices.Sort(cfg.EnabledProviders)
	cfg.Tools = map[string]bool{
		createWorkflowToolName:         true,
		createWorkflowScheduleToolName: true,
		listWorkflowSchedulesToolName:  true,
		getWorkflowToolName:            true,
		listWorkflowsToolName:          true,
		skillToolName:                  true,
		listSkillsToolName:             true,
		memoryToolName:                 agt.Spec.Memory.Enabled,
		journalToolName:                agt.Spec.Memory.Enabled,
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
	Schema           string                            `json:"$schema"`
	Model            string                            `json:"model,omitempty"`
	SmallModel       string                            `json:"small_model,omitempty"`
	Agent            map[string]opencodeAgentFile      `json:"agent,omitempty"`
	Instructions     []string                          `json:"instructions,omitempty"`
	Skills           *opencodeSkillsFile               `json:"skills,omitempty"`
	Provider         map[string]*opencodeProviderFile  `json:"provider,omitempty"`
	EnabledProviders []string                          `json:"enabled_providers,omitempty"`
	MCP              map[string]opencodeMCPRemoteFile  `json:"mcp,omitempty"`
	Permission       map[string]opencodePermissionRule `json:"permission,omitempty"`
	Tools            map[string]bool                   `json:"tools,omitempty"`
}

type opencodeAgentFile struct {
	Prompt     string                      `json:"prompt"`
	Permission opencodeAgentPermissionFile `json:"permission"`
}

type opencodeAgentPermissionFile struct {
	Skill map[string]opencodePermissionRule `json:"skill"`
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
	Name    string                       `json:"name,omitempty"`
	NPM     string                       `json:"npm,omitempty"`
	Models  map[string]opencodeModelFile `json:"models,omitempty"`
	Options *opencodeProviderOptionsFile `json:"options,omitempty"`
}

type opencodeModelFile struct {
	ID          string                      `json:"id,omitempty"`
	Name        string                      `json:"name,omitempty"`
	Attachment  bool                        `json:"attachment"`
	Reasoning   bool                        `json:"reasoning"`
	Temperature bool                        `json:"temperature"`
	ToolCall    bool                        `json:"tool_call"`
	Limit       opencodeModelLimitFile      `json:"limit"`
	Modalities  opencodeModelModalitiesFile `json:"modalities"`
	Provider    *opencodeModelProviderFile  `json:"provider,omitempty"`
}

type opencodeModelProviderFile struct {
	NPM string `json:"npm"`
	API string `json:"api"`
}

type opencodeModelLimitFile struct {
	Context int32  `json:"context"`
	Input   *int32 `json:"input,omitempty"`
	Output  int32  `json:"output"`
}

type opencodeModelModalitiesFile struct {
	Input  []agentzv1alpha1.InferenceModelModality `json:"input"`
	Output []agentzv1alpha1.InferenceModelModality `json:"output"`
}

type opencodeProviderOptionsFile struct {
	BaseURL string `json:"baseURL,omitempty"`
	APIKey  string `json:"apiKey,omitempty"`
}

type configHashInput struct {
	Config                   json.RawMessage       `json:"config"`
	Instructions             []string              `json:"instructions"`
	Env                      []corev1.EnvVar       `json:"env"`
	Packages                 []string              `json:"packages"`
	MCPURL                   string                `json:"mcpUrl"`
	MCPConsentPermissionIDs  []string              `json:"mcpConsentPermissionIds"`
	MCPRefs                  []mcpRefConfig        `json:"mcpRefs"`
	Skills                   []skill.ManifestSkill `json:"skills"`
	OpenAICodexProviderIDs   []string              `json:"openAICodexProviderIds"`
	OpenAICodexPoolIDs       []string              `json:"openAICodexPoolIds"`
	GitHubCopilotProviderIDs []string              `json:"githubCopilotProviderIds"`
	GitHubCopilotPoolIDs     []string              `json:"githubCopilotPoolIds"`
}

type packageJobHashInput struct {
	Image            string                `json:"image"`
	NixCacheEndpoint string                `json:"nixCacheEndpoint"`
	S3Endpoint       string                `json:"s3Endpoint"`
	Region           string                `json:"region"`
	Bucket           string                `json:"bucket"`
	Packages         []string              `json:"packages"`
	Skills           []skill.ManifestSkill `json:"skills"`
}

func configHash(opencodeCfg []byte, instructionFiles []opencodeInstructionFile, env []corev1.EnvVar, envCfg sandboxConfig) (string, error) {
	instructions := make([]string, 0, len(instructionFiles))
	for _, item := range instructionFiles {
		instructions = append(instructions, item.Path+"\n"+item.Content)
	}

	hashInput, err := json.Marshal(configHashInput{
		Config:                   opencodeCfg,
		Instructions:             instructions,
		Env:                      env,
		Packages:                 envCfg.Packages,
		MCPURL:                   envCfg.MCPURL,
		MCPConsentPermissionIDs:  envCfg.MCPConsentPermissionIDs,
		MCPRefs:                  envCfg.MCPRefs,
		Skills:                   envCfg.Skills,
		OpenAICodexProviderIDs:   envCfg.OpenAICodexProviderIDs,
		OpenAICodexPoolIDs:       envCfg.OpenAICodexPoolIDs,
		GitHubCopilotProviderIDs: envCfg.GitHubCopilotProviderIDs,
		GitHubCopilotPoolIDs:     envCfg.GitHubCopilotPoolIDs,
	})
	if err != nil {
		return "", fmt.Errorf("marshal agent config hash input: %w", err)
	}
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum), nil
}

func packageJobHash(image, nixCacheEndpoint string, store skill.Config, envCfg sandboxConfig) (string, error) {
	hashInput, err := json.Marshal(packageJobHashInput{
		Image:            strings.TrimSpace(image),
		NixCacheEndpoint: nixCacheEndpoint,
		S3Endpoint:       store.Endpoint,
		Region:           store.Region,
		Bucket:           store.Bucket,
		Packages:         envCfg.Packages,
		Skills:           envCfg.Skills,
	})
	if err != nil {
		return "", fmt.Errorf("marshal package job hash input: %w", err)
	}
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum), nil
}

func renderOpencodeInstructions(agt *agentzv1alpha1.Agent) ([]opencodeInstructionFile, error) {
	var philosophy strings.Builder
	err := philosophyTemplate.Execute(
		&philosophy,
		philosophyData{
			AgentName: agt.Name,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("render agent philosophy: %w", err)
	}

	files := []opencodeInstructionFile{{
		Path:    opencodePhilosophyPath,
		Content: strings.TrimSpace(philosophy.String()),
	}}

	if instruction := strings.TrimSpace(agt.Spec.Instruction); instruction != "" {
		files = append(
			files,
			opencodeInstructionFile{
				Path:    opencodeInstructionPath,
				Content: opencodeInstructionPreamble + "\n\n" + instruction,
			},
		)
	}

	return files, nil
}
