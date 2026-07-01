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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	internalmcp "github.com/accuknox/clawarmor/internal/mcp"
	internaloauth "github.com/accuknox/clawarmor/internal/oauth"
	mcpconnwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/mcpconn"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const mcpInternalErrorMessage = "Internal error"

func writeMCPAPIError(w http.ResponseWriter, r *http.Request, err *apiError) {
	if err != nil && err.Status >= http.StatusInternalServerError {
		err.Message = mcpInternalErrorMessage
	}
	writeError(w, r, err)
}

// ListMCPConnections handles GET /api/mcp-connection.
func (s *Service) ListMCPConnections(w http.ResponseWriter, r *http.Request, params gatewayapi.ListMCPConnectionsParams) {
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	items, err := s.listMCPConnectionSummaries(r.Context(), nil)
	if err != nil {
		writeMCPInternalError(w, r, err)
		return
	}

	start := min(offset, len(items))
	end := min(start+limit, len(items))

	resp := gatewayapi.ListMCPConnectionsResponse{
		McpConnections: items[start:end],
		NextPageToken:  "",
	}
	if end < len(items) {
		resp.NextPageToken = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, resp)
}

// WatchMCPConnections handles POST /api/mcp-connection/watch.
//
//nolint:gocyclo
func (s *Service) WatchMCPConnections(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.WatchMCPConnectionsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}

	names := []string{}
	nameFilter := map[string]struct{}{}
	if req.Names != nil {
		names = make([]string, 0, len(*req.Names))
		for _, rawName := range *req.Names {
			name := strings.TrimSpace(rawName)
			fields := validateMCPConnectionName(name, "names")
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
			names = append(names, name)
			nameFilter[name] = struct{}{}
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeMCPInternalError(w, r, errors.New("streaming is unavailable"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := map[string]gatewayapi.MCPConnectionSummary{}
	var staleTimer *time.Timer
	var staleTimerCh <-chan time.Time
	send := func(event string, items []gatewayapi.MCPConnectionSummary) bool {
		if len(items) == 0 {
			return true
		}

		raw, err := json.Marshal(gatewayapi.WatchMCPConnectionsEvent{
			McpConnections: items,
		})
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

	resetStaleTimer := func(items []gatewayapi.MCPConnectionSummary) {
		if staleTimer != nil {
			staleTimer.Stop()
			staleTimer = nil
			staleTimerCh = nil
		}

		now := time.Now()
		hasPending := false
		next := s.cfg.MCPProbeStaleAfter
		for _, item := range items {
			if item.Status != gatewayapi.MCPConnectionLifecycleAccepted {
				continue
			}
			hasPending = true

			conn, err := s.resolver.mcpConnections.MCPConnections(ns).Get(item.Name)
			if err != nil || conn.Status.LastProbeTime == nil {
				next = 0
				break
			}

			wait := max(conn.Status.LastProbeTime.Time.Add(s.cfg.MCPProbeStaleAfter).Sub(now), 0)
			if wait < next {
				next = wait
			}
		}

		if !hasPending {
			return
		}
		staleTimer = time.NewTimer(next)
		staleTimerCh = staleTimer.C
	}

	writeChanges := func() bool {
		items, err := s.listMCPConnectionSummaries(r.Context(), names)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		changed := make([]gatewayapi.MCPConnectionSummary, 0, len(items))
		for _, item := range items {
			prevItem, ok := prev[item.Name]
			unchanged := ok &&
				prevItem.Name == item.Name &&
				prevItem.AuthMode == item.AuthMode &&
				prevItem.EndpointUrl == item.EndpointUrl &&
				prevItem.CreatedAt.Equal(item.CreatedAt) &&
				prevItem.Status == item.Status &&
				prevItem.Reason == item.Reason &&
				prevItem.Message == item.Message &&
				prevItem.ToolCatalogReady == item.ToolCatalogReady &&
				prevItem.ToolCount == item.ToolCount
			if unchanged {
				continue
			}
			prev[item.Name] = item
			changed = append(changed, item)
		}
		resetStaleTimer(items)
		return send("", changed)
	}

	events, cancel := s.resolver.watchMCPConnections()
	defer cancel()
	defer func() {
		if staleTimer != nil {
			staleTimer.Stop()
		}
	}()

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
			if evt.Type == mcpConnectionWatchEventDeleted {
				if evt.Connection == nil {
					continue
				}
				if len(nameFilter) > 0 {
					if _, ok := nameFilter[evt.Connection.Name]; !ok {
						continue
					}
				}

				item, ok := prev[evt.Connection.Name]
				delete(prev, evt.Connection.Name)
				if ok {
					if !send("DELETE", []gatewayapi.MCPConnectionSummary{item}) {
						return
					}
				}
				continue
			}
			if !writeChanges() {
				return
			}
		case <-staleTimerCh:
			if !writeChanges() {
				return
			}
		}
	}
}

// CreateMCPConnection handles POST /api/mcp-connection.
func (s *Service) CreateMCPConnection(w http.ResponseWriter, r *http.Request) {
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
			Namespace: ns,
			OwnerReferences: []metav1.OwnerReference{
				{
					APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
					Kind:       "Tenant",
					Name:       tenant.Name,
					UID:        tenant.UID,
				},
			},
		},
	}

	spec, fields := mcpConnectionSpecFromRequest(req.Endpoint, &req.Auth)
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

	mcpconnwebhook.ApplyDefaults(&conn.Spec)
	if err := mcpconnwebhook.Validate(conn); err != nil {
		writeMCPAPIError(w, r, mapKubeHTTPError("create mcp connection", err))
		return
	}
	if err := s.putMCPConnectionCredentials(r.Context(), conn.Spec, req.Credentials); err != nil {
		writeMCPAPIError(w, r, err)
		return
	}
	if err := s.k8sClient.Create(r.Context(), conn); err != nil {
		delErr := s.deleteMCPConnectionCredentials(r.Context(), *conn)
		if delErr != nil {
			err = errors.Join(err, delErr)
		}
		writeMCPAPIError(w, r, mapKubeHTTPError("create mcp connection", err))
		return
	}

	writeJSON(w, http.StatusCreated, s.mcpConnectionDetail(*conn))
}

