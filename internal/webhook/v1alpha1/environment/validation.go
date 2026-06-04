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

package environment

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

	"github.com/accuknox/clawarmor/internal/envutil"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

var log = logf.Log.WithName("environment-resource")

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-environment,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=envs,verbs=create;update;delete,versions=v1alpha1,name=venvironment-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Environment resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*clawarmorv1alpha1.Environment] = &Validator{}

// NewValidator builds an Environment validator.
func NewValidator(c client.Client) *Validator {
	return &Validator{client: c}
}

// ValidateCreate validates Environment creation.
func (v *Validator) ValidateCreate(ctx context.Context, env *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	return nil, v.validateEnvironment(ctx, env)
}

// ValidateUpdate validates Environment updates.
func (v *Validator) ValidateUpdate(ctx context.Context, _, newEnv *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	return nil, v.validateEnvironment(ctx, newEnv)
}

// ValidateDelete validates Environment deletion.
func (v *Validator) ValidateDelete(ctx context.Context, env *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	log.Info("Validation for Environment upon deletion", "name", env.GetName())
	if v.client == nil {
		return nil, nil
	}

	agentName, err := envutil.ReferencingAgentName(ctx, v.client, env.Namespace, env.Name)
	if err != nil {
		return nil, err
	}
	if agentName == "" {
		return nil, nil
	}

	path := field.NewPath("metadata").Child("name")
	return nil, apierrors.NewInvalid(
		env.GroupVersionKind().GroupKind(),
		env.Name,
		field.ErrorList{field.Forbidden(
			path,
			"environment is referenced by agent "+agentName,
		)},
	)
}

func (v *Validator) validateEnvironment(ctx context.Context, env *clawarmorv1alpha1.Environment) error {
	fields := validateAllowedHostFields(env)
	fields = append(fields, v.validateMCPConnectionRefs(ctx, env)...)
	if len(fields) == 0 {
		return nil
	}

	return apierrors.NewInvalid(env.GroupVersionKind().GroupKind(), env.Name, fields)
}

func validateAllowedHostFields(env *clawarmorv1alpha1.Environment) field.ErrorList {
	fields := field.ErrorList{}
	path := field.NewPath("spec").Child("allowedHosts")
	for i, entry := range env.Spec.AllowedHosts {
		if _, err := envutil.ParseHost(entry); err != nil {
			fields = append(fields, field.Invalid(
				path.Index(i),
				entry,
				fmt.Sprintf("%v", err),
			))
		}
	}
	return fields
}

func (v *Validator) validateMCPConnectionRefs(ctx context.Context, env *clawarmorv1alpha1.Environment) field.ErrorList {
	fields := field.ErrorList{}
	path := field.NewPath("spec").Child("mcpConnectionRefs")
	seen := map[string]int{}

	for i, ref := range env.Spec.MCPConnectionRefs {
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

		conn := &clawarmorv1alpha1.MCPConnection{}
		key := client.ObjectKey{Namespace: env.Namespace, Name: name}
		err := v.client.Get(ctx, key, conn)
		if apierrors.IsNotFound(err) {
			fields = append(fields, field.NotFound(
				path.Index(i).Child("name"),
				name,
			))
			continue
		}
		if err == nil {
			enabledPath := path.Index(i).Child("enabledTools")
			if len(ref.EnabledTools) == 0 {
				fields = append(fields, field.Required(
					enabledPath,
					"at least one enabled tool is required",
				))
				continue
			}
			if !conn.Status.ToolCatalogReady {
				fields = append(fields, field.Forbidden(
					enabledPath,
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
			for toolIndex, rawToolName := range ref.EnabledTools {
				toolName := strings.TrimSpace(rawToolName)
				if toolName == "" {
					fields = append(fields, field.Required(
						enabledPath.Index(toolIndex),
						"field is required",
					))
					continue
				}
				if firstToolIndex, ok := seenTools[toolName]; ok {
					fields = append(fields, field.Duplicate(
						enabledPath.Index(toolIndex),
						fmt.Sprintf("%s (first seen at index %d)", toolName, firstToolIndex),
					))
					continue
				}
				seenTools[toolName] = toolIndex
				if !slices.Contains(toolNames, toolName) {
					fields = append(fields, field.NotSupported(
						enabledPath.Index(toolIndex),
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
