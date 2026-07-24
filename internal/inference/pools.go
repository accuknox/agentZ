package inference

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	// PoolLabel identifies resources owned by an InferencePool.
	PoolLabel = "agentz.accuknox.com/inference-pool"
	// PoolByProviderIndex indexes Pools by referenced provider ID.
	PoolByProviderIndex = "spec.members.provider"
	// SandboxByPoolIndex indexes Sandboxes by referenced Pool ID.
	SandboxByPoolIndex = "spec.inference.models.pool"
)

// ResolvedPoolMember binds one Pool reference to its typed Provider and model.
type ResolvedPoolMember struct {
	Ref      agentzv1alpha1.InferencePoolMember
	Provider *agentzv1alpha1.InferenceProvider
	Model    agentzv1alpha1.InferenceModel
	API      agentzv1alpha1.InferenceModelAPI
	Protocol agentzv1alpha1.InferenceProtocol
	Section  gwv1.SectionName
}

// PoolDefinition contains the validated, derived Pool configuration consumed
// by reconciliation, gateway reads, and Agent configuration rendering.
type PoolDefinition struct {
	Contract agentzv1alpha1.InferencePoolContract
	Protocol agentzv1alpha1.InferenceProtocol
	Warnings []agentzv1alpha1.InferencePoolWarning
	Members  []ResolvedPoolMember
}

// ResolvePool validates references and derives the conservative Pool contract.
func ResolvePool(ctx context.Context, reader client.Reader, pool *agentzv1alpha1.InferencePool) (PoolDefinition, []Issue, error) {
	issues := []Issue{}
	if len(pool.Spec.Members) < 1 {
		return PoolDefinition{}, []Issue{{
			Field: "members", Message: "at least one member is required",
		}}, nil
	}
	if len(pool.Spec.Members) > 8 {
		return PoolDefinition{}, []Issue{{
			Field:   "members",
			Message: "at most eight members are allowed",
		}}, nil
	}
	resolved := make([]ResolvedPoolMember, 0, len(pool.Spec.Members))
	seen := make(map[agentzv1alpha1.InferencePoolMember]struct{}, len(pool.Spec.Members))
	providers := make(map[string]*agentzv1alpha1.InferenceProvider, len(pool.Spec.Members))
	for i, ref := range pool.Spec.Members {
		field := fmt.Sprintf("members.%d", i)
		if _, exists := seen[ref]; exists {
			issues = append(issues, Issue{
				Field:   field,
				Message: "provider-model pair is duplicated",
			})
			continue
		}
		seen[ref] = struct{}{}

		provider := providers[ref.Provider]
		if provider == nil {
			provider = &agentzv1alpha1.InferenceProvider{}
			err := reader.Get(ctx, types.NamespacedName{
				Namespace: pool.Namespace,
				Name:      ref.Provider,
			}, provider)
			if apierrors.IsNotFound(err) {
				issues = append(issues, Issue{
					Field:   field + ".provider",
					Message: "provider does not exist",
				})
				continue
			}
			if err != nil {
				return PoolDefinition{}, nil, fmt.Errorf("get inference provider %q: %w", ref.Provider, err)
			}
			providers[ref.Provider] = provider
		}

		var model *agentzv1alpha1.InferenceModel
		for j := range provider.Spec.Models {
			if provider.Spec.Models[j].ID == ref.Model {
				model = &provider.Spec.Models[j]
				break
			}
		}
		if model == nil {
			issues = append(issues, Issue{
				Field:   field + ".model",
				Message: "model is not enabled by provider",
			})
			continue
		}
		if !slices.Contains(model.Modalities.Input, agentzv1alpha1.InferenceModelModalityText) {
			issues = append(issues, Issue{
				Field:   field + ".model",
				Message: "model must support text input",
			})
		}
		if !slices.Contains(model.Modalities.Output, agentzv1alpha1.InferenceModelModalityText) {
			issues = append(issues, Issue{
				Field:   field + ".model",
				Message: "model must support text output",
			})
		}
		sum := sha256.Sum256([]byte(ref.Provider + "\x00" + ref.Model))
		section := fmt.Sprintf("p%d-%s-%s", i+1, ref.Provider, hex.EncodeToString(sum[:5]))
		resolved = append(resolved, ResolvedPoolMember{
			Ref:      ref,
			Provider: provider,
			Model:    *model,
			API:      ProviderAPI(provider.Spec.Kind, *model),
			Protocol: ProviderProtocol(provider.Spec.Kind, *model),
			Section:  gwv1.SectionName(section),
		})
	}
	if len(issues) > 0 || len(resolved) == 0 {
		return PoolDefinition{Members: resolved}, issues, nil
	}

	first := resolved[0]
	contract := agentzv1alpha1.InferencePoolContract{
		API:          first.API,
		Capabilities: first.Model.Capabilities,
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input:  slices.Clone(first.Model.Modalities.Input),
			Output: slices.Clone(first.Model.Modalities.Output),
		},
		Limits: first.Model.Limits,
	}
	input := first.Model.Limits.Context
	if first.Model.Limits.Input != nil {
		input = *first.Model.Limits.Input
	}
	for i, member := range resolved[1:] {
		if !SupportsPoolAPI(first.API, member.API) {
			issues = append(issues, Issue{
				Field:   fmt.Sprintf("members.%d.model", i+1),
				Message: "These models cannot be used together. Choose a different model combination.",
			})
			continue
		}
		contract.Capabilities.Attachment = contract.Capabilities.Attachment && member.Model.Capabilities.Attachment
		contract.Capabilities.Reasoning = contract.Capabilities.Reasoning && member.Model.Capabilities.Reasoning
		contract.Capabilities.Temperature = contract.Capabilities.Temperature && member.Model.Capabilities.Temperature
		contract.Capabilities.ToolCall = contract.Capabilities.ToolCall && member.Model.Capabilities.ToolCall
		contract.Modalities.Input = modalityIntersection(contract.Modalities.Input, member.Model.Modalities.Input)
		contract.Modalities.Output = modalityIntersection(contract.Modalities.Output, member.Model.Modalities.Output)
		contract.Limits.Context = min(contract.Limits.Context, member.Model.Limits.Context)
		contract.Limits.Output = min(contract.Limits.Output, member.Model.Limits.Output)
		memberInput := member.Model.Limits.Context
		if member.Model.Limits.Input != nil {
			memberInput = *member.Model.Limits.Input
		}
		input = min(input, memberInput)
	}
	if len(issues) > 0 {
		return PoolDefinition{Members: resolved}, issues, nil
	}
	contract.Limits.Input = &input
	warnings := []agentzv1alpha1.InferencePoolWarning{}
	for _, member := range resolved[1:] {
		if member.Protocol == first.Protocol {
			continue
		}
		warnings = append(warnings, agentzv1alpha1.InferencePoolWarning{
			Code:    agentzv1alpha1.InferencePoolWarningMixedProtocols,
			Message: "cross-family fallback may lose provider-specific fields, reasoning controls, structured-output details, and Anthropic cache annotations",
		})
		break
	}
	return PoolDefinition{
		Contract: contract,
		Protocol: first.Protocol,
		Warnings: warnings,
		Members:  resolved,
	}, nil, nil
}

