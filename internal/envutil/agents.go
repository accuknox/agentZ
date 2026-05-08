package envutil

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/client"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

// ReferencedNames returns environment names referenced by agents.
func ReferencedNames(ctx context.Context, c client.Client, ns string) (map[string]bool, error) {
	refs := map[string]bool{}
	agents := &clawarmorv1alpha1.AgentList{}
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
func ReferencingAgentName(ctx context.Context, c client.Client, ns string, environmentName string) (string, error) {
	agents := &clawarmorv1alpha1.AgentList{}
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
