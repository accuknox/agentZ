package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/oauth2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	mcpconnwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/mcpconn"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

type bearerSecretRecord struct {
	Token     string    `json:"token"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type oauthSecretRecord struct {
	ClientID     string         `json:"clientId,omitempty"`
	ClientSecret string         `json:"clientSecret,omitempty"`
	Token        *oauth2.Token  `json:"token,omitempty"`
	Scopes       []string       `json:"scopes,omitempty"`
	Registration map[string]any `json:"registration,omitempty"`
	Revocation   map[string]any `json:"revocation,omitempty"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}

// ListMCPConnections handles GET /api/mcp-connection/list.
func (s *Service) ListMCPConnections(w http.ResponseWriter, r *http.Request, params gatewayapi.ListMCPConnectionsParams) {
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	var connList clawarmorv1alpha1.MCPConnectionList
	err := s.k8sClient.List(r.Context(), &connList, ctrlclient.InNamespace(s.cfg.Namespace))
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list mcp connections: %w", err))
		return
	}

	items := make([]gatewayapi.MCPConnection, 0, len(connList.Items))
	for _, conn := range connList.Items {
		items = append(items, mcpConnectionFromCRD(conn))
	}
	slices.SortFunc(items, func(a, b gatewayapi.MCPConnection) int {
		return strings.Compare(a.Name, b.Name)
	})

	start := min(offset, len(items))
	end := min(start+limit, len(items))

	page := items[start:end]
	next := ""
	if end < len(items) {
		next = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListMCPConnectionsResponse{
		McpConnections: page,
		NextPageToken:  next,
	})
}

// CreateMCPConnection handles POST /api/mcp-connection.
func (s *Service) CreateMCPConnection(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateMCPConnectionRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name := strings.TrimSpace(req.Name)
	fields := validateMCPConnectionName(name, "name")
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

	conn := &clawarmorv1alpha1.MCPConnection{
		TypeMeta: metav1.TypeMeta{
			APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
			Kind:       "MCPConnection",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.cfg.Namespace,
		},
	}
	spec, fields := mcpConnectionSpecFromRequest(req.Endpoint, req.Auth)
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
	conn.Spec = spec
	setMCPConnectionSecretRef(name, &conn.Spec)

	mcpconnwebhook.NormalizeSpec(&conn.Spec)
	if err := mcpconnwebhook.ValidateResource(conn); err != nil {
		writeError(w, r, mapKubeHTTPError("create mcp connection", err))
		return
	}

	if err := s.k8sClient.Create(r.Context(), conn); err != nil {
		writeError(w, r, mapKubeHTTPError("create mcp connection", err))
		return
	}

	writeJSON(w, http.StatusCreated, mcpConnectionFromCRD(*conn))
}

// GetMCPConnection handles GET /api/mcp-connection/{name}.
func (s *Service) GetMCPConnection(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, mcpConnectionFromCRD(*conn))
}

// UpdateMCPConnection handles PUT /api/mcp-connection/{name}.
func (s *Service) UpdateMCPConnection(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	var req gatewayapi.UpdateMCPConnectionRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name = strings.TrimSpace(name)
	fields := validateMCPConnectionName(name, "name")
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

	var updated clawarmorv1alpha1.MCPConnection
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		conn := &clawarmorv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{Name: name, Namespace: s.cfg.Namespace}
		err := s.k8sClient.Get(r.Context(), key, conn)
		if err != nil {
			return err
		}

		spec, fields := mcpConnectionSpecFromRequest(req.Endpoint, req.Auth)
		if len(fields) > 0 {
			return newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			)
		}
		conn.Spec = spec
		setMCPConnectionSecretRef(name, &conn.Spec)
		mcpconnwebhook.NormalizeSpec(&conn.Spec)
		if err := mcpconnwebhook.ValidateResource(conn); err != nil {
			return err
		}

		if err := s.k8sClient.Update(r.Context(), conn); err != nil {
			return err
		}
		updated = *conn
		return nil
	})
	if err != nil {
		if apiErr, ok := errors.AsType[*apiError](err); ok {
			writeError(w, r, apiErr)
			return
		}
		writeError(w, r, mapKubeHTTPError("update mcp connection", err))
		return
	}

	writeJSON(w, http.StatusOK, mcpConnectionFromCRD(updated))
}

