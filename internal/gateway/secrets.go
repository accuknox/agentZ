package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/sinjector"
)

const (
	maxSecretKeyLen   = 128
	maxSecretValueLen = 49152 // 48 KB
	maxSecretEntries  = 100
	agentSecretPage   = 200
)

type normalizedSecretEntry struct {
	key   string
	value string
	hosts []string
}

type secretKeyMetadata struct {
	createdAt time.Time
	updatedAt time.Time
}

// PutSecret handles POST /api/secret/{agentName}/put.
func (s *Service) PutSecret(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), name)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
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

	entries, fields := normalizeSecretEntries(req.Secrets)
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
	for _, entry := range entries {
		path := fmt.Sprintf("%s/%s", name, entry.key)
		data := map[string]any{
			"value": entry.value,
			"hosts": entry.hosts,
		}
		if _, err := s.baoKV.Put(ctx, path, data); err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
		stored++
	}

	if err := s.syncAgentEnv(ctx, name, req.Secrets, nil); err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, gatewayapi.PutSecretsResponse{
		Stored: int32(stored),
	})
}

func normalizeSecretEntries(raw []gatewayapi.SecretEntry) ([]normalizedSecretEntry, []gatewayapi.FieldError) {
	entries := make([]normalizedSecretEntry, 0, len(raw))
	fields := make([]gatewayapi.FieldError, 0, len(raw))
	for i, entry := range raw {
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

		hosts, err := sinjector.NormalizeSecretHosts(entry.Hosts)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("secrets[%d].hosts", i),
				Message: err.Error(),
			})
			continue
		}

		entries = append(entries, normalizedSecretEntry{
			key:   key,
			value: entry.Value,
			hosts: hosts,
		})
	}
	return entries, fields
}

func stringSlice(raw any) []string {
	switch items := raw.(type) {
	case []string:
		return append([]string{}, items...)
	case []any:
		out := make([]string, 0, len(items))
		for _, item := range items {
			s, ok := item.(string)
			if !ok || s == "" {
				continue
			}
			out = append(out, s)
		}
		return out
	default:
		return []string{}
	}
}

func stringMap(raw any) map[string]any {
	items, ok := raw.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return items
}

func parseSecretKeyMetadata(raw any) secretKeyMetadata {
	info := stringMap(raw)
	meta := secretKeyMetadata{}

	createdAt, ok := info["created_time"].(string)
	if ok && createdAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			meta.createdAt = parsed
		}
	}

	updatedAt, ok := info["updated_time"].(string)
	if ok && updatedAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
			meta.updatedAt = parsed
		}
	}

	return meta
}

// DeleteSecret handles POST /api/secret/{agentName}/delete.
func (s *Service) DeleteSecret(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), name)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
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
		path := fmt.Sprintf("%s/%s", name, strings.TrimSpace(key))
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

	if err := s.syncAgentEnv(ctx, name, nil, req.Keys); err != nil {
		writeInternalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// syncAgentEnv updates the Agent CR spec.env by adding placeholder entries
// for secrets in add and removing entries whose Name matches keys in remove.
func (s *Service) syncAgentEnv(ctx context.Context, agentName string, add []gatewayapi.SecretEntry, remove []string) error {
	removeSet := make(map[string]struct{}, len(remove))
	for _, key := range remove {
		removeSet[strings.TrimSpace(key)] = struct{}{}
	}

	addSet := make(map[string]string, len(add))
	for _, entry := range add {
		key := strings.TrimSpace(entry.Key)
		addSet[key] = sinjector.PlaceholderPrefix + key
	}

	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, err := s.resolver.client.ClawarmorV1alpha1().Agents(s.cfg.Namespace).Get(
			ctx,
			agentName,
			metav1.GetOptions{},
		)
		if err != nil {
			return err
		}

		newEnv := make([]corev1.EnvVar, 0, len(agt.Spec.Env))
		for _, ev := range agt.Spec.Env {
			if _, ok := removeSet[ev.Name]; ok {
				continue
			}
			if _, ok := addSet[ev.Name]; ok {
				continue
			}
			newEnv = append(newEnv, ev)
		}

		keys := make([]string, 0, len(addSet))
		for key := range addSet {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for _, key := range keys {
			newEnv = append(newEnv, corev1.EnvVar{
				Name:  key,
				Value: addSet[key],
			})
		}

		agt.Spec.Env = newEnv
		_, err = s.resolver.client.ClawarmorV1alpha1().Agents(s.cfg.Namespace).Update(
			ctx,
			agt,
			metav1.UpdateOptions{},
		)
		return err
	})
}

