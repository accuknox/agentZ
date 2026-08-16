package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	opencodePrefix              = "/api/opencode"
	opencodeProxyBodyLimitBytes = 16 * 1024 * 1024
	opencodeActorMetadataKey    = "agentz.dev/actor"
	opencodeSessionPromptPath   = "/api/opencode/{agentName}/session/{sessionID}/message"
	opencodeSessionAsyncPath    = "/api/opencode/{agentName}/session/{sessionID}/prompt_async"
)

var opencodeProxyBodyLimitedMethods = map[string]struct{}{
	http.MethodPatch:  {},
	http.MethodPost:   {},
	http.MethodPut:    {},
	http.MethodDelete: {},
}

const opencodeSessionDeletePath = "/api/opencode/{agentName}/session/{sessionID}"

var opencodeRouteMatcher = newOpenCodeRouteMatcher()

var opencodeRouteOperations = func() map[opencodeRouteKey]authorization.Operation {
	operations := make(map[opencodeRouteKey]authorization.Operation, len(opencodeRoutes))
	for _, route := range opencodeRoutes {
		operations[opencodeRouteKey{method: route.Method, path: route.Path}] = route.Operation
	}
	return operations
}()

type opencodeRouteKey struct {
	method string
	path   string
}

type opencodeRoute struct {
	Method    string
	Path      string
	Operation authorization.Operation
}

type opencodeRouteMatch struct {
	Method    string
	Path      string
	Operation authorization.Operation
	Params    map[string]string
}

type opencodeSessionDeleteTarget struct {
	agentName string
	sessionID string
}

type opencodeMessageActor struct {
	Version int              `json:"version"`
	Type    requestActorType `json:"type"`
	ID      string           `json:"id"`
	Name    string           `json:"name"`
}

type sessionTraceStore interface {
	GatewayDeleteSessionTraces(ctx context.Context, arg gatewaydb.GatewayDeleteSessionTracesParams) (int64, error)
}

// handleOpenCodeProxy resolves and proxies supported OpenCode requests.
func (s *Service) handleOpenCodeProxy(w http.ResponseWriter, r *http.Request) {
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
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, route.Operation)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
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
	auth, _ := requestAuthState(r.Context())
	if err := attributeOpenCodePrompt(r, route, auth); err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"bad_request",
			"invalid OpenCode prompt",
			err,
		))
		return
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
		ModifyResponse: s.openCodeModifyResponse(r.Context(), route, agentName),
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

// attributeOpenCodePrompt binds the authenticated gateway principal to
// OpenCode prompts without changing unrecognized or synthetic ingress routes.
func attributeOpenCodePrompt(r *http.Request, route *opencodeRouteMatch, auth requestAuth) error {
	if r.Method != http.MethodPost ||
		(route.Path != opencodeSessionPromptPath && route.Path != opencodeSessionAsyncPath) ||
		auth.actorID == "" {
		return nil
	}

	var body gatewayapi.SessionPromptJSONBody
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&body); err != nil {
		return fmt.Errorf("decode prompt: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("decode prompt: expected one JSON value")
	}

	name := auth.actorName
	if name == "" {
		name = auth.actorID
	}
	actor := opencodeMessageActor{
		Version: 1,
		Type:    auth.actorType,
		ID:      auth.actorID,
		Name:    name,
	}
	attached := false
	for i := range body.Parts {
		partType, err := body.Parts[i].Discriminator()
		if err != nil {
			return fmt.Errorf("read prompt part type: %w", err)
		}
		if partType != string(gatewayapi.OpencodeTextPartInputTypeText) {
			continue
		}

		part, err := body.Parts[i].AsOpencodeTextPartInput()
		if err != nil {
			return fmt.Errorf("decode text prompt part: %w", err)
		}
		metadata := make(map[string]interface{})
		if part.Metadata != nil {
			metadata = *part.Metadata
		}
		if attached {
			if _, exists := metadata[opencodeActorMetadataKey]; !exists {
				continue
			}
			delete(metadata, opencodeActorMetadataKey)
		} else {
			metadata[opencodeActorMetadataKey] = actor
			attached = true
		}
		part.Metadata = &metadata
		if err := body.Parts[i].FromOpencodeTextPartInput(part); err != nil {
			return fmt.Errorf("encode text prompt part: %w", err)
		}
	}
	if !attached {
		metadata := map[string]interface{}{opencodeActorMetadataKey: actor}
		ignored := true
		synthetic := true
		part := gatewayapi.OpencodeTextPartInput{
			Ignored:   &ignored,
			Metadata:  &metadata,
			Synthetic: &synthetic,
			Text:      "",
			Type:      gatewayapi.OpencodeTextPartInputTypeText,
		}
		var input gatewayapi.OpencodePromptPartInput
		if err := input.FromOpencodeTextPartInput(part); err != nil {
			return fmt.Errorf("encode actor prompt part: %w", err)
		}
		body.Parts = append(body.Parts, input)
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode prompt: %w", err)
	}
	if err := r.Body.Close(); err != nil {
		return fmt.Errorf("close prompt body: %w", err)
	}
	r.Body = io.NopCloser(bytes.NewReader(encoded))
	r.ContentLength = int64(len(encoded))
	r.Header.Set("Content-Length", strconv.Itoa(len(encoded)))
	return nil
}