// DeleteMCPConnection handles DELETE /api/mcp-connection/{name}.
func (s *Service) DeleteMCPConnection(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}

	referrers, err := s.referencingEnvironments(r.Context(), conn.Name)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list environment references: %w", err))
		return
	}
	if len(referrers) > 0 {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"mcp connection is referenced by environments: "+strings.Join(referrers, ", "),
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "name",
				Message: "referenced by environments: " + strings.Join(referrers, ", "),
			},
		))
		return
	}

	if err := s.k8sClient.Delete(r.Context(), conn); err != nil {
		writeError(w, r, mapKubeHTTPError("delete mcp connection", err))
		return
	}
	if err := s.deleteMCPConnectionCredentials(r.Context(), *conn); err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// SetMCPConnectionCredentials handles POST /api/mcp-connection/{name}/credentials.
func (s *Service) SetMCPConnectionCredentials(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}

	var req gatewayapi.SetMCPConnectionCredentialsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	if conn.Spec.Auth == nil {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"mcp connection has no auth mode configured",
			errBadRequest,
		))
		return
	}

	now := time.Now().UTC()
	switch {
	case req.Bearer != nil && req.Oauth == nil:
		if conn.Spec.Auth.Bearer == nil || conn.Spec.Auth.Bearer.SecretRef == nil {
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"credential payload is incompatible with current auth mode",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "bearer",
					Message: "bearer auth is not configured on the connection",
				},
			))
			return
		}

		record := bearerSecretRecord{
			Token:     strings.TrimSpace(req.Bearer.Token),
			UpdatedAt: now,
		}
		if record.Token == "" {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{Field: "bearer.token", Message: "required"},
			))
			return
		}

		err := s.putMCPConnectionSecret(r.Context(), *conn.Spec.Auth.Bearer.SecretRef, record)
		if err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	case req.Oauth != nil && req.Bearer == nil:
		if conn.Spec.Auth.OAuth == nil || conn.Spec.Auth.OAuth.SecretRef == nil {
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"credential payload is incompatible with current auth mode",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "oauth",
					Message: "oauth auth is not configured on the connection",
				},
			))
			return
		}

		var clientID string
		if req.Oauth.ClientId != nil {
			clientID = strings.TrimSpace(*req.Oauth.ClientId)
		}
		var clientSecret string
		if req.Oauth.ClientSecret != nil {
			clientSecret = *req.Oauth.ClientSecret
		}
		record := oauthSecretRecord{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			UpdatedAt:    now,
		}
		if req.Oauth.Scopes != nil {
			record.Scopes = append([]string{}, (*req.Oauth.Scopes)...)
		}
		record.Registration = cloneJSONObject(req.Oauth.Registration)
		record.Revocation = cloneJSONObject(req.Oauth.Revocation)

		var accessToken string
		if req.Oauth.AccessToken != nil {
			accessToken = *req.Oauth.AccessToken
		}
		var tokenType string
		if req.Oauth.TokenType != nil {
			tokenType = strings.TrimSpace(*req.Oauth.TokenType)
		}
		var refreshToken string
		if req.Oauth.RefreshToken != nil {
			refreshToken = *req.Oauth.RefreshToken
		}
		token := oauth2.Token{
			AccessToken:  accessToken,
			TokenType:    tokenType,
			RefreshToken: refreshToken,
		}
		if req.Oauth.ExpiresAt != nil {
			token.Expiry = req.Oauth.ExpiresAt.UTC()
		}
		if token.AccessToken != "" || token.RefreshToken != "" || !token.Expiry.IsZero() || token.TokenType != "" {
			record.Token = &token
		}
		err := s.putMCPConnectionSecret(r.Context(), *conn.Spec.Auth.OAuth.SecretRef, record)
		if err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	default:
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "exactly one credential payload must be set",
			},
		))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeleteMCPConnectionCredentials handles DELETE /api/mcp-connection/{name}/credentials.
func (s *Service) DeleteMCPConnectionCredentials(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}

	if err := s.deleteMCPConnectionCredentials(r.Context(), *conn); err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) getMCPConnection(w http.ResponseWriter, r *http.Request, rawName string) (*clawarmorv1alpha1.MCPConnection, bool) {
	name := strings.TrimSpace(rawName)
	fields := validateMCPConnectionName(name, "name")
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return nil, false
	}

	conn := &clawarmorv1alpha1.MCPConnection{}
	key := ctrlclient.ObjectKey{Name: name, Namespace: s.cfg.Namespace}
	err := s.k8sClient.Get(r.Context(), key, conn)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("get mcp connection", err))
		return nil, false
	}
	return conn, true
}

