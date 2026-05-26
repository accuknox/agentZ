package gateway

import (
	"errors"
	"net/http"
	"strings"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/gateway/workflow"
)

// PatchWorkflowRunStatus handles PATCH /api/workflow-runs/{name}/status.
func (s *Service) PatchWorkflowRunStatus(w http.ResponseWriter, r *http.Request, name string) {
	var req gatewayapi.PatchWorkflowRunStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	trimmedName := strings.TrimSpace(name)
	message := ""
	if req.Message != nil {
		message = strings.TrimSpace(*req.Message)
	}

	fields := workflow.ValidateRunStatusRequest(trimmedName, message)
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

	err := workflow.PatchRunStatus(
		r.Context(),
		s.k8sClient,
		s.cfg.Namespace,
		trimmedName,
		req,
		message,
	)
	if err != nil {
		var phaseErr *workflow.RunPhaseConflictError
		switch {
		case errors.Is(err, workflow.ErrWorkflowRunTerminal):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"workflow run already has a terminal status",
				err,
			))
		case errors.As(err, &phaseErr):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				err.Error(),
				err,
			))
		default:
			writeError(w, r, mapKubeHTTPError("patch workflow run status", err))
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