// ProviderAPI returns the native request format used by a provider model.
func ProviderAPI(kind agentzv1alpha1.InferenceProviderKind, model agentzv1alpha1.InferenceModel) agentzv1alpha1.InferenceModelAPI {
	if model.API != nil {
		return *model.API
	}
	switch kind {
	case agentzv1alpha1.InferenceProviderKindAnthropic,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		return agentzv1alpha1.InferenceModelAPIMessages
	default:
		return agentzv1alpha1.InferenceModelAPIChatCompletions
	}
}

// SupportsPoolAPI reports whether AgentGateway can translate the Pool request
// format to a member's native format.
func SupportsPoolAPI(poolAPI, memberAPI agentzv1alpha1.InferenceModelAPI) bool {
	if poolAPI == memberAPI {
		return true
	}
	switch poolAPI {
	case agentzv1alpha1.InferenceModelAPIChatCompletions:
		return memberAPI == agentzv1alpha1.InferenceModelAPIMessages
	case agentzv1alpha1.InferenceModelAPIResponses:
		return memberAPI == agentzv1alpha1.InferenceModelAPIChatCompletions
	case agentzv1alpha1.InferenceModelAPIMessages:
		return memberAPI == agentzv1alpha1.InferenceModelAPIChatCompletions
	default:
		return false
	}
}

// ProviderProtocol returns the request family used by a provider kind.
func ProviderProtocol(kind agentzv1alpha1.InferenceProviderKind, model agentzv1alpha1.InferenceModel) agentzv1alpha1.InferenceProtocol {
	if model.API != nil && *model.API == agentzv1alpha1.InferenceModelAPIMessages {
		return agentzv1alpha1.InferenceProtocolAnthropic
	}
	switch kind {
	case agentzv1alpha1.InferenceProviderKindAnthropic,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		return agentzv1alpha1.InferenceProtocolAnthropic
	default:
		return agentzv1alpha1.InferenceProtocolOpenAI
	}
}

