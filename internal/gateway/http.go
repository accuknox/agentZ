package gateway

import (
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func (s *Service) handleRouteError(w http.ResponseWriter, r *http.Request, err error) {
	apiutil.WriteError(
		w,
		r,
		apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request is invalid",
			err,
		),
	)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	err := apiutil.DecodeJSONBody(r, dst, allowEmpty)
	if err == nil {
		return true
	}
	apiErr, ok := err.(*apiutil.APIError)
	if !ok {
		apiutil.WriteInternalError(w, r, err)
		return false
	}
	apiutil.WriteError(w, r, apiErr)
	return false
}

func mapGatewayStoreError(action string, err error) *apiutil.APIError {
	var apiErr *apiutil.APIError
	if errors.As(err, &apiErr) {
		return apiErr
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apiutil.NewError(http.StatusNotFound, "not_found", "session not found", err)
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if strings.Contains(pgErr.ConstraintName, "agent_name") {
			return apiutil.NewError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return apiutil.NewError(http.StatusConflict, "conflict", action+" conflicts with existing data", err)
	}

	return apiutil.NewError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func mapKubeHTTPError(action string, err error) *apiutil.APIError {
	if apierrors.IsConflict(err) {
		return apiutil.NewError(http.StatusConflict, "conflict", err.Error(), err)
	}
	if apierrors.IsAlreadyExists(err) {
		if action == "create agent" {
			return apiutil.NewError(
				http.StatusConflict,
				"conflict",
				"request conflicts with current state",
				err,
				gatewayapi.FieldError{Field: "name", Message: "already in-use"},
			)
		}
		return apiutil.NewError(http.StatusConflict, "conflict", action+" already exists", err)
	}
	if apierrors.IsNotFound(err) {
		return apiutil.NewError(http.StatusNotFound, "not_found", action+" not found", err)
	}
	if apierrors.IsInvalid(err) || apierrors.IsBadRequest(err) {
		statusErr, ok := err.(apierrors.APIStatus)
		if !ok || statusErr.Status().Details == nil {
			return apiutil.NewError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}

		fields := make([]gatewayapi.FieldError, 0, len(statusErr.Status().Details.Causes))
		for _, cause := range statusErr.Status().Details.Causes {
			if cause.Field == "" {
				continue
			}
			fields = append(
				fields,
				gatewayapi.FieldError{
					Field:   cause.Field,
					Message: cause.Message,
				},
			)
		}
		if len(fields) == 0 {
			return apiutil.NewError(http.StatusBadRequest, "invalid_request", action+" is invalid", err)
		}

		return apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			err,
			fields...,
		)
	}

	return apiutil.NewError(http.StatusInternalServerError, "internal_error", "request failed", err)
}