// GetMCPConnection handles GET /api/mcp-connection/{name}.
func (s *Service) GetMCPConnection(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.mcpConnectionDetail(*conn))
}

// DeleteMCPConnection handles DELETE /api/mcp-connection/{name}.
func (s *Service) DeleteMCPConnection(w http.ResponseWriter, r *http.Request, name gatewayapi.MCPConnectionNamePath) {
	conn, ok := s.getMCPConnection(w, r, name)
	if !ok {
		return
	}

	referrers, err := s.referencingEnvironments(r.Context(), conn.Name)
	if err != nil {
		writeMCPInternalError(w, r, fmt.Errorf("list environment references: %w", err))
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
		writeMCPAPIError(w, r, mapKubeHTTPError("delete mcp connection", err))
		return
	}
	if err := s.deleteMCPConnectionCredentials(r.Context(), *conn); err != nil {
		writeMCPAPIError(w, r, mapOpenBaoError(err))
		return
	}
	if err := s.waitForMCPConnectionDeletion(r.Context(), conn.Name); err != nil {
		writeMCPInternalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) getMCPConnection(w http.ResponseWriter, r *http.Request, rawName string) (*clawarmorv1alpha1.MCPConnection, bool) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return nil, false
	}

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
	key := ctrlclient.ObjectKey{Name: name, Namespace: ns}
	if err := s.k8sClient.Get(r.Context(), key, conn); err != nil {
		writeMCPAPIError(w, r, mapKubeHTTPError("get mcp connection", err))
		return nil, false
	}
	return conn, true
}

