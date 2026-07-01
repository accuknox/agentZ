package envutil

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const AgentByEnvironmentIndex = "spec.environmentRef.name"

// IndexAgentsByEnvironment registers the agent environment reference index.
func IndexAgentsByEnvironment(ctx context.Context, idx client.FieldIndexer) error {
	return idx.IndexField(
		ctx,
		&agentzv1alpha1.Agent{},
		AgentByEnvironmentIndex,
		func(obj client.Object) []string {
			agt, ok := obj.(*agentzv1alpha1.Agent)
			if !ok {
				return nil
			}
			ref := agt.Spec.EnvironmentRef
			if ref == nil || ref.Name == "" {
				return nil
			}
			return []string{ref.Name}
		},
	)
}

// ReferencedNames returns environment names referenced by agents.
func ReferencedNames(ctx context.Context, c client.Client, ns string) (map[string]bool, error) {
	refs := map[string]bool{}
	agents := &agentzv1alpha1.AgentList{}
	if err := c.List(ctx, agents, client.InNamespace(ns)); err != nil {
		return nil, err
	}
	for _, agt := range agents.Items {
		ref := agt.Spec.EnvironmentRef
		if ref == nil || ref.Name == "" {
			continue
		}
		refs[ref.Name] = true
	}
	return refs, nil
}

// ReferencingAgentName returns the first agent that references environmentName.
//
// The gateway uses a direct controller-runtime client without a cache-backed
// field index. Listing with MatchingFields against a CRD field then falls back
// to a Kubernetes API field selector, which does not support
// spec.environmentRef.name. Scan the namespace in memory so the helper works
// with both cached and uncached clients.
func ReferencingAgentName(ctx context.Context, c client.Client, ns string, environmentName string) (string, error) {
	agents := &agentzv1alpha1.AgentList{}
	if err := c.List(ctx, agents, client.InNamespace(ns)); err != nil {
		return "", err
	}
	for _, agt := range agents.Items {
		ref := agt.Spec.EnvironmentRef
		if ref == nil || ref.Name != environmentName {
			continue
		}
		return agt.Name, nil
	}
	return "", nil
}
