package secret

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// SetCondition applies one active Secret condition and clears the others.
func SetCondition(status *clawarmorv1alpha1.SecretStatus, cond metav1.Condition) {
	status.SetCondition(cond)
	condTypes := []string{
		clawarmorv1alpha1.SecretConditionAccepted,
		clawarmorv1alpha1.SecretConditionReady,
		clawarmorv1alpha1.SecretConditionDegraded,
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