// listMCPConnections returns all MCPConnection resources in the service
// namespace.
func (s *Service) listMCPConnections(ctx context.Context) ([]clawarmorv1alpha1.MCPConnection, error) {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return nil, err
	}

	list, err := s.resolver.mcpConnections.MCPConnections(ns).List(labels.Everything())
	if err != nil {
		return nil, fmt.Errorf("list mcp connections: %w", err)
	}

	items := make([]clawarmorv1alpha1.MCPConnection, 0, len(list))
	for _, item := range list {
		items = append(items, *item.DeepCopy())
	}
	return items, nil
}

func (s *Service) listMCPConnectionSummaries(ctx context.Context, names []string) ([]gatewayapi.MCPConnectionSummary, error) {
	items, err := s.listMCPConnections(ctx)
	if err != nil {
		return nil, err
	}

	summaries := make([]gatewayapi.MCPConnectionSummary, 0, len(items))
	for _, conn := range items {
		if len(names) > 0 && !slices.Contains(names, conn.Name) {
			continue
		}
		summaries = append(summaries, s.mcpConnectionSummary(conn))
	}
	slices.SortFunc(summaries, func(a, b gatewayapi.MCPConnectionSummary) int {
		return strings.Compare(a.Name, b.Name)
	})
	return summaries, nil
}

func (s *Service) mcpConnectionSummary(conn clawarmorv1alpha1.MCPConnection) gatewayapi.MCPConnectionSummary {
	status, reason, message := s.mcpConnectionStatus(conn)
	return gatewayapi.MCPConnectionSummary{
		Name:             conn.Name,
		AuthMode:         conn.Status.AuthMode,
		EndpointUrl:      conn.Spec.Endpoint.URL,
		CreatedAt:        conn.CreationTimestamp.Time,
		Status:           status,
		Reason:           reason,
		Message:          message,
		ToolCatalogReady: conn.Status.ToolCatalogReady,
		ToolCount:        int64(len(conn.Status.Tools)),
	}
}

func (s *Service) mcpConnectionDetail(conn clawarmorv1alpha1.MCPConnection) gatewayapi.MCPConnectionDetail {
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

	auth := gatewayapi.MCPConnectionAuth{}
	if conn.Spec.Auth != nil && conn.Spec.Auth.Bearer != nil {
		auth.Bearer = &gatewayapi.MCPConnectionBearerAuth{
			Location: authLocationToResponse(conn.Spec.Auth.Bearer.Location),
		}
	}
	if conn.Spec.Auth != nil && conn.Spec.Auth.OAuth != nil {
		auth.Oauth = &gatewayapi.MCPConnectionOAuthAuth{
			Location: authLocationToResponse(conn.Spec.Auth.OAuth.Location),
		}
		if conn.Spec.Auth.OAuth.Issuer != "" {
			value := conn.Spec.Auth.OAuth.Issuer
			auth.Oauth.Issuer = &value
		}
		if conn.Spec.Auth.OAuth.AuthorizationEndpoint != "" {
			value := conn.Spec.Auth.OAuth.AuthorizationEndpoint
			auth.Oauth.AuthorizationEndpoint = &value
		}
		if conn.Spec.Auth.OAuth.TokenEndpoint != "" {
			value := conn.Spec.Auth.OAuth.TokenEndpoint
			auth.Oauth.TokenEndpoint = &value
		}
		if conn.Spec.Auth.OAuth.RegistrationEndpoint != "" {
			value := conn.Spec.Auth.OAuth.RegistrationEndpoint
			auth.Oauth.RegistrationEndpoint = &value
		}
		if conn.Spec.Auth.OAuth.Resource != "" {
			value := conn.Spec.Auth.OAuth.Resource
			auth.Oauth.Resource = &value
		}
		if len(conn.Spec.Auth.OAuth.Scopes) > 0 {
			scopes := append([]string{}, conn.Spec.Auth.OAuth.Scopes...)
			auth.Oauth.Scopes = &scopes
		}
	}

	status, reason, message := s.mcpConnectionStatus(conn)
	tools := make([]gatewayapi.MCPConnectionTool, 0, len(conn.Status.Tools))
	for _, tool := range conn.Status.Tools {
		tools = append(tools, gatewayapi.MCPConnectionTool{Name: tool.Name})
	}
	return gatewayapi.MCPConnectionDetail{
		Name:             conn.Name,
		CreatedAt:        conn.CreationTimestamp.Time,
		Endpoint:         endpoint,
		Auth:             auth,
		Status:           status,
		Reason:           reason,
		Message:          message,
		ToolCatalogReady: conn.Status.ToolCatalogReady,
		Tools:            tools,
	}
}

