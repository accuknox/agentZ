package workflow

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	workflowapi "github.com/accuknox/clawarmor/internal/workflow/openapi"
)

type apiError struct {
	Status  int
	Code    string
	Message string
	Cause   error
	Fields  []workflowapi.FieldError
}

func (e *apiError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func newAPIError(status int, code string, message string, cause error, fields ...workflowapi.FieldError) *apiError {
	return &apiError{
		Status:  status,
		Code:    code,
		Message: message,
		Cause:   cause,
		Fields:  fields,
	}
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
	rec, ok := w.(interface {
		SetAPIError(string, error)
	})
	if ok {
		rec.SetAPIError(code, cause)
	}
}

func writeInternalError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusInternalServerError,
		"internal_error",
		"request failed",
		err,
	))
}

func writeError(w http.ResponseWriter, _ *http.Request, e *apiError) {
	if e == nil {
		e = newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			nil,
		)
	}
	recordRequestError(w, e.Code, e.Cause)

	body := workflowapi.Error{
		Code:    e.Code,
		Message: e.Message,
	}
	if len(e.Fields) > 0 {
		body.Errors = &e.Fields
	}

	writeJSON(w, e.Status, body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request body is invalid",
			err,
			workflowapi.FieldError{Field: "body", Message: "invalid JSON"},
		))
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request body must contain one JSON object",
			err,
			workflowapi.FieldError{Field: "body", Message: "must contain one JSON object"},
		))
		return false
	}
	return true
}

func mapStoreError(action string, err error) *apiError {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "23503":
			return newAPIError(http.StatusNotFound, "not_found", "agent not found", err)
		case "23505":
			field := "workflow_name"
			if strings.Contains(pgErr.ConstraintName, "workflow_nodes_pkey") {
				field = "nodes"
			}
			return newAPIError(
				http.StatusConflict,
				"conflict",
				action+" conflicts with existing data",
				err,
				workflowapi.FieldError{Field: field, Message: "already in-use"},
			)
		}
	}

	if errors.Is(err, errConditionEnvUnavailable) {
		return newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"request validation failed",
			fmt.Errorf("workflow validation setup: %w", err),
		)
	}

	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func requestID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if id := strings.TrimSpace(r.Header.Get("X-Request-ID")); id != "" {
		return id
	}

	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return uuid.UUID(b).String()
}
