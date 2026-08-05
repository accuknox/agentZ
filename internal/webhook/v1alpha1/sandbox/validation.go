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

package sandbox

import (
	"context"
	"fmt"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-sandbox,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=sandboxes,verbs=create;update;delete,versions=v1alpha1,name=vsandbox-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Sandbox resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*agentzv1alpha1.Sandbox] = &Validator{}

// NewValidator builds a Sandbox validator.
func NewValidator(c client.Client) *Validator {
	return &Validator{client: c}
}

// ValidateCreate validates Sandbox creation.
func (v *Validator) ValidateCreate(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) (admission.Warnings, error) {
	return nil, v.validateSandbox(ctx, sandbox)
}

// ValidateUpdate validates Sandbox updates.
func (v *Validator) ValidateUpdate(ctx context.Context, _, newSandbox *agentzv1alpha1.Sandbox) (admission.Warnings, error) {
	return nil, v.validateSandbox(ctx, newSandbox)
}

// ValidateDelete validates Sandbox deletion.
func (v *Validator) ValidateDelete(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) (admission.Warnings, error) {
	if v.client == nil {
		return nil, nil
	}

	agentNames, err := sandboxutil.ReferencingAgentNames(ctx, v.client, sandbox.Namespace, sandbox.Name)
	if err != nil {
		return nil, err
	}
	if len(agentNames) == 0 {
		return nil, nil
	}

	path := field.NewPath("metadata").Child("name")
	return nil, apierrors.NewInvalid(
		sandbox.GroupVersionKind().GroupKind(),
		sandbox.Name,
		field.ErrorList{field.Forbidden(
			path,
			"sandbox is referenced by agent "+agentNames[0],
		)},
	)
}

func (v *Validator) validateSandbox(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	fields := validateAllowedHostFields(sandbox)
	fields = append(fields, v.validateMCPConnectionRefs(ctx, sandbox)...)
	fields = append(fields, v.validateInference(ctx, sandbox)...)
	for i, ref := range sandbox.Spec.Skills {
		if ref.Scope != agentzv1alpha1.ResourceScopeWorkspace {
			continue
		}
		fields = append(fields, field.NotSupported(
			field.NewPath("spec").Child("skills").Index(i).Child("scope"),
			ref.Scope,
			[]string{string(agentzv1alpha1.ResourceScopeOrganisation)},
		))
	}
	if len(fields) == 0 {
		return nil
	}

	return apierrors.NewInvalid(sandbox.GroupVersionKind().GroupKind(), sandbox.Name, fields)
}

func (v *Validator) validateInference(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) field.ErrorList {
	fields := field.ErrorList{}
	path := field.NewPath("spec").Child("inference")
	if len(sandbox.Spec.Inference.Models) == 0 {
		return append(fields, field.Required(path.Child("models"), "at least one model is required"))
	}

	allowed := make(map[agentzv1alpha1.InferenceModelRef]struct{}, len(sandbox.Spec.Inference.Models))
	byProvider := make(map[string][]string, len(sandbox.Spec.Inference.Models))
	pools := map[string]struct{}{}
	for i, model := range sandbox.Spec.Inference.Models {
		if model.Scope == agentzv1alpha1.ResourceScopeWorkspace {
			fields = append(fields, field.NotSupported(
				path.Child("models").Index(i).Child("scope"),
				model.Scope,
				[]string{string(agentzv1alpha1.ResourceScopeOrganisation)},
			))
		}
		if strings.TrimSpace(model.Provider) == "" {
			fields = append(fields, field.Required(path.Child("models").Index(i).Child("provider"), "field is required"))
		}
		if strings.TrimSpace(model.Model) == "" {
			fields = append(fields, field.Required(path.Child("models").Index(i).Child("model"), "field is required"))
		}
		if _, exists := allowed[model]; exists {
			fields = append(fields, field.Duplicate(path.Child("models").Index(i), model))
			continue
		}
		allowed[model] = struct{}{}
		if model.Provider == agentzv1alpha1.InferencePoolProvider {
			pools[model.Model] = struct{}{}
			continue
		}
		byProvider[model.Provider] = append(byProvider[model.Provider], model.Model)
	}

	if _, exists := allowed[sandbox.Spec.Inference.DefaultModel]; !exists {
		fields = append(fields, field.Invalid(
			path.Child("defaultModel"), sandbox.Spec.Inference.DefaultModel,
			"must belong to the model allowlist",
		))
	}
	if sandbox.Spec.Inference.SmallModel != nil {
		if _, exists := allowed[*sandbox.Spec.Inference.SmallModel]; !exists {
			fields = append(fields, field.Invalid(
				path.Child("smallModel"), sandbox.Spec.Inference.SmallModel,
				"must belong to the model allowlist",
			))
		}
	}
	if v.client == nil {
		return fields
	}
	for poolID := range pools {
		pool := &agentzv1alpha1.InferencePool{}
		key := client.ObjectKey{Namespace: sandbox.Namespace, Name: poolID}
		err := v.client.Get(ctx, key, pool)
		if apierrors.IsNotFound(err) {
			fields = append(fields, field.NotFound(path.Child("models"), poolID))
			continue
		}
		if err != nil {
			fields = append(fields, field.InternalError(
				path.Child("models"), fmt.Errorf("get inference pool %q: %w", poolID, err),
			))
			continue
		}
		if !pool.DeletionTimestamp.IsZero() {
			fields = append(fields, field.Forbidden(
				path.Child("models"), fmt.Sprintf("pool %q is terminating", poolID),
			))
		}
	}

	for providerID, modelIDs := range byProvider {
		provider := &agentzv1alpha1.InferenceProvider{}
		key := client.ObjectKey{Namespace: sandbox.Namespace, Name: providerID}
		err := v.client.Get(ctx, key, provider)
		if apierrors.IsNotFound(err) {
			fields = append(fields, field.NotFound(path.Child("models"), providerID))
			continue
		}
		if err != nil {
			fields = append(fields, field.InternalError(
				path.Child("models"), fmt.Errorf("get inference provider %q: %w", providerID, err),
			))
			continue
		}
		if !provider.DeletionTimestamp.IsZero() {
			fields = append(fields, field.Forbidden(
				path.Child("models"), fmt.Sprintf("provider %q is terminating", providerID),
			))
			continue
		}
		enabled := make(map[string]struct{}, len(provider.Spec.Models))
		for _, model := range provider.Spec.Models {
			enabled[model.ID] = struct{}{}
		}
		for _, modelID := range modelIDs {
			if _, exists := enabled[modelID]; exists {
				continue
			}
			fields = append(fields, field.NotFound(
				path.Child("models"), providerID+"/"+modelID,
			))
		}
	}
	return fields
}

