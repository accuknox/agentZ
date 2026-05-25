package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// PatchWorkflowRunStatus handles PATCH /api/workflow-runs/{name}/status.
func (s *Service) PatchWorkflowRunStatus(w http.ResponseWriter, r *http.Request, name string) {
	var req gatewayapi.PatchWorkflowRunStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name = strings.TrimSpace(name)
	message := ""
	if req.Message != nil {
		message = strings.TrimSpace(*req.Message)
	}

	fields := []gatewayapi.FieldError{}
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
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
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	key := types.NamespacedName{
		Namespace: s.cfg.Namespace,
		Name:      name,
	}
	phase := clawarmorv1alpha1.WorkflowRunPhase(req.Phase)
	var resultErr error
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.WorkflowRun{}
		err := s.k8sClient.Get(r.Context(), key, current)
		if err != nil {
			resultErr = mapKubeHTTPError("workflow run", err)
			return err
		}

		if current.Status.Phase.Terminal() {
			if current.Status.Phase == phase && current.Status.Message == message {
				resultErr = nil
				return nil
			}
			resultErr = newAPIError(
				http.StatusConflict,
				"conflict",
				"workflow run already has a terminal status",
				errors.New("workflow run already terminal"),
			)
			return nil
		}
		if current.Status.Phase != clawarmorv1alpha1.WorkflowRunPhaseRunning {
			resultErr = newAPIError(
				http.StatusConflict,
				"conflict",
				fmt.Sprintf(
					"workflow run phase %q cannot transition to %q",
					current.Status.Phase,
					phase,
				),
				errors.New("workflow run phase conflict"),
			)
			return nil
		}

		patch := ctrlclient.MergeFrom(current.DeepCopy())
		now := metav1.Now()
		current.Status.Phase = phase
		current.Status.Message = message
		current.Status.CompletedAt = &now

		err = s.k8sClient.Status().Patch(r.Context(), current, patch)
		if err != nil {
			resultErr = mapKubeHTTPError("patch workflow run status", err)
			return err
		}

		resultErr = nil
		return nil
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("patch workflow run status", err))
		return
	}
	if resultErr != nil {
		apiErr, ok := resultErr.(*apiError)
		if !ok {
			writeInternalError(w, r, resultErr)
			return
		}
		writeError(w, r, apiErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
