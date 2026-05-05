package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	baoapi "github.com/openbao/openbao/api/v2"

	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

const (
	maxSecretKeyLen   = 128
	maxSecretValueLen = 49152 // 48 KB
	maxSecretEntries  = 100
)

// PutSecret handles POST /api/secret/{sessionID}/put.
func (s *Service) PutSecret(w http.ResponseWriter, r *http.Request, sessionID gatewayapi.SessionIDPath) {
	_, sessionUUID, ok := validSessionID(w, r, sessionID.String(), "sessionID")
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	var req gatewayapi.PutSecretsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	if len(req.Secrets) == 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "secrets",
				Message: "must contain at least one entry",
			},
		))
		return
	}
	if len(req.Secrets) > maxSecretEntries {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "secrets",
				Message: fmt.Sprintf("must contain at most %d entries", maxSecretEntries),
			},
		))
		return
	}

	fields := make([]gatewayapi.FieldError, 0, len(req.Secrets))
	for i, entry := range req.Secrets {
		key := strings.TrimSpace(entry.Key)
		if key == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("secrets[%d].key", i),
				Message: "required",
			})
			continue
		}
		if utf8.RuneCountInString(key) > maxSecretKeyLen {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("secrets[%d].key", i),
				Message: fmt.Sprintf("must be at most %d characters", maxSecretKeyLen),
			})
			continue
		}
		if strings.ContainsRune(key, '/') {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("secrets[%d].key", i),
				Message: "must not contain '/'",
			})
			continue
		}
		if len(entry.Value) > maxSecretValueLen {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("secrets[%d].value", i),
				Message: fmt.Sprintf("must be at most %d bytes", maxSecretValueLen),
			})
			continue
		}
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

	ctx := r.Context()

	var stored int
	for _, entry := range req.Secrets {
		path := fmt.Sprintf("%s/%s", sessionUUID.String(), strings.TrimSpace(entry.Key))
		if _, err := s.baoKV.Put(ctx, path, map[string]any{"value": entry.Value}); err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
		stored++
	}

	writeJSON(w, http.StatusCreated, gatewayapi.PutSecretsResponse{
		Stored: int32(stored),
	})
}

// DeleteSecret handles POST /api/secret/{sessionID}/delete.
func (s *Service) DeleteSecret(w http.ResponseWriter, r *http.Request, sessionID gatewayapi.SessionIDPath) {
	_, sessionUUID, ok := validSessionID(w, r, sessionID.String(), "sessionID")
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	var req gatewayapi.DeleteSecretsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	if len(req.Keys) == 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "keys",
				Message: "must contain at least one key",
			},
		))
		return
	}
	if len(req.Keys) > maxSecretEntries {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "keys",
				Message: fmt.Sprintf("must contain at most %d keys", maxSecretEntries),
			},
		))
		return
	}

	fields := make([]gatewayapi.FieldError, 0, len(req.Keys))
	for i, key := range req.Keys {
		key = strings.TrimSpace(key)
		if key == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("keys[%d]", i),
				Message: "required",
			})
			continue
		}
		if utf8.RuneCountInString(key) > maxSecretKeyLen {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("keys[%d]", i),
				Message: fmt.Sprintf("must be at most %d characters", maxSecretKeyLen),
			})
			continue
		}
		if strings.ContainsRune(key, '/') {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("keys[%d]", i),
				Message: "must not contain '/'",
			})
			continue
		}
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

	ctx := r.Context()
	for _, key := range req.Keys {
		path := fmt.Sprintf("%s/%s", sessionUUID.String(), strings.TrimSpace(key))
		if err := s.baoKV.Delete(ctx, path); err != nil {
			if !errors.Is(err, baoapi.ErrSecretNotFound) {
				writeError(w, r, mapOpenBaoError(err))
				return
			}
		}
		// also delete metadata so the key no longer appears in listings.
		if err := s.baoKV.DeleteMetadata(ctx, path); err != nil {
			if !errors.Is(err, baoapi.ErrSecretNotFound) {
				writeError(w, r, mapOpenBaoError(err))
				return
			}
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListSecrets handles GET /api/secret/{sessionID}/list.
func (s *Service) ListSecrets(w http.ResponseWriter, r *http.Request, sessionID gatewayapi.SessionIDPath, params gatewayapi.ListSecretsParams) {
	_, sessionUUID, ok := validSessionID(w, r, sessionID.String(), "sessionID")
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	after := ""
	if params.PageToken != nil {
		after = strings.TrimSpace(*params.PageToken)
	}

	listPath := fmt.Sprintf("%s/metadata/%s", s.cfg.OpenBaoSecretMountPath, sessionUUID.String())
	secret, err := s.bao.Logical().ListPageWithContext(r.Context(), listPath, after, limit+1)
	if err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}
	if secret == nil || secret.Data == nil {
		writeJSON(w, http.StatusOK, gatewayapi.ListSecretsResponse{
			Keys:          []string{},
			NextPageToken: "",
		})
		return
	}

	rawKeys, _ := secret.Data["keys"].([]any)
	keys := make([]string, 0, len(rawKeys))
	for _, k := range rawKeys {
		if s, ok := k.(string); ok {
			keys = append(keys, s)
		}
	}

	resp := gatewayapi.ListSecretsResponse{Keys: keys, NextPageToken: ""}
	if len(keys) > limit {
		resp.Keys = keys[:limit]
		resp.NextPageToken = keys[limit-1]
	}

	writeJSON(w, http.StatusOK, resp)
}

func mapOpenBaoError(err error) *apiError {
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return newAPIError(http.StatusNotFound, "not_found", "secret not found", err)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}
