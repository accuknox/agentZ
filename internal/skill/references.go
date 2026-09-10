package skill

import (
	"context"
	"fmt"
	"slices"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ReferencingConsumers finds direct references before deletion or finalization.
// Namespace identity, rather than current sharing permissions, determines whether
// a reference still protects the skill's stored versions.
func ReferencingConsumers(ctx context.Context, reader client.Reader, key client.ObjectKey) ([]string, error) {
	var agents agentzv1alpha1.AgentList
	if err := reader.List(ctx, &agents); err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	var sandboxes agentzv1alpha1.SandboxList
	if err := reader.List(ctx, &sandboxes); err != nil {
		return nil, fmt.Errorf("list sandboxes: %w", err)
	}

	consumers := []string{}
	check := func(kind, namespace, name string, refs []agentzv1alpha1.ResourceReference) error {
		for _, ref := range refs {
			if ref.Name != key.Name {
				continue
			}
			ns, err := scope.Namespace(ctx, reader, namespace, ref.Scope)
			if err != nil {
				return fmt.Errorf("resolve %s %s/%s skill: %w", kind, namespace, name, err)
			}
			if ns == key.Namespace {
				consumers = append(consumers, kind+" "+namespace+"/"+name)
				break
			}
		}
		return nil
	}
	for _, agt := range agents.Items {
		if err := check("Agent", agt.Namespace, agt.Name, agt.Spec.Skills); err != nil {
			return nil, err
		}
	}
	for _, sandbox := range sandboxes.Items {
		err := check("Sandbox", sandbox.Namespace, sandbox.Name, sandbox.Spec.Skills)
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(consumers)
	return consumers, nil
}

// ValidateReferences prevents consumers from attaching missing or deleting skills.
func ValidateReferences(ctx context.Context, reader client.Reader, namespace string, refs []agentzv1alpha1.ResourceReference) field.ErrorList {
	fields := field.ErrorList{}
	for i, ref := range refs {
		path := field.NewPath("spec", "skills").Index(i)
		ns, err := scope.SelectedNamespace(ctx, reader, namespace, scope.Selection{
			Scope: ref.Scope,
			Kind:  agentzv1alpha1.OrganizationResourceKindSkill,
			Name:  ref.Name,
		})
		if err != nil {
			fields = append(fields, field.Invalid(path.Child("scope"), ref.Scope, err.Error()))
			continue
		}
		var skill agentzv1alpha1.Skill
		err = reader.Get(ctx, client.ObjectKey{Namespace: ns, Name: ref.Name}, &skill)
		switch {
		case apierrors.IsNotFound(err):
			fields = append(fields, field.NotFound(path.Child("name"), ref.Name))
		case err != nil:
			fields = append(fields, field.InternalError(path.Child("name"), err))
		case !skill.DeletionTimestamp.IsZero():
			fields = append(fields, field.Forbidden(
				path.Child("name"), fmt.Sprintf("skill %q is being deleted", ref.Name),
			))
		}
	}
	return fields
}