// ListSecrets handles GET /api/secret/{agentName}/list.
func (s *Service) ListSecrets(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListSecretsParams) {
	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), name)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
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

	listPath := fmt.Sprintf("%s/detailed-metadata/%s", s.cfg.OpenBaoSecretMountPath, name)
	secret, err := s.bao.Logical().ListPageWithContext(r.Context(), listPath, after, limit+1)
	if err != nil {
		slog.ErrorContext(r.Context(), "list secrets failed", slog.String("path", listPath), slog.Any("err", err))
		writeError(w, r, mapOpenBaoError(err))
		return
	}
	if secret == nil || secret.Data == nil {
		writeJSON(w, http.StatusOK, gatewayapi.ListSecretsResponse{
			Items:         []gatewayapi.SecretListItem{},
			NextPageToken: "",
		})
		return
	}

	keys := stringSlice(secret.Data["keys"])
	rawKeyInfo := stringMap(secret.Data["key_info"])

	items := make([]gatewayapi.SecretListItem, 0, len(keys))
	for _, key := range keys {
		hosts, err := s.readSecretHosts(r.Context(), name, key)
		if err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
		item := gatewayapi.SecretListItem{
			Key:   key,
			Hosts: hosts,
		}
		meta := parseSecretKeyMetadata(rawKeyInfo[key])
		item.CreatedAt = meta.createdAt
		item.ModifiedAt = meta.updatedAt
		items = append(items, item)
	}

	resp := gatewayapi.ListSecretsResponse{
		Items:         items,
		NextPageToken: "",
	}
	if len(items) > limit {
		resp.Items = items[:limit]
		resp.NextPageToken = items[limit-1].Key
	}

	writeJSON(w, http.StatusOK, resp)
}

func mapOpenBaoError(err error) *apiError {
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return newAPIError(http.StatusNotFound, "not_found", "secret not found", err)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}

func (s *Service) deleteAgentSecrets(ctx context.Context, agentName string) error {
	keys, err := s.agentSecretKeys(ctx, agentName)
	if err != nil {
		return err
	}

	for _, key := range keys {
		path := fmt.Sprintf("%s/%s", agentName, key)
		if err := s.baoKV.DeleteMetadata(ctx, path); err != nil {
			if errors.Is(err, baoapi.ErrSecretNotFound) {
				continue
			}
			return err
		}
	}

	if err := s.baoKV.DeleteMetadata(ctx, agentName); err != nil {
		if !errors.Is(err, baoapi.ErrSecretNotFound) {
			return err
		}
	}
	return nil
}

func (s *Service) readSecretHosts(ctx context.Context, agentName, key string) ([]string, error) {
	path := fmt.Sprintf("%s/%s", agentName, key)
	secret, err := s.baoKV.Get(ctx, path)
	if err != nil {
		return nil, err
	}
	if secret == nil {
		return nil, baoapi.ErrSecretNotFound
	}
	hosts, err := secretDataHosts(secret.Data["hosts"])
	if err != nil {
		return nil, err
	}
	return hosts, nil
}

func secretDataHosts(raw any) ([]string, error) {
	hosts := stringSlice(raw)
	if len(hosts) == 0 {
		return nil, fmt.Errorf("secret hosts are invalid")
	}
	return sinjector.NormalizeSecretHosts(hosts)
}

func (s *Service) agentSecretKeys(ctx context.Context, agentName string) ([]string, error) {
	listPath := fmt.Sprintf("%s/detailed-metadata/%s", s.cfg.OpenBaoSecretMountPath, agentName)
	after := ""
	keys := []string{}
	for {
		secret, err := s.bao.Logical().ListPageWithContext(ctx, listPath, after, agentSecretPage+1)
		if err != nil {
			if errors.Is(err, baoapi.ErrSecretNotFound) {
				return keys, nil
			}
			return nil, err
		}
		if secret == nil || secret.Data == nil {
			return keys, nil
		}

		page := stringSlice(secret.Data["keys"])
		if len(page) == 0 {
			return keys, nil
		}

		if len(page) <= agentSecretPage {
			keys = append(keys, page...)
			return keys, nil
		}

		keys = append(keys, page[:agentSecretPage]...)
		after = page[agentSecretPage-1]
	}
}