func (s *Service) mcpConnectionStatus(conn clawarmorv1alpha1.MCPConnection) (gatewayapi.MCPConnectionLifecycle, gatewayapi.MCPConnectionReason, string) {
	accepted := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionAccepted)
	degraded := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionDegraded)
	probeHealthy := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionProbeHealthy)
	unreachable := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionConnectionUnreachable)
	credentialsInvalid := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionCredentialsInvalid)
	protocolError := apimeta.FindStatusCondition(conn.Status.Conditions, internalmcp.ConditionProtocolError)

	if conn.Status.State == clawarmorv1alpha1.MCPConnectionStateDegraded ||
		(accepted != nil && accepted.Status == metav1.ConditionFalse) ||
		(degraded != nil && degraded.Status == metav1.ConditionTrue) {
		message := statusConditionMessage(mcpInternalErrorMessage, degraded, accepted)
		return gatewayapi.MCPConnectionLifecycleError, gatewayapi.MCPConnectionReasonInternalError, message
	}
	if conn.Status.LastProbeTime == nil ||
		time.Since(conn.Status.LastProbeTime.Time) > s.cfg.MCPProbeStaleAfter ||
		probeHealthy == nil ||
		probeHealthy.Status == metav1.ConditionUnknown {
		message := statusConditionMessage("Status check pending", probeHealthy, accepted)
		return gatewayapi.MCPConnectionLifecycleAccepted, gatewayapi.MCPConnectionReasonProbePending, message
	}

	if probeHealthy.Status == metav1.ConditionTrue {
		message := statusConditionMessage("Ready", probeHealthy, accepted)
		return gatewayapi.MCPConnectionLifecycleReady, gatewayapi.MCPConnectionReasonReady, message
	}

	switch {
	case unreachable != nil && unreachable.Status == metav1.ConditionTrue:
		message := statusConditionMessage("Server unreachable", unreachable, probeHealthy)
		return gatewayapi.MCPConnectionLifecycleError, gatewayapi.MCPConnectionReasonUnreachable, message
	case credentialsInvalid != nil && credentialsInvalid.Status == metav1.ConditionTrue:
		message := statusConditionMessage(
			"Credentials invalid",
			credentialsInvalid,
			probeHealthy,
		)
		return gatewayapi.MCPConnectionLifecycleError, gatewayapi.MCPConnectionReasonInvalidCredentials, message
	case protocolError != nil && protocolError.Status == metav1.ConditionTrue:
		message := statusConditionMessage("Protocol error", protocolError, probeHealthy)
		return gatewayapi.MCPConnectionLifecycleError, gatewayapi.MCPConnectionReasonProtocolError, message
	default:
		return gatewayapi.MCPConnectionLifecycleError, gatewayapi.MCPConnectionReasonInternalError, mcpInternalErrorMessage
	}
}

func statusConditionMessage(fallback string, conditions ...*metav1.Condition) string {
	for _, cond := range conditions {
		if cond == nil {
			continue
		}
		message := strings.TrimSpace(cond.Message)
		if message != "" {
			return message
		}
	}

	return fallback
}

