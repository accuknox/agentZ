package skill

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	skillpkg "github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-skill,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=skills,verbs=delete,versions=v1alpha1,name=vskill-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator rejects deletion while consumers need the stored skill versions.
//
// +kubebuilder:object:generate=false
type Validator struct {
	reader client.Reader
}

var _ admission.Validator[*agentzv1alpha1.Skill] = &Validator{}

// ValidateCreate leaves skill creation to the CRD schema.
func (v *Validator) ValidateCreate(_ context.Context, _ *agentzv1alpha1.Skill) (admission.Warnings, error) {
	return nil, nil
}

// ValidateUpdate leaves skill updates to the CRD schema.
func (v *Validator) ValidateUpdate(_ context.Context, _, _ *agentzv1alpha1.Skill) (admission.Warnings, error) {
	return nil, nil
}

// ValidateDelete checks references before Kubernetes starts deletion.
func (v *Validator) ValidateDelete(ctx context.Context, skill *agentzv1alpha1.Skill) (admission.Warnings, error) {
	refs, err := skillpkg.ReferencingConsumers(ctx, v.reader, client.ObjectKeyFromObject(skill))
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	return nil, apierrors.NewConflict(
		agentzv1alpha1.Resource("skills"),
		skill.Name,
		fmt.Errorf("skill is in use by %s; remove these references before deleting", strings.Join(refs, ", ")),
	)
}

// RegisterWithManager uses uncached reads so admission sees recent attachments.
func RegisterWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &agentzv1alpha1.Skill{}).
		WithValidator(&Validator{reader: mgr.GetAPIReader()}).
		Complete()
}