func validateAllowedHostFields(sandbox *agentzv1alpha1.Sandbox) field.ErrorList {
	fields := field.ErrorList{}
	path := field.NewPath("spec").Child("allowedHosts")
	for i, entry := range sandbox.Spec.AllowedHosts {
		if _, err := sandboxutil.ParseHost(entry); err != nil {
			fields = append(fields, field.Invalid(
				path.Index(i),
				entry,
				fmt.Sprintf("%v", err),
			))
		}
	}
	return fields
}

func (v *Validator) validateMCPConnectionRefs(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) field.ErrorList {
	fields := field.ErrorList{}
	path := field.NewPath("spec").Child("mcpConnectionRefs")
	seen := map[agentzv1alpha1.ResourceReference]int{}

	for i, ref := range sandbox.Spec.MCPConnectionRefs {
		if ref.Scope == agentzv1alpha1.ResourceScopeWorkspace {
			fields = append(fields, field.NotSupported(
				path.Index(i).Child("scope"),
				ref.Scope,
				[]string{string(agentzv1alpha1.ResourceScopeOrganisation)},
			))
		}
		name := ref.Name
		if name == "" {
			fields = append(fields, field.Required(
				path.Index(i).Child("name"),
				"field is required",
			))
			continue
		}

		key := agentzv1alpha1.ResourceReference{Scope: ref.Scope, Name: name}
		if first, ok := seen[key]; ok {
			fields = append(fields, field.Duplicate(
				path.Index(i).Child("name"),
				fmt.Sprintf("%s (first seen at index %d)", name, first),
			))
			continue
		}
		seen[key] = i

		if v.client == nil {
			continue
		}

		conn := &agentzv1alpha1.MCPConnection{}
		objKey := client.ObjectKey{Namespace: sandbox.Namespace, Name: name}
		err := v.client.Get(ctx, objKey, conn)
		if apierrors.IsNotFound(err) {
			fields = append(fields, field.NotFound(
				path.Index(i).Child("name"),
				name,
			))
			continue
		}
		if err == nil {
			toolsPath := path.Index(i).Child("tools")
			if len(ref.Tools) == 0 {
				fields = append(fields, field.Required(
					toolsPath,
					"at least one tool is required",
				))
				continue
			}
			if !conn.Status.ToolCatalogReady {
				fields = append(fields, field.Forbidden(
					toolsPath,
					fmt.Sprintf("mcp connection %q tool catalog is not ready", name),
				))
				continue
			}

			toolNames := make([]string, 0, len(conn.Status.Tools))
			for _, tool := range conn.Status.Tools {
				toolName := strings.TrimSpace(tool.Name)
				if toolName == "" {
					continue
				}
				toolNames = append(toolNames, toolName)
			}
			slices.Sort(toolNames)

			seenTools := map[string]int{}
			for toolIndex, tool := range ref.Tools {
				toolName := strings.TrimSpace(tool.Name)
				if toolName == "" {
					fields = append(fields, field.Required(
						toolsPath.Index(toolIndex).Child("name"),
						"field is required",
					))
					continue
				}
				if firstToolIndex, ok := seenTools[toolName]; ok {
					fields = append(fields, field.Duplicate(
						toolsPath.Index(toolIndex).Child("name"),
						fmt.Sprintf("%s (first seen at index %d)", toolName, firstToolIndex),
					))
					continue
				}
				seenTools[toolName] = toolIndex
				if !slices.Contains(toolNames, toolName) {
					fields = append(fields, field.NotSupported(
						toolsPath.Index(toolIndex).Child("name"),
						toolName,
						toolNames,
					))
				}
			}
			continue
		}
		fields = append(fields, field.InternalError(
			path.Index(i).Child("name"),
			fmt.Errorf("get mcpconnection %q: %w", name, err),
		))
	}

	return fields
}
