package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	gatewaydb "github.com/accuknox/clawarmor/internal/gateway/db"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	openCodeAPIKeyConfigID      = "opencode"
	opencodePrefix              = "/api/opencode"
	opencodeProxyBodyLimitBytes = 16 * 1024 * 1024
)

var opencodeProxyBodyLimitedMethods = map[string]struct{}{
	http.MethodPatch:  {},
	http.MethodPost:   {},
	http.MethodPut:    {},
	http.MethodDelete: {},
}

var opencodeSessionDeleteSegments = pathSegments("/api/opencode/{agentName}/session/{sessionID}")

type opencodeRoute struct {
	Method   string
	Segments []string
}

type opencodeSessionDeleteTarget struct {
	agentName string
	sessionID string
}

type openCodePermissions struct {
	Opencode []string `json:"opencode"`
}

type sessionTraceStore interface {
	GatewayDeleteSessionTraces(ctx context.Context, arg gatewaydb.GatewayDeleteSessionTracesParams) (int64, error)
}

// handleOpenCodeProxy resolves and proxies supported OpenCode requests.
func (s *Service) handleOpenCodeProxy(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName, ok := validAgentName(w, r, chi.URLParam(r, "agentName"), "agentName")
	if !ok {
		return
	}

	route, methodAllowed := matchOpenCodeRoute(r.Method, r.URL.Path)
	if route == nil {
		if methodAllowed {
			writeError(w, r, newAPIError(
				http.StatusMethodNotAllowed,
				"method_not_allowed",
				"method is not allowed for this route",
				nil,
			))
			return
		}

		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"route not found",
			nil,
		))
		return
	}
	resolved, err := s.resolver.resolveAgent(r.Context(), ns, agentName)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
			err,
		))
		return
	}

	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	path, rawPath, err := openCodeUpstreamPath(r.URL, agentName)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"route not found",
			err,
		))
		return
	}

	if opencodeProxyBodyLimitEnabled(r.Method) {
		if r.ContentLength > opencodeProxyBodyLimitBytes {
			writeError(w, r, newAPIError(
				http.StatusRequestEntityTooLarge,
				"request_too_large",
				"request body exceeds the maximum allowed size",
				nil,
			))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, opencodeProxyBodyLimitBytes)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(preq *httputil.ProxyRequest) {
			preq.Out.URL.Scheme = target.Scheme
			preq.Out.URL.Host = target.Host
			preq.Out.Host = target.Host
			preq.Out.URL.Path = path
			preq.Out.URL.RawPath = rawPath
			// the gateway terminates client auth. Upstream agent pods must
			// never receive caller credentials they do not verify.
			preq.Out.Header.Del("Authorization")
			preq.Out.Header.Del("Proxy-Authorization")
			preq.SetXForwarded()
			preq.Out.Header.Set("X-Request-ID", requestID(preq.In))
		},
		ModifyResponse: s.openCodeModifyResponse(r.Context(), route, r.URL.Path, agentName),
		FlushInterval:  -1,
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			if _, ok := errors.AsType[*http.MaxBytesError](proxyErr); ok {
				writeError(rw, req, newAPIError(
					http.StatusRequestEntityTooLarge,
					"request_too_large",
					"request body exceeds the maximum allowed size",
					proxyErr,
				))
				return
			}

			if apiErr, ok := errors.AsType[*apiError](proxyErr); ok {
				writeError(rw, req, apiErr)
				return
			}

			writeError(rw, req, newAPIError(
				http.StatusBadGateway,
				"proxy_error",
				"request failed",
				proxyErr,
			))
		},
	}

	proxy.ServeHTTP(w, r)
}

// openCodeModifyResponse applies gateway-owned response cleanup and optional
// observer trace deletion after successful upstream session deletion.
func (s *Service) openCodeModifyResponse(ctx context.Context, route *opencodeRoute, path string, agentName string) func(*http.Response) error {
	target, hasSessionDelete := matchOpencodeSessionDelete(route, path, agentName)
	return func(resp *http.Response) error {
		stripOpenCodeCORSHeaders(resp)

		if !hasSessionDelete {
			return nil
		}
		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			return nil
		}
		if err := deleteSessionTraces(ctx, s.queries, target); err != nil {
			return newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"request failed",
				err,
			)
		}
		return nil
	}
}

// stripOpenCodeCORSHeaders removes upstream CORS headers so the gateway writes
// a single browser-facing policy.
func stripOpenCodeCORSHeaders(resp *http.Response) {
	resp.Header.Del("Access-Control-Allow-Credentials")
	resp.Header.Del("Access-Control-Allow-Headers")
	resp.Header.Del("Access-Control-Allow-Methods")
	resp.Header.Del("Access-Control-Allow-Origin")
	resp.Header.Del("Access-Control-Expose-Headers")
	resp.Header.Del("Access-Control-Max-Age")
}

// matchOpencodeSessionDelete returns the observer cleanup target for the exact
// OpenCode session delete route.
func matchOpencodeSessionDelete(route *opencodeRoute, path string, agentName string) (opencodeSessionDeleteTarget, bool) {
	if route == nil {
		return opencodeSessionDeleteTarget{}, false
	}
	if route.Method != http.MethodDelete {
		return opencodeSessionDeleteTarget{}, false
	}
	if !slices.Equal(route.Segments, opencodeSessionDeleteSegments) {
		return opencodeSessionDeleteTarget{}, false
	}

	segments := pathSegments(path)
	if len(segments) != len(opencodeSessionDeleteSegments) {
		return opencodeSessionDeleteTarget{}, false
	}

	return opencodeSessionDeleteTarget{
		agentName: agentName,
		sessionID: segments[len(segments)-1],
	}, true
}

