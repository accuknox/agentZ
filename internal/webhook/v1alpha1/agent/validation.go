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
	"net"
	"strconv"
	"strings"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-agent,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=vagent-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Agent resources.
//
// +kubebuilder:object:generate=false
type Validator struct{}

var _ admission.Validator[*clawarmorv1alpha1.Agent] = &Validator{}

// NewValidator builds an Agent validator.
func NewValidator() *Validator {
	return &Validator{}
}

// ValidateCreate validates Agent creation.
func (v *Validator) ValidateCreate(_ context.Context, agt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := validateAgent(agt)
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
func (v *Validator) ValidateUpdate(_ context.Context, oldAgt, newAgt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := validateAgent(newAgt)
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
func (v *Validator) ValidateDelete(_ context.Context, _ *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	return nil, nil
}

func validateAgent(agt *clawarmorv1alpha1.Agent) field.ErrorList {
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

	if agt.Spec.EnvironmentRef != nil && strings.TrimSpace(agt.Spec.EnvironmentRef.Name) == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("environmentRef").Child("name"),
			"field is required when environmentRef is set",
		))
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
	historyRatio := agt.Spec.Compaction.HistoryToolResultRatio
	if historyRatio < 0 || historyRatio > 1 {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("historyToolResultRatio"),
			historyRatio,
			"must be between 0 and 1",
		))
	}
	oversizedRatio := agt.Spec.Compaction.OversizedToolResultRatio
	if oversizedRatio < 0.05 || oversizedRatio > 0.1 {
		allErrs = append(allErrs, field.Invalid(
			compactionPath.Child("oversizedToolResultRatio"),
			oversizedRatio,
			"must be between 0.05 and 0.1",
		))
	}
	if historyRatio >= oversizedRatio {
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
