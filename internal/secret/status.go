package secret

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// SetCondition applies one active Secret condition and clears the others.
func SetCondition(status *agentzv1alpha1.SecretStatus, cond metav1.Condition) {
	status.SetCondition(cond)
	condTypes := []string{
		agentzv1alpha1.SecretConditionAccepted,
		agentzv1alpha1.SecretConditionReady,
		agentzv1alpha1.SecretConditionDegraded,
	}
	for _, typ := range condTypes {
		if typ == cond.Type {
			continue
		}
		status.SetCondition(metav1.Condition{
			Type:               typ,
			Status:             metav1.ConditionFalse,
			Reason:             cond.Reason,
			Message:            cond.Message,
			ObservedGeneration: cond.ObservedGeneration,
		})
	}
}
