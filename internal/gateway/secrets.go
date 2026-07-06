package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/oauth2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/util/retry"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/oauth"
	"github.com/accuknox/agentz/internal/sandboxutil"
	secretstore "github.com/accuknox/agentz/internal/secret"
	"github.com/accuknox/agentz/internal/sinjector"
	secretwebhook "github.com/accuknox/agentz/internal/webhook/v1alpha1/secret"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var secretKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// PutSecret handles POST /api/secret/{agentName}.
func (s *Service) PutSecret(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.PutSecretParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	name, ok := validAgentName(w, r, agtName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), gatewaydb.GatewayAgentExistsParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
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

	var req gatewayapi.CreateSecretRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	secret, record, apiErr := s.secretFromRequest(ns, tenant, name, req)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	if params.UpdateSandbox != nil && *params.UpdateSandbox {
		apiErr = s.updateSecretSandboxHosts(r.Context(), ns, name, secret.Spec.Hosts)
		if apiErr != nil {
			writeError(w, r, apiErr)
			return
		}
	}

	if err := s.putAgentSecretRuntime(r.Context(), ns, name, secret.Spec.Key, record); err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}

	if err := s.k8sClient.Create(r.Context(), secret); err != nil {
		_ = s.deleteAgentSecretRuntime(r.Context(), ns, name, secret.Spec.Key)
		writeError(w, r, mapKubeHTTPError("create secret", err))
		return
	}

	if err := s.syncAgentEnv(r.Context(), name, []string{secret.Spec.Key}, nil); err != nil {
		_ = s.k8sClient.Delete(r.Context(), secret)
		_ = s.deleteAgentSecretRuntime(r.Context(), ns, name, secret.Spec.Key)
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, gatewayapi.PutSecretsResponse{
		Secret: s.secretListItem(*secret),
	})
}

func (s *Service) updateSecretSandboxHosts(ctx context.Context, ns string, agtName string, secretHosts []string) *apiError {
	agt, err := s.resolver.client.AgentzV1alpha1().Agents(ns).Get(
		ctx,
		agtName,
		metav1.GetOptions{},
	)
	if err != nil {
		return mapKubeHTTPError("get agent", err)
	}
	if agt.Spec.SandboxRef == nil {
		return nil
	}

	sandboxName := strings.TrimSpace(agt.Spec.SandboxRef.Name)
	if sandboxName == "" {
		return nil
	}

	addHosts := make([]string, 0, len(secretHosts))
	for _, host := range secretHosts {
		if addr, err := netip.ParseAddr(host); err == nil {
			addHosts = append(addHosts, netip.PrefixFrom(addr, addr.BitLen()).String())
			continue
		}

		parsed, err := sandboxutil.ParseHost(host)
		if err != nil {
			return newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "hosts",
					Message: fmt.Sprintf("host %q cannot be added to sandbox: %v", host, err),
				},
			)
		}
		addHosts = append(addHosts, parsed.Value)
	}
	if len(addHosts) == 0 {
		return nil
	}

	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		sandbox, err := s.resolver.client.AgentzV1alpha1().Sandboxes(ns).Get(
			ctx,
			sandboxName,
			metav1.GetOptions{},
		)
		if err != nil {
			return err
		}

		seen := make(map[string]struct{}, len(sandbox.Spec.AllowedHosts)+len(addHosts))
		merged := make([]string, 0, len(sandbox.Spec.AllowedHosts)+len(addHosts))
		for _, host := range sandbox.Spec.AllowedHosts {
			if _, ok := seen[host]; ok {
				continue
			}
			seen[host] = struct{}{}
			merged = append(merged, host)
		}

		var changed bool
		for _, host := range addHosts {
			if _, ok := seen[host]; ok {
				continue
			}
			seen[host] = struct{}{}
			merged = append(merged, host)
			changed = true
		}
		if !changed {
			return nil
		}

		sandbox.Spec.AllowedHosts = merged
		_, err = s.resolver.client.AgentzV1alpha1().Sandboxes(ns).Update(
			ctx,
			sandbox,
			metav1.UpdateOptions{},
		)
		return err
	})
	if err != nil {
		return mapKubeHTTPError("update sandbox", err)
	}

	return nil
}