// RenderPoolBackend composes one ordered AgentGateway priority group per Pool
// member. Passive eviction changes only subsequent request selection.
func RenderPoolBackend(pool *agentzv1alpha1.InferencePool, definition PoolDefinition) (*agentgatewayv1alpha1.AgentgatewayBackend, error) {
	groups := make([]agentgatewayv1alpha1.PriorityGroup, 0, len(definition.Members))
	for i, member := range definition.Members {
		target, err := RenderProviderTarget(member.Provider, member.Ref.Model)
		if err != nil {
			return nil, fmt.Errorf("render pool member %d: %w", i+1, err)
		}
		policies := &agentgatewayv1alpha1.BackendWithAI{
			BackendSimple:  target.Policies.BackendSimple,
			Transformation: target.Policies.Transformation,
		}
		if pool.Spec.AutomaticFailover {
			condition := agentgatewayv1alpha1.CELExpression(
				"response == null || response.code == 401 || response.code == 403 || " +
					"response.code == 429 || response.code >= 500",
			)
			failures := int32(1)
			restore := int32(100)
			policies.Health = &agentgatewayv1alpha1.Health{
				UnhealthyCondition: &condition,
				Eviction: &agentgatewayv1alpha1.BackendEviction{
					Duration:            &metav1.Duration{Duration: 60 * time.Second},
					ConsecutiveFailures: &failures,
					RestoreHealth:       &restore,
				},
			}
		}
		hasSecurity := policies.Auth != nil || policies.TLS != nil
		hasBehavior := policies.Transformation != nil || policies.Health != nil
		if !hasSecurity && !hasBehavior {
			policies = nil
		}
		groups = append(groups, agentgatewayv1alpha1.PriorityGroup{
			Providers: []agentgatewayv1alpha1.NamedLLMProvider{{
				Name:        member.Section,
				Policies:    policies,
				LLMProvider: target.LLM,
			}},
		})
	}
	return &agentgatewayv1alpha1.AgentgatewayBackend{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentgatewayv1alpha1.GroupVersion.String(),
			Kind:       "AgentgatewayBackend",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      pool.Name,
			Namespace: pool.Namespace,
			Labels:    map[string]string{PoolLabel: pool.Name},
		},
		Spec: agentgatewayv1alpha1.AgentgatewayBackendSpec{
			AI: &agentgatewayv1alpha1.AIBackend{PriorityGroups: groups},
			Policies: &agentgatewayv1alpha1.BackendFull{
				AI: &agentgatewayv1alpha1.BackendAI{
					Routes: map[string]agentgatewayv1alpha1.RouteType{
						"/chat/completions":      agentgatewayv1alpha1.RouteTypeCompletions,
						"/embeddings":            agentgatewayv1alpha1.RouteTypeEmbeddings,
						"/messages":              agentgatewayv1alpha1.RouteTypeMessages,
						"/messages/count_tokens": agentgatewayv1alpha1.RouteTypeAnthropicTokenCount,
						"/models":                agentgatewayv1alpha1.RouteTypeModels,
						"/realtime":              agentgatewayv1alpha1.RouteTypeRealtime,
						"/responses":             agentgatewayv1alpha1.RouteTypeResponses,
					},
				},
			},
		},
	}, nil
}

// IndexPools registers Pool/provider and Sandbox/Pool reference indexes.
func IndexPools(ctx context.Context, idx client.FieldIndexer) error {
	err := idx.IndexField(ctx, &agentzv1alpha1.InferencePool{}, PoolByProviderIndex, func(obj client.Object) []string {
		pool := obj.(*agentzv1alpha1.InferencePool)
		providers := make([]string, 0, len(pool.Spec.Members))
		for _, member := range pool.Spec.Members {
			providers = append(providers, member.Provider)
		}
		slices.Sort(providers)
		return slices.Compact(providers)
	})
	if err != nil {
		return fmt.Errorf("index pools by inference provider: %w", err)
	}
	return idx.IndexField(ctx, &agentzv1alpha1.Sandbox{}, SandboxByPoolIndex, func(obj client.Object) []string {
		sandbox := obj.(*agentzv1alpha1.Sandbox)
		pools := []string{}
		for _, model := range sandbox.Spec.Inference.Models {
			if model.Provider == agentzv1alpha1.InferencePoolProvider {
				pools = append(pools, model.Model)
			}
		}
		slices.Sort(pools)
		return slices.Compact(pools)
	})
}

func modalityIntersection(current, member []agentzv1alpha1.InferenceModelModality) []agentzv1alpha1.InferenceModelModality {
	intersection := make([]agentzv1alpha1.InferenceModelModality, 0, len(current))
	for _, modality := range current {
		if slices.Contains(member, modality) {
			intersection = append(intersection, modality)
		}
	}
	return intersection
}
