package apiutil

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// APIError describes an HTTP API error response.
type APIError struct {
	Status  int
	Code    string
	Message string
	Cause   error
	Fields  []gatewayapi.FieldError
}

// Error implements error.
func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// NewError returns a new APIError.
func NewError(status int, code string, message string, cause error, fields ...gatewayapi.FieldError) *APIError {
	return &APIError{
		Status:  status,
		Code:    code,
		Message: message,
		Cause:   cause,
		Fields:  fields,
	}
}

// RecordRequestError records the API error on a compatible response writer.
func RecordRequestError(w http.ResponseWriter, code string, cause error) {
	rec, ok := w.(interface {
		SetAPIError(string, error)
	})
	if ok {
		rec.SetAPIError(code, cause)
	}
}

// WriteInternalError writes a generic internal error response.
func WriteInternalError(w http.ResponseWriter, r *http.Request, err error) {
	WriteError(w, r, NewError(
		http.StatusInternalServerError,
		"internal_error",
		"request failed",
		err,
	))
}

// WriteError writes a structured API error response.
func WriteError(w http.ResponseWriter, _ *http.Request, e *APIError) {
	if e == nil {
		e = NewError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			nil,
		)
	}
	RecordRequestError(w, e.Code, e.Cause)

	body := gatewayapi.Error{
		Code:    e.Code,
		Message: e.Message,
	}
	if len(e.Fields) > 0 {
		body.Errors = &e.Fields
	}
	WriteJSON(w, e.Status, body)
}

// WriteJSON writes a JSON response body.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// DecodeJSONBody decodes a single JSON object from the request body.
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	err := dec.Decode(dst)
	if errors.Is(err, http.ErrBodyNotAllowed) {
		err = nil
	}
	if errors.Is(err, io.EOF) && allowEmpty {
		return nil
	}
	if err != nil {
		return NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request body is invalid",
			err,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "invalid JSON",
			},
		)
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request body must contain one JSON object",
			err,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "must contain one JSON object",
			},
		)
	}
	return nil
}
