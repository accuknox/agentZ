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
	"context"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

const (
	DefaultCompactionThresholdRatio           = 0.9
	DefaultCompactionHistoryToolResultRatio   = 0.008
	DefaultCompactionKeepRecentRequests       = 2
	DefaultCompactionOversizedToolResultRatio = 0.065
	DefaultMaxHistoryRuns                     = 50
	DefaultTemperature                        = 0.2
)

// +kubebuilder:webhook:path=/mutate-clawarmor-accuknox-com-v1alpha1-agent,mutating=true,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=magent-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets default values for Agent resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct {
	agentDefaultImage string
}

var _ admission.Defaulter[*clawarmorv1alpha1.Agent] = &Defaulter{}

// NewDefaulter builds an Agent defaulter.
func NewDefaulter(cfg WebhookConfig) *Defaulter {
	return &Defaulter{agentDefaultImage: cfg.AgentDefaultImage}
}

// Default applies defaults to an Agent resource.
func (d *Defaulter) Default(_ context.Context, agt *clawarmorv1alpha1.Agent) error {
	if agt.Spec.Image == "" {
		agt.Spec.Image = d.agentDefaultImage
	}
	if agt.Spec.ImagePullPolicy == "" {
		agt.Spec.ImagePullPolicy = corev1.PullIfNotPresent
	}
	if agt.Spec.Compaction.Mode == "" {
		agt.Spec.Compaction.Mode = clawarmorv1alpha1.CompactionModeSummary
	}
	if agt.Spec.Compaction.Enabled == nil {
		enabled := true
		agt.Spec.Compaction.Enabled = &enabled
	}
	if agt.Spec.Compaction.ThresholdRatio == 0 {
		agt.Spec.Compaction.ThresholdRatio = DefaultCompactionThresholdRatio
	}
	if agt.Spec.Compaction.HistoryToolResultRatio == 0 {
		agt.Spec.Compaction.HistoryToolResultRatio = DefaultCompactionHistoryToolResultRatio
	}
	if agt.Spec.Compaction.KeepRecentRequests == 0 {
		agt.Spec.Compaction.KeepRecentRequests = DefaultCompactionKeepRecentRequests
	}
	if agt.Spec.Compaction.OversizedToolResultRatio == 0 {
		agt.Spec.Compaction.OversizedToolResultRatio = DefaultCompactionOversizedToolResultRatio
	}
	if agt.Spec.MaxHistoryRuns == 0 {
		agt.Spec.MaxHistoryRuns = DefaultMaxHistoryRuns
	}
	if agt.Spec.Model.Temperature == 0 {
		agt.Spec.Model.Temperature = DefaultTemperature
	}
	if agt.Spec.SummaryModel.Temperature == 0 {
		agt.Spec.SummaryModel.Temperature = DefaultTemperature
	}
	if agt.Spec.Tools.HostExec.Enabled == nil {
		enabled := true
		agt.Spec.Tools.HostExec.Enabled = &enabled
	}
	if agt.Spec.Tools.WebFetch.Enabled == nil {
		enabled := true
		agt.Spec.Tools.WebFetch.Enabled = &enabled
	}
	if agt.Spec.Tools.File.Enabled == nil {
		enabled := false
		agt.Spec.Tools.File.Enabled = &enabled
	}
	if agt.Spec.Tools.Arxiv.Enabled == nil {
		enabled := false
		agt.Spec.Tools.Arxiv.Enabled = &enabled
	}
	if agt.Spec.NixStoreSize.IsZero() {
		agt.Spec.NixStoreSize = resource.MustParse("5Gi")
	}
	return nil
}