func mcpConnectionSpecFromRequest(endpoint gatewayapi.MCPConnectionEndpoint, auth *gatewayapi.MCPConnectionAuth) (clawarmorv1alpha1.MCPConnectionSpec, []gatewayapi.FieldError) {
	spec := clawarmorv1alpha1.MCPConnectionSpec{
		Endpoint: clawarmorv1alpha1.MCPConnectionEndpoint{
			URL:                strings.TrimSpace(endpoint.Url),
			InsecureSkipVerify: endpoint.InsecureSkipVerify,
			Headers:            map[string]string{},
		},
	}
	if endpoint.Timeout != nil {
		duration, err := time.ParseDuration(strings.TrimSpace(*endpoint.Timeout))
		if err != nil {
			return spec, []gatewayapi.FieldError{{
				Field:   "endpoint.timeout",
				Message: "must be a valid duration",
			}}
		}
		spec.Endpoint.Timeout = &metav1.Duration{Duration: duration}
	}
	maps.Copy(spec.Endpoint.Headers, endpoint.Headers)

	if auth == nil {
		return spec, nil
	}

	spec.Auth = &clawarmorv1alpha1.MCPConnectionAuth{}
	if auth.Bearer != nil {
		spec.Auth.Bearer = &clawarmorv1alpha1.MCPConnectionBearerAuth{
			Location: authLocationFromRequest(auth.Bearer.Location),
		}
	}
	if auth.Oauth != nil {
		var issuer string
		if auth.Oauth.Issuer != nil {
			issuer = strings.TrimSpace(*auth.Oauth.Issuer)
		}
		var authorizationEndpoint string
		if auth.Oauth.AuthorizationEndpoint != nil {
			authorizationEndpoint = strings.TrimSpace(*auth.Oauth.AuthorizationEndpoint)
		}
		var tokenEndpoint string
		if auth.Oauth.TokenEndpoint != nil {
			tokenEndpoint = strings.TrimSpace(*auth.Oauth.TokenEndpoint)
		}
		var registrationEndpoint string
		if auth.Oauth.RegistrationEndpoint != nil {
			registrationEndpoint = strings.TrimSpace(*auth.Oauth.RegistrationEndpoint)
		}
		var resource string
		if auth.Oauth.Resource != nil {
			resource = strings.TrimSpace(*auth.Oauth.Resource)
		}
		spec.Auth.OAuth = &clawarmorv1alpha1.MCPConnectionOAuthAuth{
			Issuer:                issuer,
			AuthorizationEndpoint: authorizationEndpoint,
			TokenEndpoint:         tokenEndpoint,
			RegistrationEndpoint:  registrationEndpoint,
			Resource:              resource,
			Location:              authLocationFromRequest(auth.Oauth.Location),
		}
		if auth.Oauth.Scopes != nil {
			spec.Auth.OAuth.Scopes = append([]string{}, (*auth.Oauth.Scopes)...)
		}
	}
	if spec.Auth.Bearer == nil && spec.Auth.OAuth == nil {
		spec.Auth = nil
	}

	return spec, nil
}

func authLocationFromRequest(location *gatewayapi.MCPConnectionAuthLocation) *clawarmorv1alpha1.MCPConnectionAuthLocation {
	if location == nil {
		return nil
	}

	out := &clawarmorv1alpha1.MCPConnectionAuthLocation{}
	if location.Header != nil {
		out.Header = &clawarmorv1alpha1.MCPConnectionHeaderLocation{
			Name: strings.TrimSpace(location.Header.Name),
		}
		if location.Header.Prefix != nil {
			prefix := strings.TrimSpace(*location.Header.Prefix)
			out.Header.Prefix = &prefix
		}
	}
	if location.QueryParameter != nil {
		out.QueryParameter = &clawarmorv1alpha1.MCPConnectionQueryParameterLocation{
			Name: strings.TrimSpace(location.QueryParameter.Name),
		}
	}
	if location.Cookie != nil {
		out.Cookie = &clawarmorv1alpha1.MCPConnectionCookieLocation{
			Name: strings.TrimSpace(location.Cookie.Name),
		}
	}
	return out
}

