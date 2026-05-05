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

package v1alpha1

import (
	"context"
	"net"
	"strconv"
	"strings"

	"github.com/google/uuid"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

// AgentWebhookConfig configures Agent defaulting behavior.
type AgentWebhookConfig struct {
	DefaultImage string
}

// SetupAgentWebhookWithManager registers the webhook for Agent in the manager.
func SetupAgentWebhookWithManager(mgr ctrl.Manager, cfg AgentWebhookConfig) error {
	return ctrl.NewWebhookManagedBy(mgr, &clawarmorv1alpha1.Agent{}).
		WithValidator(&AgentCustomValidator{}).
		WithDefaulter(&AgentCustomDefaulter{
			DefaultImage: cfg.DefaultImage,
		}).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-clawarmor-accuknox-com-v1alpha1-agent,mutating=true,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=magent-v1alpha1.kb.io,admissionReviewVersions=v1

// AgentCustomDefaulter sets default values for Agent resources.
//
// +kubebuilder:object:generate=false
type AgentCustomDefaulter struct {
	DefaultImage string
}

const (
	defaultCompactionThresholdRatio           = 0.9
	defaultCompactionHistoryToolResultRatio   = 0.008
	defaultCompactionKeepRecentRequests       = 2
	defaultCompactionOversizedToolResultRatio = 0.065
	defaultMaxHistoryRuns                     = 50
	defaultTemperature                        = 0.2
)

// Default applies defaults to an Agent resource.
func (d *AgentCustomDefaulter) Default(_ context.Context, agt *clawarmorv1alpha1.Agent) error {
	if agt.Spec.Image == "" {
		agt.Spec.Image = d.DefaultImage
	}
	if agt.Spec.ImagePullPolicy == "" {
		agt.Spec.ImagePullPolicy = corev1.PullIfNotPresent
	}
	if agt.Spec.Compaction.Mode == "" {
		agt.Spec.Compaction.Mode = clawarmorv1alpha1.CompactionModeSummary
	}
	if agt.Spec.Compaction.ThresholdRatio == 0 {
		agt.Spec.Compaction.ThresholdRatio = defaultCompactionThresholdRatio
	}
	if agt.Spec.Compaction.HistoryToolResultRatio == 0 {
		agt.Spec.Compaction.HistoryToolResultRatio = defaultCompactionHistoryToolResultRatio
	}
	if agt.Spec.Compaction.KeepRecentRequests == 0 {
		agt.Spec.Compaction.KeepRecentRequests = defaultCompactionKeepRecentRequests
	}
	if agt.Spec.Compaction.OversizedToolResultRatio == 0 {
		agt.Spec.Compaction.OversizedToolResultRatio = defaultCompactionOversizedToolResultRatio
	}
	if agt.Spec.MaxHistoryRuns == 0 {
		agt.Spec.MaxHistoryRuns = defaultMaxHistoryRuns
	}
	if agt.Spec.Model.Temperature == 0 {
		agt.Spec.Model.Temperature = defaultTemperature
	}
	if agt.Spec.SummaryModel.Temperature == 0 {
		agt.Spec.SummaryModel.Temperature = defaultTemperature
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

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-agent,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=vagent-v1alpha1.kb.io,admissionReviewVersions=v1

// AgentCustomValidator validates Agent resources.
//
// +kubebuilder:object:generate=false
type AgentCustomValidator struct{}

var (
	_ admission.Defaulter[*clawarmorv1alpha1.Agent] = &AgentCustomDefaulter{}
	_ admission.Validator[*clawarmorv1alpha1.Agent] = &AgentCustomValidator{}
)

// ValidateCreate validates Agent creation.
func (v *AgentCustomValidator) ValidateCreate(_ context.Context, agt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := v.validateAgent(agt)
	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		agt.GroupVersionKind().GroupKind(),
		agt.Name,
		allErrs,
	)
}

// ValidateUpdate validates Agent updates.
func (v *AgentCustomValidator) ValidateUpdate(_ context.Context, oldAgt, newAgt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := v.validateAgent(newAgt)
	if oldAgt.Spec.Session.ID != newAgt.Spec.Session.ID {
		path := field.NewPath("spec").Child("session").Child("id")
		allErrs = append(allErrs, field.Invalid(
			path,
			newAgt.Spec.Session.ID,
			"field is immutable",
		))
	}
	if oldAgt.Spec.NixStoreSize.Cmp(newAgt.Spec.NixStoreSize) != 0 {
		path := field.NewPath("spec").Child("nixStoreSize")
		allErrs = append(allErrs, field.Invalid(
			path,
			newAgt.Spec.NixStoreSize.String(),
			"field is immutable",
		))
	}
	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		newAgt.GroupVersionKind().GroupKind(),
		newAgt.Name,
		allErrs,
	)
}

// ValidateDelete validates Agent deletion.
func (v *AgentCustomValidator) ValidateDelete(_ context.Context, _ *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	return nil, nil
}

func (v *AgentCustomValidator) validateAgent(agt *clawarmorv1alpha1.Agent) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")
	sessionPath := specPath.Child("session")
	idPath := sessionPath.Child("id")
	if agt.Spec.Session.ID == "" {
		allErrs = append(allErrs, field.Required(idPath, "field is required"))
	} else {
		id, err := uuid.Parse(agt.Spec.Session.ID)
		if err != nil || id.Version() != 4 {
			allErrs = append(allErrs, field.Invalid(
				idPath,
				agt.Spec.Session.ID,
				"must be a valid UUIDv4",
			))
		}
	}

	serverPath := specPath.Child("server").Child("address")
	_, rawPort, err := net.SplitHostPort(strings.TrimSpace(agt.Spec.Server.Address))
	portInvalid := err != nil
	if err == nil {
		port, parseErr := strconv.ParseInt(rawPort, 10, 32)
		if parseErr != nil || port <= 0 || port > 65535 {
			portInvalid = true
		}
	}
	if portInvalid {
		allErrs = append(allErrs, field.Invalid(
			serverPath,
			agt.Spec.Server.Address,
			"must include a valid TCP port",
		))
	}
	timeoutPath := specPath.Child("server").Child("gracefulShutdownTimeout")
	if agt.Spec.Server.GracefulShutdownTimeout.Duration < 0 {
		allErrs = append(allErrs, field.Invalid(
			timeoutPath,
			agt.Spec.Server.GracefulShutdownTimeout.Duration.String(),
			"must be greater than or equal to zero",
		))
	}

	modelPath := specPath.Child("model").Child("name")
	if strings.TrimSpace(agt.Spec.Model.Name) == "" {
		allErrs = append(allErrs, field.Required(modelPath, "field is required"))
	}
	if agt.Spec.Model.Temperature < 0 || agt.Spec.Model.Temperature > 1 {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("model").Child("temperature"),
			agt.Spec.Model.Temperature,
			"must be between 0 and 1",
		))
	}
	if agt.Spec.Model.ThinkingTokens < 0 {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("model").Child("thinkingTokens"),
			agt.Spec.Model.ThinkingTokens,
			"must be greater than or equal to zero",
		))
	}

	if agt.Spec.Session.Enabled && strings.TrimSpace(agt.Spec.Session.Target) == "" {
		allErrs = append(allErrs, field.Required(
			sessionPath.Child("target"),
			"field is required when session is enabled",
		))
	}

	summaryMode := agt.Spec.Session.Summary.Mode
	if summaryMode != "" && summaryMode != "auto" && summaryMode != "manual" {
		allErrs = append(allErrs, field.NotSupported(
			sessionPath.Child("summary").Child("mode"),
			summaryMode,
			[]string{"auto", "manual"},
		))
	}

	compactionPath := field.NewPath("spec").Child("compaction")
	switch agt.Spec.Compaction.Mode {
	case clawarmorv1alpha1.CompactionModeSummary:
		if strings.TrimSpace(agt.Spec.SummaryModel.Name) == "" {
			allErrs = append(allErrs, field.Required(
				specPath.Child("summaryModel").Child("name"),
				"field is required when compaction.mode is summary",
			))
		}
	case clawarmorv1alpha1.CompactionModeTruncate:
	default:
		allErrs = append(allErrs, field.NotSupported(
			compactionPath.Child("mode"),
			agt.Spec.Compaction.Mode,
			[]string{
				clawarmorv1alpha1.CompactionModeSummary,
				clawarmorv1alpha1.CompactionModeTruncate,
			},
		))
	}
	if agt.Spec.SystemPrompt != "" && len([]rune(agt.Spec.SystemPrompt)) > 4096 {
		allErrs = append(allErrs, field.TooLong(
			specPath.Child("systemPrompt"),
			agt.Spec.SystemPrompt,
			4096,
		))
	}
	if agt.Spec.Compaction.ThresholdRatio < 0.2 || agt.Spec.Compaction.ThresholdRatio > 0.95 {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("thresholdRatio"),
			agt.Spec.Compaction.ThresholdRatio,
			"must be between 0.2 and 0.95",
		))
	}
	if !validRatio(agt.Spec.Compaction.HistoryToolResultRatio) {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("historyToolResultRatio"),
			agt.Spec.Compaction.HistoryToolResultRatio,
			"must be between 0 and 1",
		))
	}
	if agt.Spec.Compaction.OversizedToolResultRatio < 0.05 ||
		agt.Spec.Compaction.OversizedToolResultRatio > 0.1 {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("oversizedToolResultRatio"),
			agt.Spec.Compaction.OversizedToolResultRatio,
			"must be between 0.05 and 0.1",
		))
	}
	historyRatio := agt.Spec.Compaction.HistoryToolResultRatio
	oversizedRatio := agt.Spec.Compaction.OversizedToolResultRatio
	if (historyRatio != 0 || oversizedRatio != 0) && historyRatio >= oversizedRatio {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("historyToolResultRatio"),
			historyRatio,
			"must be less than oversizedToolResultRatio",
		))
	}
	if agt.Spec.SummaryModel.Temperature < 0 || agt.Spec.SummaryModel.Temperature > 1 {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("summaryModel").Child("temperature"),
			agt.Spec.SummaryModel.Temperature,
			"must be between 0 and 1",
		))
	}
	return allErrs
}

func validRatio(v float64) bool {
	return v >= 0 && v <= 1
}