// DeleteSecret handles POST /api/secret/{agentName}/delete.
func (s *Service) DeleteSecret(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), gatewaydb.GatewayAgentExistsParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
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
			gatewayapi.FieldError{Field: "keys", Message: "must contain at least one key"},
		))
		return
	}

	items, err := s.listAgentSecrets(ns, name)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	index := make(map[string]*agentzv1alpha1.Secret, len(items))
	for i := range items {
		index[strings.ToLower(items[i].Spec.Key)] = &items[i]
	}

	removeKeys := make([]string, 0, len(req.Keys))
	for i, rawKey := range req.Keys {
		key := strings.TrimSpace(rawKey)
		if key == "" {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   fmt.Sprintf("keys[%d]", i),
					Message: "required",
				},
			))
			return
		}

		secret := index[strings.ToLower(key)]
		if secret == nil {
			continue
		}
		if err := s.k8sClient.Delete(r.Context(), secret); err != nil && !apierrors.IsNotFound(err) {
			writeError(w, r, mapKubeHTTPError("delete secret", err))
			return
		}
		removeKeys = append(removeKeys, secret.Spec.Key)
	}

	if err := s.syncAgentEnv(r.Context(), name, nil, removeKeys); err != nil {
		writeInternalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListSecrets handles GET /api/secret/{agentName}.
func (s *Service) ListSecrets(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListSecretsParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), gatewaydb.GatewayAgentExistsParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
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

	items, err := s.listAgentSecrets(ns, name)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	slices.SortFunc(items, func(a, b agentzv1alpha1.Secret) int {
		return strings.Compare(strings.ToLower(a.Spec.Key), strings.ToLower(b.Spec.Key))
	})

	start := 0
	if params.PageToken != nil {
		after := strings.TrimSpace(*params.PageToken)
		for i, item := range items {
			if strings.Compare(strings.ToLower(item.Spec.Key), strings.ToLower(after)) > 0 {
				start = i
				break
			}
			start = len(items)
		}
	}

	end := min(start+limit, len(items))
	resp := gatewayapi.ListSecretsResponse{
		Items:         make([]gatewayapi.SecretListItem, 0, end-start),
		NextPageToken: "",
	}
	for _, item := range items[start:end] {
		resp.Items = append(resp.Items, s.secretListItem(item))
	}
	if end < len(items) {
		resp.NextPageToken = items[end-1].Spec.Key
	}
	writeJSON(w, http.StatusOK, resp)
}

