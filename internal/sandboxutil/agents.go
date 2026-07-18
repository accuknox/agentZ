package sandboxutil

import (
	"context"
	"slices"

	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// AgentBySandboxIndex indexes Agents by their referenced Sandbox name.
const AgentBySandboxIndex = "spec.sandboxRef.name"

// IndexAgentsBySandbox registers the agent sandbox reference index.
func IndexAgentsBySandbox(ctx context.Context, idx client.FieldIndexer) error {
	return idx.IndexField(
		ctx,
		&agentzv1alpha1.Agent{},
		AgentBySandboxIndex,
		func(obj client.Object) []string {
			agt, ok := obj.(*agentzv1alpha1.Agent)
			if !ok {
				return nil
			}
			ref := agt.Spec.SandboxRef
			if ref.Name == "" {
				return nil
			}
			return []string{ref.Name}
		},
	)
}

// ReferencedNames returns sandbox names referenced by agents.
func ReferencedNames(ctx context.Context, c client.Client, ns string) (map[string]bool, error) {
	refs := map[string]bool{}
	agents := &agentzv1alpha1.AgentList{}
	if err := c.List(ctx, agents, client.InNamespace(ns)); err != nil {
		return nil, err
	}
	for _, agt := range agents.Items {
		ref := agt.Spec.SandboxRef
		if ref.Name == "" {
			continue
		}
		refs[ref.Name] = true
	}
	return refs, nil
}

// ReferencingAgentNames returns every Agent that references sandboxName.
func ReferencingAgentNames(ctx context.Context, c client.Reader, ns string, sandboxName string) ([]string, error) {
	agents := &agentzv1alpha1.AgentList{}
	err := c.List(
		ctx,
		agents,
		client.InNamespace(ns),
		client.MatchingFields{AgentBySandboxIndex: sandboxName},
	)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0)
	for _, agt := range agents.Items {
		names = append(names, agt.Name)
	}
	slices.Sort(names)
	return names, nil
}