func mcpConnectionFromCRD(conn clawarmorv1alpha1.MCPConnection) gatewayapi.MCPConnection {
	headers := map[string]string{}
	maps.Copy(headers, conn.Spec.Endpoint.Headers)

	endpoint := gatewayapi.MCPConnectionEndpoint{
		Url:                conn.Spec.Endpoint.URL,
		InsecureSkipVerify: conn.Spec.Endpoint.InsecureSkipVerify,
		Headers:            headers,
	}
	if conn.Spec.Endpoint.Timeout != nil {
		timeout := conn.Spec.Endpoint.Timeout.Duration.String()
		endpoint.Timeout = &timeout
	}

	status := gatewayapi.MCPConnectionStatus{
		ObservedGeneration: conn.Status.ObservedGeneration,
		Conditions:         []gatewayapi.MCPConnectionCondition{},
	}
	if conn.Status.State != "" {
		state := gatewayapi.MCPConnectionState(conn.Status.State)
		status.State = &state
	}
	for _, cond := range conn.Status.Conditions {
		status.Conditions = append(status.Conditions, gatewayapi.MCPConnectionCondition{
			Type:               cond.Type,
			Status:             string(cond.Status),
			Reason:             cond.Reason,
			Message:            cond.Message,
			ObservedGeneration: cond.ObservedGeneration,
			LastTransitionTime: cond.LastTransitionTime.Time,
		})
	}
	if conn.Status.ServiceRef != nil {
		status.ServiceRef = &gatewayapi.MCPConnectionManagedResourceRef{
			Namespace: conn.Status.ServiceRef.Namespace,
			Name:      conn.Status.ServiceRef.Name,
		}
	}
	if conn.Status.AuthPolicyRef != nil {
		status.AuthPolicyRef = &gatewayapi.MCPConnectionManagedResourceRef{
			Namespace: conn.Status.AuthPolicyRef.Namespace,
			Name:      conn.Status.AuthPolicyRef.Name,
		}
	}

	out := gatewayapi.MCPConnection{
		Name:      conn.Name,
		Endpoint:  endpoint,
		CreatedAt: conn.CreationTimestamp.Time,
		Status:    status,
	}
	if conn.Spec.Auth != nil {
		out.Auth = &gatewayapi.MCPConnectionAuth{}
		if conn.Spec.Auth.Bearer != nil {
			out.Auth.Bearer = &gatewayapi.MCPConnectionBearerAuth{
				Location: authLocationToResponse(conn.Spec.Auth.Bearer.Location),
			}
		}
		if conn.Spec.Auth.OAuth != nil {
			out.Auth.Oauth = &gatewayapi.MCPConnectionOAuthAuth{
				Location: authLocationToResponse(conn.Spec.Auth.OAuth.Location),
			}
			if conn.Spec.Auth.OAuth.Issuer != "" {
				value := conn.Spec.Auth.OAuth.Issuer
				out.Auth.Oauth.Issuer = &value
			}
			if conn.Spec.Auth.OAuth.AuthorizationEndpoint != "" {
				value := conn.Spec.Auth.OAuth.AuthorizationEndpoint
				out.Auth.Oauth.AuthorizationEndpoint = &value
			}
			if conn.Spec.Auth.OAuth.TokenEndpoint != "" {
				value := conn.Spec.Auth.OAuth.TokenEndpoint
				out.Auth.Oauth.TokenEndpoint = &value
			}
			if conn.Spec.Auth.OAuth.RegistrationEndpoint != "" {
				value := conn.Spec.Auth.OAuth.RegistrationEndpoint
				out.Auth.Oauth.RegistrationEndpoint = &value
			}
			if conn.Spec.Auth.OAuth.Resource != "" {
				value := conn.Spec.Auth.OAuth.Resource
				out.Auth.Oauth.Resource = &value
			}
			if conn.Spec.Auth.OAuth.Scopes != nil {
				scopes := append([]string{}, conn.Spec.Auth.OAuth.Scopes...)
				out.Auth.Oauth.Scopes = &scopes
			}
		}
	}

	return out
}

func authLocationToResponse(location *clawarmorv1alpha1.MCPConnectionAuthLocation) *gatewayapi.MCPConnectionAuthLocation {
	if location == nil {
		return nil
	}

	out := &gatewayapi.MCPConnectionAuthLocation{}
	if location.Header != nil {
		out.Header = &gatewayapi.MCPConnectionHeaderLocation{
			Name: location.Header.Name,
		}
		if location.Header.Prefix != nil {
			prefix := *location.Header.Prefix
			out.Header.Prefix = &prefix
		}
	}
	if location.QueryParameter != nil {
		out.QueryParameter = &gatewayapi.MCPConnectionQueryParameterLocation{
			Name: location.QueryParameter.Name,
		}
	}
	if location.Cookie != nil {
		out.Cookie = &gatewayapi.MCPConnectionCookieLocation{
			Name: location.Cookie.Name,
		}
	}
	return out
}

