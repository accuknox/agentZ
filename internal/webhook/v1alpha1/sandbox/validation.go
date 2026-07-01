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
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var log = logf.Log.WithName("sandbox-resource")

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-sandbox,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=sandboxes,verbs=create;update;delete,versions=v1alpha1,name=vsandbox-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Sandbox resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*agentzv1alpha1.Sandbox] = &Validator{}

// NewValidator builds an Sandbox validator.
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
	log.Info("Validation for Sandbox upon deletion", "name", sandbox.GetName())
	if v.client == nil {
		return nil, nil
	}

	agentName, err := sandboxutil.ReferencingAgentName(ctx, v.client, sandbox.Namespace, sandbox.Name)
	if err != nil {
		return nil, err
	}
	if agentName == "" {
		return nil, nil
	}

	path := field.NewPath("metadata").Child("name")
	return nil, apierrors.NewInvalid(
		sandbox.GroupVersionKind().GroupKind(),
		sandbox.Name,
		field.ErrorList{field.Forbidden(
			path,
			"sandbox is referenced by agent "+agentName,
		)},
	)
}

func (v *Validator) validateSandbox(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	fields := validateAllowedHostFields(sandbox)
	fields = append(fields, v.validateMCPConnectionRefs(ctx, sandbox)...)
	if len(fields) == 0 {
		return nil
	}

	return apierrors.NewInvalid(sandbox.GroupVersionKind().GroupKind(), sandbox.Name, fields)
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
	seen := map[string]int{}

	for i, ref := range sandbox.Spec.MCPConnectionRefs {
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			fields = append(fields, field.Required(
				path.Index(i).Child("name"),
				"field is required",
			))
			continue
		}

		if first, ok := seen[name]; ok {
			fields = append(fields, field.Duplicate(
				path.Index(i).Child("name"),
				fmt.Sprintf("%s (first seen at index %d)", name, first),
			))
			continue
		}
		seen[name] = i

		if v.client == nil {
			continue
		}

		conn := &agentzv1alpha1.MCPConnection{}
		key := client.ObjectKey{Namespace: sandbox.Namespace, Name: name}
		err := v.client.Get(ctx, key, conn)
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