func (s *Service) waitForMCPConnectionDeletion(ctx context.Context, name string) error {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return err
	}

	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		conn := &clawarmorv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{Namespace: ns, Name: name}
		err := s.k8sClient.Get(ctx, key, conn)
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("wait for mcp connection deletion: %w", err)
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for mcp connection deletion: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func writeMCPInternalError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusInternalServerError,
		"internal_error",
		mcpInternalErrorMessage,
		err,
	))
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
		spec.Auth.OAuth = &clawarmorv1alpha1.MCPConnectionOAuthAuth{
			Location: authLocationFromRequest(auth.Oauth.Location),
		}
		if auth.Oauth.Issuer != nil {
			spec.Auth.OAuth.Issuer = strings.TrimSpace(*auth.Oauth.Issuer)
		}
		if auth.Oauth.AuthorizationEndpoint != nil {
			spec.Auth.OAuth.AuthorizationEndpoint = strings.TrimSpace(*auth.Oauth.AuthorizationEndpoint)
		}
		if auth.Oauth.TokenEndpoint != nil {
			spec.Auth.OAuth.TokenEndpoint = strings.TrimSpace(*auth.Oauth.TokenEndpoint)
		}
		if auth.Oauth.RegistrationEndpoint != nil {
			spec.Auth.OAuth.RegistrationEndpoint = strings.TrimSpace(*auth.Oauth.RegistrationEndpoint)
		}
		if auth.Oauth.Resource != nil {
			spec.Auth.OAuth.Resource = strings.TrimSpace(*auth.Oauth.Resource)
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
		out.Header = &clawarmorv1alpha1.MCPConnectionHeaderLocation{Name: strings.TrimSpace(location.Header.Name)}
		if location.Header.Prefix != nil {
			prefix := strings.TrimSpace(*location.Header.Prefix)
			out.Header.Prefix = &prefix
		}
	}
	if location.QueryParameter != nil {
		out.QueryParameter = &clawarmorv1alpha1.MCPConnectionQueryParameterLocation{Name: strings.TrimSpace(location.QueryParameter.Name)}
	}
	if location.Cookie != nil {
		out.Cookie = &clawarmorv1alpha1.MCPConnectionCookieLocation{Name: strings.TrimSpace(location.Cookie.Name)}
	}
	return out
}

func authLocationToResponse(location *clawarmorv1alpha1.MCPConnectionAuthLocation) *gatewayapi.MCPConnectionAuthLocation {
	if location == nil {
		return nil
	}

	out := &gatewayapi.MCPConnectionAuthLocation{}
	if location.Header != nil {
		out.Header = &gatewayapi.MCPConnectionHeaderLocation{Name: location.Header.Name}
		if location.Header.Prefix != nil {
			prefix := *location.Header.Prefix
			out.Header.Prefix = &prefix
		}
	}
	if location.QueryParameter != nil {
		out.QueryParameter = &gatewayapi.MCPConnectionQueryParameterLocation{Name: location.QueryParameter.Name}
	}
	if location.Cookie != nil {
		out.Cookie = &gatewayapi.MCPConnectionCookieLocation{Name: location.Cookie.Name}
	}
	return out
}

func validateMCPConnectionName(name string, fieldName string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if name == "" {
		return append(fields, gatewayapi.FieldError{Field: fieldName, Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{Field: fieldName, Message: "must be at most 32 characters"})
	}
	for _, msg := range validation.IsDNS1123Label(name) {
		fields = append(fields, gatewayapi.FieldError{Field: fieldName, Message: msg})
	}
	return fields
}

func (s *Service) referencingEnvironments(ctx context.Context, connectionName string) ([]string, error) {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return nil, err
	}

	var envList clawarmorv1alpha1.EnvironmentList
	if err := s.k8sClient.List(ctx, &envList, ctrlclient.InNamespace(ns)); err != nil {
		return nil, err
	}

	referrers := []string{}
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
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal mcp connection secret: %w", err)
	}

	data := map[string]any{ref.Key: string(encoded)}
	if _, err := s.baoKV.Put(ctx, ref.Path, data); err != nil {
		return err
	}
	return nil
}