func validateMCPConnectionName(name string, fieldName string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   fieldName,
			Message: "required",
		})
		return fields
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   fieldName,
			Message: "must be at most 32 characters",
		})
	}
	for _, msg := range validation.IsDNS1123Label(name) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   fieldName,
			Message: msg,
		})
	}
	return fields
}

func (s *Service) referencingEnvironments(ctx context.Context, connectionName string) ([]string, error) {
	var envList clawarmorv1alpha1.EnvironmentList
	if err := s.k8sClient.List(ctx, &envList, ctrlclient.InNamespace(s.cfg.Namespace)); err != nil {
		return nil, err
	}

	var referrers []string
	for _, env := range envList.Items {
		for _, ref := range env.Spec.MCPConnectionRefs {
			if ref.Name != connectionName {
				continue
			}
			referrers = append(referrers, env.Name)
			break
		}
	}
	slices.Sort(referrers)
	return referrers, nil
}

func (s *Service) putMCPConnectionSecret(ctx context.Context, ref clawarmorv1alpha1.MCPConnectionSecretRef, record any) error {
	data, err := s.readMCPConnectionSecretData(ctx, ref.Path)
	if err != nil {
		return err
	}

	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal mcp connection secret: %w", err)
	}
	data[ref.Key] = string(encoded)

	if _, err := s.baoKV.Put(ctx, ref.Path, data); err != nil {
		return err
	}
	return nil
}

func (s *Service) deleteMCPConnectionCredentials(ctx context.Context, conn clawarmorv1alpha1.MCPConnection) error {
	if conn.Spec.Auth == nil {
		return nil
	}
	if conn.Spec.Auth.Bearer != nil && conn.Spec.Auth.Bearer.SecretRef != nil {
		return s.deleteMCPConnectionSecret(ctx, *conn.Spec.Auth.Bearer.SecretRef)
	}
	if conn.Spec.Auth.OAuth != nil && conn.Spec.Auth.OAuth.SecretRef != nil {
		return s.deleteMCPConnectionSecret(ctx, *conn.Spec.Auth.OAuth.SecretRef)
	}
	return nil
}

func (s *Service) deleteMCPConnectionSecret(ctx context.Context, ref clawarmorv1alpha1.MCPConnectionSecretRef) error {
	data, err := s.readMCPConnectionSecretData(ctx, ref.Path)
	if err != nil {
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			return nil
		}
		return err
	}

	delete(data, ref.Key)
	if len(data) == 0 {
		if err := s.baoKV.DeleteMetadata(ctx, ref.Path); err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
			return err
		}
		return nil
	}

	if _, err := s.baoKV.Put(ctx, ref.Path, data); err != nil {
		return err
	}
	return nil
}

func (s *Service) readMCPConnectionSecretData(ctx context.Context, path string) (map[string]any, error) {
	secret, err := s.baoKV.Get(ctx, path)
	if err != nil {
		if errors.Is(err, baoapi.ErrSecretNotFound) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if secret == nil || secret.Data == nil {
		return map[string]any{}, nil
	}

	data := make(map[string]any, len(secret.Data))
	maps.Copy(data, secret.Data)
	return data, nil
}

func setMCPConnectionSecretRef(name string, spec *clawarmorv1alpha1.MCPConnectionSpec) {
	if spec.Auth == nil {
		return
	}
	if spec.Auth.Bearer != nil {
		spec.Auth.Bearer.SecretRef = &clawarmorv1alpha1.MCPConnectionSecretRef{
			Path: "mcp-connections/" + name,
			Key:  "credentials",
		}
	}
	if spec.Auth.OAuth != nil {
		spec.Auth.OAuth.SecretRef = &clawarmorv1alpha1.MCPConnectionSecretRef{
			Path: "mcp-connections/" + name,
			Key:  "credentials",
		}
	}
}

func cloneJSONObject(raw *gatewayapi.JSONObject) map[string]any {
	if raw == nil {
		return nil
	}

	value := make(map[string]any, len(*raw))
	for key, item := range *raw {
		value[key] = item
	}
	return value
}