// WatchSecrets handles POST /api/secret/{agentName}/watch.
//
//nolint:gocyclo
func (s *Service) WatchSecrets(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	exists, err := s.queries.GatewayAgentExists(r.Context(), gatewaydb.GatewayAgentExistsParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
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

	var req gatewayapi.WatchSecretsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}

	keyFilter := map[string]struct{}{}
	if req.Keys != nil {
		for i, rawKey := range *req.Keys {
			key := strings.TrimSpace(rawKey)
			if key == "" {
				writeError(w, r, newAPIError(
					http.StatusBadRequest,
					"invalid_request",
					"request validation failed",
					errBadRequest,
					gatewayapi.FieldError{
						Field:   fmt.Sprintf("keys[%d]", i),
						Message: "required",
					},
				))
				return
			}
			if !secretKeyPattern.MatchString(key) {
				writeError(w, r, newAPIError(
					http.StatusBadRequest,
					"invalid_request",
					"request validation failed",
					errBadRequest,
					gatewayapi.FieldError{
						Field:   fmt.Sprintf("keys[%d]", i),
						Message: "must be a valid environment variable name",
					},
				))
				return
			}
			keyFilter[strings.ToLower(key)] = struct{}{}
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeInternalError(w, r, errors.New("streaming is unavailable"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := map[string]gatewayapi.SecretListItem{}
	send := func(event string, items []gatewayapi.SecretListItem) bool {
		if len(items) == 0 {
			return true
		}

		raw, err := json.Marshal(gatewayapi.WatchSecretsEvent{Items: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if event != "" {
			if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	events, cancel := s.resolver.watchSecrets()
	defer cancel()

	writeChanges := func() bool {
		items, err := s.listAgentSecrets(ns, name)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		slices.SortFunc(items, func(a, b agentzv1alpha1.Secret) int {
			return strings.Compare(strings.ToLower(a.Spec.Key), strings.ToLower(b.Spec.Key))
		})

		changed := make([]gatewayapi.SecretListItem, 0, len(items))
		for _, item := range items {
			if len(keyFilter) > 0 {
				if _, ok := keyFilter[strings.ToLower(item.Spec.Key)]; !ok {
					continue
				}
			}

			summary := s.secretListItem(item)
			prevItem, ok := prev[summary.Key]
			sameProvider := prevItem.Provider == nil && summary.Provider == nil
			if prevItem.Provider != nil && summary.Provider != nil {
				sameProvider = *prevItem.Provider == *summary.Provider
			}
			sameLastRefresh := prevItem.LastRefreshTime == nil && summary.LastRefreshTime == nil
			if prevItem.LastRefreshTime != nil && summary.LastRefreshTime != nil {
				sameLastRefresh = prevItem.LastRefreshTime.Equal(*summary.LastRefreshTime)
			}
			sameTokenExpiry := prevItem.TokenExpiryTime == nil && summary.TokenExpiryTime == nil
			if prevItem.TokenExpiryTime != nil && summary.TokenExpiryTime != nil {
				sameTokenExpiry = prevItem.TokenExpiryTime.Equal(*summary.TokenExpiryTime)
			}
			unchanged := ok &&
				prevItem.Key == summary.Key &&
				prevItem.Type == summary.Type &&
				slices.Equal(prevItem.Hosts, summary.Hosts) &&
				sameProvider &&
				prevItem.Status == summary.Status &&
				prevItem.Reason == summary.Reason &&
				prevItem.Message == summary.Message &&
				prevItem.CreatedAt.Equal(summary.CreatedAt) &&
				sameLastRefresh &&
				sameTokenExpiry
			if unchanged {
				continue
			}

			prev[summary.Key] = summary
			changed = append(changed, summary)
		}

		return send("", changed)
	}

	if !writeChanges() {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == secretWatchEventDeleted {
				if evt.Secret == nil || evt.Secret.Namespace != ns {
					continue
				}
				if evt.Secret.Spec.AgentRef.Name != name {
					continue
				}
				if len(keyFilter) > 0 {
					if _, ok := keyFilter[strings.ToLower(evt.Secret.Spec.Key)]; !ok {
						continue
					}
				}

				item, ok := prev[evt.Secret.Spec.Key]
				delete(prev, evt.Secret.Spec.Key)
				if ok && !send("DELETE", []gatewayapi.SecretListItem{item}) {
					return
				}
				continue
			}
			if !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) secretFromRequest(ns string, tenant *agentzv1alpha1.Tenant, agtName string, req gatewayapi.CreateSecretRequest) (*agentzv1alpha1.Secret, secretstore.Record, *apiError) {
	key := strings.TrimSpace(req.Key)
	items, err := s.listAgentSecrets(ns, agtName)
	if err != nil {
		return nil, nil, newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
	}
	for _, item := range items {
		if strings.EqualFold(item.Spec.Key, key) {
			return nil, nil, newAPIError(
				http.StatusConflict,
				"conflict",
				"secret already exists",
				errBadRequest,
				gatewayapi.FieldError{Field: "key", Message: "secret key already exists"},
			)
		}
	}

	spec := agentzv1alpha1.SecretSpec{
		AgentRef: agentzv1alpha1.SecretAgentRef{Name: agtName},
		Key:      key,
		Hosts:    make([]string, 0, len(req.Hosts)),
	}
	spec.Hosts = append(spec.Hosts, req.Hosts...)

	now := time.Now().UTC()
	secretName := "secret-" + strings.ToLower(uuid.NewString())
	var record secretstore.Record

	switch req.Type {
	case gatewayapi.SecretType("static"):
		if req.Value == nil || strings.TrimSpace(*req.Value) == "" {
			return nil, nil, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{Field: "value", Message: "required"},
			)
		}
		spec.Type = agentzv1alpha1.SecretTypeStatic
		secretwebhook.ApplyDefaults(&spec)
		record = secretstore.StaticRecord{
			Type:       agentzv1alpha1.SecretTypeStatic,
			Hosts:      append([]string{}, spec.Hosts...),
			Value:      *req.Value,
			UpdatedAt:  now,
			SecretName: secretName,
		}
	case gatewayapi.SecretType("oauth"):
		if req.Oauth == nil {
			return nil, nil, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{Field: "oauth", Message: "required"},
			)
		}

		spec.Type = agentzv1alpha1.SecretTypeOAuth
		spec.OAuth = &agentzv1alpha1.SecretOAuthSpec{
			Scopes: append([]string{}, req.Oauth.Scopes...),
		}
		if req.Oauth.Provider != nil {
			spec.OAuth.Provider = strings.TrimSpace(*req.Oauth.Provider)
		}
		if req.Oauth.Issuer != nil {
			spec.OAuth.Issuer = strings.TrimSpace(*req.Oauth.Issuer)
		}
		if req.Oauth.AuthorizationEndpoint != nil {
			spec.OAuth.AuthorizationEndpoint = strings.TrimSpace(*req.Oauth.AuthorizationEndpoint)
		}
		spec.OAuth.TokenEndpoint = strings.TrimSpace(req.Oauth.TokenEndpoint)
		if req.Oauth.RegistrationEndpoint != nil {
			spec.OAuth.RegistrationEndpoint = strings.TrimSpace(*req.Oauth.RegistrationEndpoint)
		}
		if req.Oauth.Resource != nil {
			spec.OAuth.Resource = strings.TrimSpace(*req.Oauth.Resource)
		}
		secretwebhook.ApplyDefaults(&spec)

		runtimeRecord := secretstore.OAuthRecord{
			Type:       agentzv1alpha1.SecretTypeOAuth,
			SecretName: secretName,
			Hosts:      append([]string{}, spec.Hosts...),
			Config: secretstore.OAuthConfig{
				Scopes:                append([]string{}, spec.OAuth.Scopes...),
				Provider:              spec.OAuth.Provider,
				Issuer:                spec.OAuth.Issuer,
				AuthorizationEndpoint: spec.OAuth.AuthorizationEndpoint,
				TokenEndpoint:         spec.OAuth.TokenEndpoint,
				RegistrationEndpoint:  spec.OAuth.RegistrationEndpoint,
				Resource:              spec.OAuth.Resource,
			},
			Record: oauth.Record{
				UpdatedAt:    now,
				Registration: map[string]any{},
				Revocation:   map[string]any{},
			},
		}

		if req.Oauth.Credentials.ClientId != nil {
			runtimeRecord.ClientID = strings.TrimSpace(*req.Oauth.Credentials.ClientId)
		}
		if req.Oauth.Credentials.ClientSecret != nil {
			runtimeRecord.ClientSecret = *req.Oauth.Credentials.ClientSecret
		}
		if req.Oauth.Credentials.Scopes != nil {
			runtimeRecord.Scopes = append([]string{}, (*req.Oauth.Credentials.Scopes)...)
		}
		if req.Oauth.Credentials.Registration != nil {
			runtimeRecord.Registration = copyJSONObject(*req.Oauth.Credentials.Registration)
		}
		if req.Oauth.Credentials.Revocation != nil {
			runtimeRecord.Revocation = copyJSONObject(*req.Oauth.Credentials.Revocation)
		}

		token := oauth2.Token{}
		if req.Oauth.Credentials.AccessToken != nil {
			token.AccessToken = *req.Oauth.Credentials.AccessToken
		}
		if req.Oauth.Credentials.RefreshToken != nil {
			token.RefreshToken = *req.Oauth.Credentials.RefreshToken
		}
		if req.Oauth.Credentials.TokenType != nil {
			token.TokenType = strings.TrimSpace(*req.Oauth.Credentials.TokenType)
		}
		if req.Oauth.Credentials.ExpiresAt != nil {
			token.Expiry = req.Oauth.Credentials.ExpiresAt.UTC()
		}
		if token.AccessToken != "" || token.RefreshToken != "" || token.TokenType != "" || !token.Expiry.IsZero() {
			runtimeRecord.Token = &token
		}
		record = runtimeRecord
	default:
		return nil, nil, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "type", Message: "must be static or oauth"},
		)
	}

	secret := &agentzv1alpha1.Secret{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Secret",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: ns,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
				Kind:       "Tenant",
				Name:       tenant.Name,
				UID:        tenant.UID,
			}},
		},
		Spec: spec,
	}
	if err := secretwebhook.Validate(secret); err != nil {
		return nil, nil, mapKubeHTTPError("create secret", err)
	}
	return secret, record, nil
}

func (s *Service) listAgentSecrets(namespace string, agentName string) ([]agentzv1alpha1.Secret, error) {
	list, err := s.resolver.secrets.Secrets(namespace).List(labels.Everything())
	if err != nil {
		return nil, err
	}

	items := make([]agentzv1alpha1.Secret, 0, len(list))
	for _, item := range list {
		if item.Spec.AgentRef.Name != agentName {
			continue
		}
		items = append(items, *item.DeepCopy())
	}
	return items, nil
}

func (s *Service) secretListItem(secret agentzv1alpha1.Secret) gatewayapi.SecretListItem {
	status, reason, message := secretLifecycle(secret)
	item := gatewayapi.SecretListItem{
		Key:       secret.Spec.Key,
		Hosts:     make([]gatewayapi.SecretHost, 0, len(secret.Spec.Hosts)),
		Status:    status,
		Reason:    reason,
		Message:   message,
		CreatedAt: secret.CreationTimestamp.UTC(),
	}
	item.Hosts = append(item.Hosts, secret.Spec.Hosts...)
	if secret.Spec.Type == agentzv1alpha1.SecretTypeOAuth {
		item.Type = gatewayapi.SecretType("oauth")
		if secret.Spec.OAuth != nil && strings.TrimSpace(secret.Spec.OAuth.Provider) != "" {
			item.Provider = &secret.Spec.OAuth.Provider
		}
		if secret.Status.LastRefreshTime != nil {
			value := secret.Status.LastRefreshTime.UTC()
			item.LastRefreshTime = &value
		}
		if secret.Status.TokenExpiryTime != nil {
			value := secret.Status.TokenExpiryTime.UTC()
			item.TokenExpiryTime = &value
		}
		return item
	}
	item.Type = gatewayapi.SecretType("static")
	return item
}

func secretLifecycle(secret agentzv1alpha1.Secret) (gatewayapi.SecretState, string, string) {
	switch secret.Status.State {
	case agentzv1alpha1.SecretStateReady:
		return gatewayapi.SecretState("ready"), agentzv1alpha1.SecretReasonReady, "Ready"
	case agentzv1alpha1.SecretStateDegraded:
		reason := secret.Status.LastRefreshFailureReason
		if reason == "" {
			reason = agentzv1alpha1.SecretReasonReconcileFailed
		}
		message := secret.Status.LastRefreshFailureMessage
		if message == "" {
			message = "Secret runtime is degraded"
		}
		return gatewayapi.SecretState("degraded"), reason, message
	default:
		return gatewayapi.SecretState("accepted"), agentzv1alpha1.SecretReasonAccepted, "Pending"
	}
}

func (s *Service) putAgentSecretRuntime(ctx context.Context, namespace, agentName, key string, record secretstore.Record) error {
	data, err := secretstore.RecordData(record)
	if err != nil {
		return err
	}
	_, err = s.baoKV.Put(ctx, secretstore.SecretPath(namespace, agentName, key), data)
	return err
}

func (s *Service) deleteAgentSecretRuntime(ctx context.Context, namespace, agentName, key string) error {
	err := s.baoKV.DeleteMetadata(ctx, secretstore.SecretPath(namespace, agentName, key))
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return nil
	}
	return err
}

func (s *Service) deleteAgentSecretResources(ctx context.Context, namespace, agentName string) error {
	items, err := s.listAgentSecrets(namespace, agentName)
	if err != nil {
		return err
	}
	for i := range items {
		if err := s.k8sClient.Delete(ctx, &items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func copyJSONObject(src gatewayapi.JSONObject) map[string]any {
	out := make(map[string]any, len(src))
	for key, value := range src {
		out[key] = value
	}
	return out
}

// syncAgentEnv updates the Agent CR spec.env by adding placeholder entries
// for secrets in add and removing entries whose Name matches keys in remove.
func (s *Service) syncAgentEnv(ctx context.Context, agentName string, add []string, remove []string) error {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return err
	}

	removeSet := make(map[string]struct{}, len(remove))
	for _, key := range remove {
		removeSet[strings.TrimSpace(key)] = struct{}{}
	}

	addSet := make(map[string]string, len(add))
	for _, key := range add {
		name := strings.TrimSpace(key)
		addSet[name] = sinjector.PlaceholderPrefix + name
	}

	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, err := s.resolver.client.AgentzV1alpha1().Agents(ns).Get(ctx, agentName, metav1.GetOptions{})
		if err != nil {
			return err
		}

		env := make([]corev1.EnvVar, 0, len(agt.Spec.Env))
		for _, item := range agt.Spec.Env {
			if _, ok := removeSet[item.Name]; ok {
				continue
			}
			if _, ok := addSet[item.Name]; ok {
				continue
			}
			env = append(env, item)
		}

		keys := make([]string, 0, len(addSet))
		for key := range addSet {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for _, key := range keys {
			env = append(env, corev1.EnvVar{Name: key, Value: addSet[key]})
		}

		agt.Spec.Env = env
		_, err = s.resolver.client.AgentzV1alpha1().Agents(ns).Update(ctx, agt, metav1.UpdateOptions{})
		return err
	})
}

func mapOpenBaoError(err error) *apiError {
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return newAPIError(http.StatusNotFound, "not_found", "secret not found", err)
	}
	return newAPIError(http.StatusInternalServerError, "internal_error", "request failed", err)
}