// openCodeModifyResponse applies gateway-owned response cleanup and optional
// observer trace deletion after successful upstream session deletion.
func (s *Service) openCodeModifyResponse(ctx context.Context, route *opencodeRouteMatch, agentName string) func(*http.Response) error {
	target, hasSessionDelete := matchOpencodeSessionDelete(route, agentName)
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
func matchOpencodeSessionDelete(route *opencodeRouteMatch, agentName string) (opencodeSessionDeleteTarget, bool) {
	if route == nil {
		return opencodeSessionDeleteTarget{}, false
	}
	if route.Method != http.MethodDelete {
		return opencodeSessionDeleteTarget{}, false
	}
	if route.Path != opencodeSessionDeletePath {
		return opencodeSessionDeleteTarget{}, false
	}
	sessionID := strings.TrimSpace(route.Params["sessionID"])
	if sessionID == "" {
		return opencodeSessionDeleteTarget{}, false
	}

	return opencodeSessionDeleteTarget{
		agentName: agentName,
		sessionID: sessionID,
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

func newOpenCodeRouteMatcher() chi.Routes {
	r := chi.NewRouter()
	for _, route := range opencodeRoutes {
		r.MethodFunc(route.Method, route.Path, func(http.ResponseWriter, *http.Request) {})
	}
	return r
}

func matchOpenCodeRoute(method string, path string) (*opencodeRouteMatch, bool) {
	rctx := chi.NewRouteContext()
	if opencodeRouteMatcher.Match(rctx, method, path) {
		return &opencodeRouteMatch{
			Method:    method,
			Path:      rctx.RoutePattern(),
			Operation: opencodeRouteOperation(method, rctx.RoutePattern()),
			Params:    routeParams(rctx.URLParams),
		}, false
	}

	for _, route := range opencodeRoutes {
		if route.Method == method {
			continue
		}
		rctx = chi.NewRouteContext()
		if opencodeRouteMatcher.Match(rctx, route.Method, path) {
			return nil, true
		}
	}

	return nil, false
}

func opencodeRouteOperation(method string, path string) authorization.Operation {
	return opencodeRouteOperations[opencodeRouteKey{method: method, path: path}]
}

func routeParams(params chi.RouteParams) map[string]string {
	out := make(map[string]string, len(params.Keys))
	for i, key := range params.Keys {
		out[key] = params.Values[i]
	}
	return out
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

// opencodeProxyBodyLimitEnabled reports whether the request method should be
// subject to attachment-aware body limits before proxying upstream.
func opencodeProxyBodyLimitEnabled(method string) bool {
	_, ok := opencodeProxyBodyLimitedMethods[method]
	return ok
}
