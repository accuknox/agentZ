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

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	opencodeConfigKey       = "opencode.json"
	opencodeInstructionKey  = "instruction.md"
	configVolume            = "config"
	opencodeConfigDir       = "/etc/clawarmor/opencode"
	opencodeInstructionPath = "/etc/clawarmor/opencode/instruction.md"
	createWorkflowToolName  = "create_workflow"
	getWorkflowToolName     = "get_workflow"
	listWorkflowsToolName   = "list_workflows"
	deleteWorkflowsToolName = "delete_workflows"
	nixAgentVolume          = "nix-agent"
	nixRuntimeStoreVolume   = "nix-runtime-store"
	nixAgentMount           = "/mnt/nix"
	nixRuntimeStoreMount    = "/nix/store"
	nixRuntimeStageMount    = "/runtime-nix-store"
	nixHomeSubPath          = "home"
	nixStoreSubPath         = "nix"
	nixVolumeRootMount      = "/pvc"
	nixLinkVolume           = "nix-link"
	nixLinkMount            = "/tmp/nix-link"
	nixLinkStage            = "/tmp/nix-link"
	nixInitImage            = "murtazau/clawarmor-init:latest"
	homeInitName            = "home-init"
	nixPkgEnv               = "NIX_PACKAGES"
	sinjectorNameSuffix     = "-sinjector"
	sinjectorCAVolume       = "sinjector-ca"
	sinjectorCAMountPath    = "/etc/clawarmor/sinjector-ca"
	sinjectorFinalizer      = "clawarmor.accuknox.com/sinjector"
	egressPolicySuffix      = "-egress"
	opencodeConfigSchema    = "https://opencode.ai/config.json"
)

var errImageEmpty = errors.New("agent image must not be empty")

// RuntimeConfig configures controller-side launch defaults.
type RuntimeConfig struct {
	AgentDefaultImage                string
	GatewayURL                       string
	SharedNixPVC                     string
	AgentInitImage                   string
	SinjectorImage                   string
	OpenBaoAddr                      string
	ManagerOpenBaoAddr               string
	OpenBaoSecretMountPath           string
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
}

func selectorLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":         "clawarmor-agent",
		"app.kubernetes.io/instance":     agt.Name,
		"clawarmor.accuknox.com/agent":   agt.Name,
		"clawarmor.accuknox.com/managed": "true",
	}
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

func renderOpencodeConfig(agt *clawarmorv1alpha1.Agent) ([]byte, string, error) {
	cfg := opencodeConfigFile{
		Schema: opencodeConfigSchema,
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
		createWorkflowToolName:  true,
		getWorkflowToolName:     true,
		listWorkflowsToolName:   true,
		deleteWorkflowsToolName: true,
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, "", fmt.Errorf("marshal opencode json: %w", err)
	}
	return append(data, '\n'), instruction, nil
}

type opencodeConfigFile struct {
	Schema       string                          `json:"$schema"`
	Model        string                          `json:"model,omitempty"`
	SmallModel   string                          `json:"small_model,omitempty"`
	Instructions []string                        `json:"instructions,omitempty"`
	Provider     map[string]opencodeProviderFile `json:"provider,omitempty"`
	Tools        map[string]bool                 `json:"tools,omitempty"`
}

type opencodeProviderFile struct {
	Env     []string                     `json:"env,omitempty"`
	Options *opencodeProviderOptionsFile `json:"options,omitempty"`
}

type opencodeProviderOptionsFile struct {
	BaseURL string `json:"baseURL,omitempty"`
}

type configHashInput struct {
	Config   json.RawMessage `json:"config"`
	Env      []corev1.EnvVar `json:"env"`
	Packages []string        `json:"packages"`
}

func configHash(opencodeCfg []byte, env []corev1.EnvVar, packages []string) string {
	hashInput, _ := json.Marshal(configHashInput{
		Config:   opencodeCfg,
		Env:      env,
		Packages: packages,
	})
	sum := sha256.Sum256(hashInput)
	return fmt.Sprintf("%x", sum)
}