// deleteSessionTraces removes observer traces linked to one session. Cascading
// foreign keys delete the dependent session summaries and span records.
func deleteSessionTraces(ctx context.Context, store sessionTraceStore, target opencodeSessionDeleteTarget) error {
	tenantNamespace, err := tenantNamespace(ctx)
	if err != nil {
		return fmt.Errorf("resolve tenant namespace: %w", err)
	}

	_, err = store.GatewayDeleteSessionTraces(ctx, gatewaydb.GatewayDeleteSessionTracesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       target.agentName,
		SessionID:       target.sessionID,
	})
	if err != nil {
		return fmt.Errorf("delete session traces: %w", err)
	}
	return nil
}

func matchOpenCodeRoute(method, path string) (*opencodeRoute, bool) {
	segments := pathSegments(path)
	methodAllowed := false

	for i := range opencodeRoutes {
		route := &opencodeRoutes[i]
		if !segmentsMatch(route.Segments, segments) {
			continue
		}
		if route.Method == method {
			return route, false
		}
		methodAllowed = true
	}

	return nil, methodAllowed
}

func openCodeTargetURL(target string) (*url.URL, error) {
	addr := strings.TrimSpace(target)
	addr = strings.TrimPrefix(addr, "https://")
	addr = strings.TrimPrefix(addr, "http://")
	if addr == "" {
		return nil, fmt.Errorf("opencode target is empty")
	}

	out, err := url.Parse("http://" + addr)
	if err != nil {
		return nil, fmt.Errorf("parse opencode target: %w", err)
	}
	return out, nil
}

func openCodeUpstreamPath(u *url.URL, agentName string) (string, string, error) {
	prefix := opencodePrefix + "/" + agentName
	path := u.Path
	if !strings.HasPrefix(path, prefix) {
		return "", "", fmt.Errorf("path %q does not match prefix %q", path, prefix)
	}

	out := strings.TrimPrefix(path, prefix)
	if out == "" {
		out = "/"
	}
	if !strings.HasPrefix(out, "/") {
		out = "/" + out
	}

	rawPath := u.EscapedPath()
	rawPath = strings.TrimPrefix(rawPath, prefix)
	if rawPath == "" {
		rawPath = "/"
	}
	if !strings.HasPrefix(rawPath, "/") {
		rawPath = "/" + rawPath
	}

	return out, rawPath, nil
}

// resolveOpenCodeAPIKeyAuth validates a Basic auth password against Better
// Auth API key rows and maps the owning organization to one tenant.
func (s *Service) resolveOpenCodeAPIKeyAuth(r *http.Request) (requestAuth, error) {
	username, password, ok := r.BasicAuth()
	if !ok {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		)
	}
	if username != "opencode" || strings.TrimSpace(password) == "" {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		)
	}

	key, err := s.queries.GatewayGetOpenCodeAPIKeyByHash(
		r.Context(),
		gatewaydb.GatewayGetOpenCodeAPIKeyByHashParams{
			Key:      hashAPIKey(password),
			ConfigID: openCodeAPIKeyConfigID,
			NowAt:    pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		},
	)
	if err != nil {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			err,
		)
	}

	var perms openCodePermissions
	if !key.Permissions.Valid {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		)
	}
	if err := json.Unmarshal([]byte(key.Permissions.String), &perms); err != nil {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			err,
		)
	}

	agentName := strings.TrimSpace(agentNameFromOpenCodePath(r.URL.Path))
	if agentName == "" {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		)
	}
	if !allowOpenCodeAgent(perms.Opencode, agentName) {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			fmt.Errorf(
				"api key %q is not authorized for agent %q",
				key.ID,
				agentName,
			),
		)
	}

	tenantName := clawarmorv1alpha1.TenantName(strings.TrimSpace(key.ReferenceID))
	if tenantName == "" {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		)
	}

	return requestAuth{tenantName: tenantName}, nil
}

func agentNameFromOpenCodePath(path string) string {
	if !strings.HasPrefix(path, opencodePrefix+"/") {
		return ""
	}

	rest := strings.TrimPrefix(path, opencodePrefix+"/")
	segment, _, _ := strings.Cut(rest, "/")
	return segment
}

func allowOpenCodeAgent(scopes []string, agentName string) bool {
	if len(scopes) == 0 {
		return false
	}

	allowed := "agent:" + agentName
	for _, scope := range scopes {
		switch scope {
		case "all":
			return true
		case allowed:
			return true
		}
	}

	return false
}

func hashAPIKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func pathSegments(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func segmentsMatch(pattern, actual []string) bool {
	if len(pattern) != len(actual) {
		return false
	}

	for i := range pattern {
		if isPathParam(pattern[i]) {
			continue
		}
		if pattern[i] != actual[i] {
			return false
		}
	}
	return true
}

func isPathParam(segment string) bool {
	return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")
}

// opencodeProxyBodyLimitEnabled reports whether the request method should be
// subject to attachment-aware body limits before proxying upstream.
func opencodeProxyBodyLimitEnabled(method string) bool {
	_, ok := opencodeProxyBodyLimitedMethods[method]
	return ok
}