func (s *Service) putMCPConnectionCredentials(ctx context.Context, spec clawarmorv1alpha1.MCPConnectionSpec, req gatewayapi.MCPConnectionCredentials) *apiError {
	if spec.Auth == nil {
		return newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "credentials",
				Message: "credentials require an auth mode",
			},
		)
	}

	now := time.Now().UTC()
	switch {
	case req.Bearer != nil && req.Oauth == nil:
		if spec.Auth.Bearer == nil || spec.Auth.Bearer.SecretRef == nil {
			return newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "credentials.bearer",
					Message: "bearer credentials do not match auth mode",
				},
			)
		}

		token := strings.TrimSpace(req.Bearer.Token)
		if token == "" {
			return newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "credentials.bearer.token",
					Message: "required",
				},
			)
		}

		record := internalmcp.BearerSecretRecord{
			Token:     token,
			UpdatedAt: now,
		}
		if err := s.putMCPConnectionSecret(ctx, *spec.Auth.Bearer.SecretRef, record); err != nil {
			return mapOpenBaoError(err)
		}
		return nil
	case req.Oauth != nil && req.Bearer == nil:
		if spec.Auth.OAuth == nil || spec.Auth.OAuth.SecretRef == nil {
			return newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "credentials.oauth",
					Message: "oauth credentials do not match auth mode",
				},
			)
		}

		record := internalmcp.OAuthSecretRecord{
			Record: internaloauth.Record{UpdatedAt: now},
		}
		if req.Oauth.ClientId != nil {
			record.ClientID = strings.TrimSpace(*req.Oauth.ClientId)
		}
		if req.Oauth.ClientSecret != nil {
			record.ClientSecret = *req.Oauth.ClientSecret
		}
		if req.Oauth.Scopes != nil {
			record.Scopes = append([]string{}, (*req.Oauth.Scopes)...)
		}
		if req.Oauth.Registration != nil {
			record.Registration = make(map[string]any, len(*req.Oauth.Registration))
			for key, value := range *req.Oauth.Registration {
				record.Registration[key] = value
			}
		}
		if req.Oauth.Revocation != nil {
			record.Revocation = make(map[string]any, len(*req.Oauth.Revocation))
			for key, value := range *req.Oauth.Revocation {
				record.Revocation[key] = value
			}
		}

		token := oauth2.Token{}
		if req.Oauth.AccessToken != nil {
			token.AccessToken = *req.Oauth.AccessToken
		}
		if req.Oauth.TokenType != nil {
			token.TokenType = strings.TrimSpace(*req.Oauth.TokenType)
		}
		if req.Oauth.RefreshToken != nil {
			token.RefreshToken = *req.Oauth.RefreshToken
		}
		if req.Oauth.ExpiresAt != nil {
			token.Expiry = req.Oauth.ExpiresAt.UTC()
		}
		if token.AccessToken != "" || token.RefreshToken != "" ||
			token.TokenType != "" || !token.Expiry.IsZero() {
			record.Token = &token
		}

		if err := s.putMCPConnectionSecret(ctx, *spec.Auth.OAuth.SecretRef, record); err != nil {
			return mapOpenBaoError(err)
		}
		return nil
	default:
		return newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "credentials",
				Message: "exactly one credential payload must be set",
			},
		)
	}
}

func setMCPConnectionSecretRef(name string, spec *clawarmorv1alpha1.MCPConnectionSpec) {
	if spec == nil || spec.Auth == nil {
		return
	}

	path := internalmcp.SecretPath(name)
	if spec.Auth.Bearer != nil {
		spec.Auth.Bearer.SecretRef = &clawarmorv1alpha1.MCPConnectionSecretRef{
			Path: path,
			Key:  internalmcp.SecretRecordKey,
		}
	}
	if spec.Auth.OAuth != nil {
		spec.Auth.OAuth.SecretRef = &clawarmorv1alpha1.MCPConnectionSecretRef{
			Path: path,
			Key:  internalmcp.SecretRecordKey,
		}
	}
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
	if err := s.baoKV.DeleteMetadata(ctx, ref.Path); err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
		return err
	}
	return nil
}
