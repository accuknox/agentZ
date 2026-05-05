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
	"errors"
	"fmt"
	"maps"
	"math"
	"net"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	agentconfig "github.com/accuknox/clawarmor/internal/agent/config"
)

const (
	configKey            = "config.yaml"
	configMountPath      = agentconfig.DefaultHomeDir + "/config.yaml"
	configVolume         = "config"
	sinjectorNameSuffix  = "-sinjector"
	sinjectorCAVolume    = "sinjector-ca"
	sinjectorCAMountPath = "/etc/clawarmor/sinjector-ca"
	sinjectorFinalizer   = "clawarmor.accuknox.com/sinjector"
)

var (
	errImageEmpty  = errors.New("agent image must not be empty")
	errPortInvalid = errors.New("server.address must include a valid port")
)

// RuntimeConfig configures controller-side launch defaults.
type RuntimeConfig struct {
	DefaultImage                   string
	SinjectorImage                 string
	SinjectorListenAddress         string
	ProxyAddress                   string
	OpenBaoAddr                    string
	ManagerOpenBaoAddr             string
	OpenBaoSecretMountPath         string
	SinjectorCASecretName          string
	SinjectorCASecretCertKey       string
	SinjectorCASecretKeyKey        string
	SinjectorCASecretBundleKey     string
	SinjectorCACertPath            string
	SinjectorCAKeyPath             string
	AgentCABundlePath              string
	OpenBaoK8sAuthMountPath        string
	OpenBaoK8sAuthTokenPath        string
	ManagerOpenBaoK8sAuthRole      string
	ManagerOpenBaoK8sAuthTokenPath string
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

func sinjectorPort(cfg RuntimeConfig) (int32, error) {
	return serverPort(cfg.SinjectorListenAddress)
}

func resourceLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, selectorLabels(agt))
	return labels
}

func renderConfig(agt *clawarmorv1alpha1.Agent) ([]byte, error) {
	cfg := *agt.Spec.DeepCopy()
	cfg.Env = nil
	cfg.Server.GracefulShutdownTimeout = metav1.Duration{}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal yaml: %w", err)
	}
	return data, nil
}

func configHash(cfgYAML []byte, env []corev1.EnvVar) (string, error) {
	envYAML, err := yaml.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("marshal env yaml: %w", err)
	}
	sum := sha256.Sum256(append(cfgYAML, envYAML...))
	return fmt.Sprintf("%x", sum), nil
}

func serverPort(addr string) (int32, error) {
	_, rawPort, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return 0, errPortInvalid
	}
	port, err := strconv.ParseInt(rawPort, 10, 32)
	if err != nil || port <= 0 || port > 65535 {
		return 0, errPortInvalid
	}
	return int32(port), nil
}

func gracePeriod(agt *clawarmorv1alpha1.Agent) int64 {
	timeout := agt.Spec.Server.GracefulShutdownTimeout.Duration
	if timeout > 0 {
		return int64(math.Ceil(timeout.Seconds()))
	}
	return 0
}
