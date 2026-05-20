package gateway

import (
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/accuknox/clawarmor/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
)

type apiError = apiutil.APIError

func newAPIError(status int, code string, message string, cause error, fields ...gatewayapi.FieldError) *apiError {
	return apiutil.NewError(status, code, message, cause, fields...)
}

func (s *Service) handleRouteError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"request is invalid",
		err,
	))
}

func recordRequestError(w http.ResponseWriter, code string, cause error) {
	apiutil.RecordRequestError(w, code, cause)
}

func writeInternalError(w http.ResponseWriter, r *http.Request, err error) {
	apiutil.WriteInternalError(w, r, err)
}

func writeError(w http.ResponseWriter, r *http.Request, e *apiError) {
	apiutil.WriteError(w, r, e)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	apiutil.WriteJSON(w, status, body)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	err := apiutil.DecodeJSONBody(w, r, dst, allowEmpty)
	if err == nil {
		return true
	}
	apiErr, ok := err.(*apiError)
	if !ok {
		writeInternalError(w, r, err)
		return false
	}
	writeError(w, r, apiErr)
	return false
}

func mapGatewayStoreError(action string, err error) *apiError {
	if errors.Is(err, pgx.ErrNoRows) {
		return newAPIError(http.StatusNotFound, "not_found", "session not found", err)
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if strings.Contains(pgErr.ConstraintName, "agent_name") {
			return newAPIError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return newAPIError(http.StatusConflict, "conflict", action+" conflicts with existing data", err)
	}

	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func mapKubeHTTPError(action string, err error) *apiError {
	if apierrors.IsAlreadyExists(err) {
		if action == "create agent" {
			return newAPIError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return newAPIError(http.StatusConflict, "conflict", action+" already exists", err)
	}
	if apierrors.IsNotFound(err) {
		return newAPIError(http.StatusNotFound, "not_found", action+" not found", err)
	}
	if apierrors.IsInvalid(err) || apierrors.IsBadRequest(err) {
		statusErr, ok := err.(apierrors.APIStatus)
		if !ok || statusErr.Status().Details == nil {
			return newAPIError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}

		fields := make([]gatewayapi.FieldError, 0, len(statusErr.Status().Details.Causes))
		for _, cause := range statusErr.Status().Details.Causes {
			if cause.Field == "" {
				continue
			}
			fields = append(fields, gatewayapi.FieldError{
				Field:   cause.Field,
				Message: cause.Message,
			})
		}
		if len(fields) == 0 {
			return newAPIError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}

		return newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			err,
			fields...,
		)
	}

	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}
