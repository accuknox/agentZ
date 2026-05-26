package workflow

import (
	"context"
	"errors"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

var ErrWorkflowRunTerminal = errors.New("workflow run already has a terminal status")

type RunPhaseConflictError struct {
	Current clawarmorv1alpha1.WorkflowRunPhase
	Target  clawarmorv1alpha1.WorkflowRunPhase
}

func (e *RunPhaseConflictError) Error() string {
	return fmt.Sprintf(
		"workflow run phase %q cannot transition to %q",
		e.Current,
		e.Target,
	)
}

func ValidateRunStatusRequest(name string, message string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 2)
	if errs := validation.IsDNS1123Subdomain(strings.TrimSpace(name)); len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "must be a valid DNS subdomain",
		})
	}
	if len(message) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "message",
			Message: "must be 4096 characters or fewer",
		})
	}
	return fields
}

func PatchRunStatus(ctx context.Context, k8sClient ctrlclient.Client, ns string, name string, req gatewayapi.PatchWorkflowRunStatusRequest, msg string) error {
	key := types.NamespacedName{Namespace: ns, Name: strings.TrimSpace(name)}
	phase := clawarmorv1alpha1.WorkflowRunPhase(req.Phase)
	var resultErr error

	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		if err := k8sClient.Get(ctx, key, current); err != nil {
			return err
		}

		if current.Status.Phase.Terminal() {
			if current.Status.Phase == phase && current.Status.Message == msg {
				resultErr = nil
				return nil
			}
			resultErr = ErrWorkflowRunTerminal
			return nil
		}
		if current.Status.Phase != clawarmorv1alpha1.WorkflowRunPhaseRunning {
			resultErr = &RunPhaseConflictError{
				Current: current.Status.Phase,
				Target:  phase,
			}
			return nil
		}

		patch := ctrlclient.MergeFrom(current.DeepCopy())
		now := metav1.Now()
		current.Status.Phase = phase
		current.Status.Message = msg
		current.Status.CompletedAt = &now

		if err := k8sClient.Status().Patch(ctx, current, patch); err != nil {
			return err
		}

		resultErr = nil
		return nil
	})
	if err != nil {
		return err
	}
	return resultErr
}
