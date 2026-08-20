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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

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
	opencodeSessionCreatePath   = "/api/opencode/{agentName}/session"
	opencodeSessionUpdatePath   = "/api/opencode/{agentName}/session/{sessionID}"
	opencodeSessionStatusPath   = "/api/opencode/{agentName}/session/status"
	opencodeSessionKindKey      = "agentz.dev/session-kind"
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
		key := opencodeRouteKey{method: route.Method, path: route.Path}
		operations[key] = route.Operation
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
			writeError(
				w,
				r,
				newAPIError(
					http.StatusMethodNotAllowed,
					"method_not_allowed",
					"method is not allowed for this route",
					nil,
				),
			)
			return
		}

		writeError(
			w,
			r,
			newAPIError(
				http.StatusNotFound,
				"not_found",
				"route not found",
				nil,
			),
		)
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusNotFound,
				"not_found",
				"agent not found",
				err,
			),
		)
		return
	}

	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	path, rawPath, err := openCodeUpstreamPath(r.URL, agentName)
	if err != nil {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusNotFound,
				"not_found",
				"route not found",
				err,
			),
		)
		return
	}

	if opencodeProxyBodyLimitEnabled(r.Method) {
		if r.ContentLength > opencodeProxyBodyLimitBytes {
			writeError(
				w,
				r,
				newAPIError(
					http.StatusRequestEntityTooLarge,
					"request_too_large",
					"request body exceeds the maximum allowed size",
					nil,
				),
			)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, opencodeProxyBodyLimitBytes)
	}
	auth, _ := requestAuthState(r.Context())
	if err := attributeOpenCodePrompt(r, route, auth); err != nil {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"bad_request",
				"invalid OpenCode prompt",
				err,
			),
		)
		return
	}
	if err := s.recordOpenCodePrompt(r.Context(), route, auth, access.workspaceID, agentName); err != nil {
		writeInternalError(w, r, err)
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
		ModifyResponse: s.openCodeModifyResponse(
			r.Context(), route, target, access.workspaceID, agentName,
		),
		FlushInterval: -1,
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			if _, ok := errors.AsType[*http.MaxBytesError](proxyErr); ok {
				writeError(
					rw,
					req,
					newAPIError(
						http.StatusRequestEntityTooLarge,
						"request_too_large",
						"request body exceeds the maximum allowed size",
						proxyErr,
					),
				)
				return
			}

			if apiErr, ok := errors.AsType[*apiError](proxyErr); ok {
				writeError(rw, req, apiErr)
				return
			}

			writeError(
				rw,
				req,
				newAPIError(
					http.StatusBadGateway,
					"proxy_error",
					"request failed",
					proxyErr,
				),
			)
		},
	}

	proxy.ServeHTTP(w, r)
}

// attributeOpenCodePrompt binds the authenticated gateway principal to
// OpenCode prompts without changing unrecognized or synthetic ingress routes.
func attributeOpenCodePrompt(r *http.Request, route *opencodeRouteMatch, auth requestAuth) error {
	if r.Method != http.MethodPost || auth.actorID == "" {
		return nil
	}
	if route.Path != opencodeSessionPromptPath && route.Path != opencodeSessionAsyncPath {
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
	var attached bool
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
		metadata := make(map[string]any)
		if part.Metadata != nil {
			metadata = *part.Metadata
		}
		if attached {
			if _, exists := metadata[opencodeActorMetadataKey]; !exists {
				continue
			}
			delete(metadata, opencodeActorMetadataKey)
		}
		if !attached {
			metadata[opencodeActorMetadataKey] = actor
			attached = true
		}
		part.Metadata = &metadata
		if err := body.Parts[i].FromOpencodeTextPartInput(part); err != nil {
			return fmt.Errorf("encode text prompt part: %w", err)
		}
	}
	if !attached {
		metadata := map[string]any{opencodeActorMetadataKey: actor}
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
func (s *Service) openCodeModifyResponse(ctx context.Context, route *opencodeRouteMatch, upstream *url.URL, workspaceID, agentName string) func(*http.Response) error {
	deleteTarget, hasSessionDelete := matchOpencodeSessionDelete(route, agentName)
	return func(resp *http.Response) error {
		stripOpenCodeCORSHeaders(resp)

		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			return nil
		}
		if route.Method == http.MethodPost && route.Path == opencodeSessionCreatePath ||
			route.Method == http.MethodPatch && route.Path == opencodeSessionUpdatePath {
			if err := s.storeOpenCodeSessionResponse(
				ctx, resp, workspaceID, agentName,
			); err != nil {
				return err
			}
		}
		if route.Method == http.MethodPost && route.Path == opencodeSessionPromptPath {
			_, err := s.queries.GatewaySetChatSessionStatus(
				ctx,
				gatewaydb.GatewaySetChatSessionStatusParams{
					Status:      gatewaydb.ChatSessionStatusIdle,
					WorkspaceID: workspaceID,
					AgentName:   agentName,
					SessionID:   route.Params["sessionID"],
				},
			)
			if err != nil {
				return fmt.Errorf("set chat session idle: %w", err)
			}
			if err := s.refreshOpenCodeSession(
				ctx, upstream, workspaceID, agentName, route.Params["sessionID"],
			); err != nil {
				return err
			}
		}
		if route.Method == http.MethodGet && route.Path == opencodeSessionStatusPath {
			if err := s.storeOpenCodeSessionStatusResponse(
				ctx, resp, workspaceID, agentName,
			); err != nil {
				return err
			}
		}
		if !hasSessionDelete {
			return nil
		}
		if err := deleteSessionTraces(ctx, s.queries, deleteTarget); err != nil {
			return newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"request failed",
				err,
			)
		}
		_, err := s.queries.GatewayDeleteChatSession(
			ctx,
			gatewaydb.GatewayDeleteChatSessionParams{
				WorkspaceID: workspaceID,
				AgentName:   deleteTarget.agentName,
				SessionID:   deleteTarget.sessionID,
			},
		)
		if err != nil {
			return fmt.Errorf("delete chat session: %w", err)
		}
		return nil
	}
}

func (s *Service) recordOpenCodePrompt(ctx context.Context, route *opencodeRouteMatch, auth requestAuth, workspaceID, agentName string) error {
	if route.Method != http.MethodPost || auth.actorType != requestActorUser {
		return nil
	}
	if route.Path != opencodeSessionPromptPath && route.Path != opencodeSessionAsyncPath {
		return nil
	}
	_, err := s.queries.GatewayTouchChatSessionParticipant(
		ctx,
		gatewaydb.GatewayTouchChatSessionParticipantParams{
			WorkspaceID: workspaceID,
			AgentName:   agentName,
			SessionID:   route.Params["sessionID"],
			UserID:      auth.actorID,
			MessagedAt:  pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		},
	)
	if err != nil {
		return fmt.Errorf("record chat session participant: %w", err)
	}
	return nil
}

func (s *Service) storeOpenCodeSessionResponse(ctx context.Context, resp *http.Response, workspaceID, agentName string) error {
	const responseLimit = 1024 * 1024
	raw, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return fmt.Errorf("read OpenCode session response: %w", err)
	}
	if len(raw) > responseLimit {
		return errors.New("OpenCode session response exceeds catalog limit")
	}
	if err := resp.Body.Close(); err != nil {
		return fmt.Errorf("close OpenCode session response: %w", err)
	}
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))

	var session gatewayapi.OpencodeSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return fmt.Errorf("decode OpenCode session response: %w", err)
	}
	return s.storeOpenCodeSession(ctx, workspaceID, agentName, session)
}

func (s *Service) storeOpenCodeSessionStatusResponse(ctx context.Context, resp *http.Response, workspaceID, agentName string) error {
	const responseLimit = 1024 * 1024
	raw, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return fmt.Errorf("read OpenCode session status response: %w", err)
	}
	if len(raw) > responseLimit {
		return errors.New("OpenCode session status response exceeds catalog limit")
	}
	if err := resp.Body.Close(); err != nil {
		return fmt.Errorf("close OpenCode session status response: %w", err)
	}
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))

	var statuses map[string]gatewayapi.OpencodeSessionStatus
	if err := json.Unmarshal(raw, &statuses); err != nil {
		return fmt.Errorf("decode OpenCode session status response: %w", err)
	}
	busySessionIDs := make([]string, 0, len(statuses))
	retrySessionIDs := make([]string, 0, len(statuses))
	for sessionID, status := range statuses {
		idle, idleErr := status.AsOpencodeSessionStatus0()
		if idleErr == nil && idle.Type == gatewayapi.Idle {
			continue
		}
		retry, retryErr := status.AsOpencodeSessionStatus1()
		if retryErr == nil && retry.Type == gatewayapi.OpencodeSessionStatus1TypeRetry {
			retrySessionIDs = append(retrySessionIDs, sessionID)
			continue
		}
		busy, busyErr := status.AsOpencodeSessionStatus2()
		if busyErr != nil || busy.Type != gatewayapi.Busy {
			return fmt.Errorf("decode chat session %q status", sessionID)
		}
		busySessionIDs = append(busySessionIDs, sessionID)
	}
	_, err = s.queries.GatewaySyncAgentChatSessionStatuses(
		ctx,
		gatewaydb.GatewaySyncAgentChatSessionStatusesParams{
			WorkspaceID:     workspaceID,
			AgentName:       agentName,
			RetrySessionIds: retrySessionIDs,
			BusySessionIds:  busySessionIDs,
		},
	)
	if err != nil {
		return fmt.Errorf("sync chat session statuses: %w", err)
	}
	return nil
}

func (s *Service) refreshOpenCodeSession(ctx context.Context, target *url.URL, workspaceID, agentName, sessionID string) error {
	sessionURL := target.JoinPath("session", sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sessionURL.String(), nil)
	if err != nil {
		return fmt.Errorf("create OpenCode session request: %w", err)
	}
	resp, err := s.outboundHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("refresh OpenCode session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("refresh OpenCode session: unexpected status %s", resp.Status)
	}
	var session gatewayapi.OpencodeSession
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		return fmt.Errorf("decode refreshed OpenCode session: %w", err)
	}
	return s.storeOpenCodeSession(ctx, workspaceID, agentName, session)
}

func (s *Service) storeOpenCodeSession(ctx context.Context, workspaceID, agentName string, session gatewayapi.OpencodeSession) error {
	kind := gatewaydb.ChatSessionKindChat
	if session.Metadata != nil {
		value, ok := (*session.Metadata)[opencodeSessionKindKey].(string)
		if ok && value == string(gatewaydb.ChatSessionKindWorkflowRun) {
			kind = gatewaydb.ChatSessionKindWorkflowRun
		}
	}
	var parentID pgtype.Text
	if session.ParentID != nil {
		parentID = pgtype.Text{String: *session.ParentID, Valid: true}
	}
	_, err := s.queries.GatewayUpsertChatSession(
		ctx,
		gatewaydb.GatewayUpsertChatSessionParams{
			WorkspaceID:     workspaceID,
			AgentName:       agentName,
			SessionID:       session.Id,
			ParentSessionID: parentID,
			Title:           session.Title,
			Kind:            kind,
			Status:          gatewaydb.ChatSessionStatusIdle,
			SourceCreatedAt: pgtype.Timestamptz{
				Time: time.UnixMilli(int64(session.Time.Created)), Valid: true,
			},
			SourceUpdatedAt: pgtype.Timestamptz{
				Time: time.UnixMilli(int64(session.Time.Updated)), Valid: true,
			},
		},
	)
	if err != nil {
		return fmt.Errorf("store OpenCode session: %w", err)
	}
	return nil
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

	_, err = store.GatewayDeleteSessionTraces(
		ctx,
		gatewaydb.GatewayDeleteSessionTracesParams{
			TenantNamespace: tenantNamespace,
			AgentName:       target.agentName,
			SessionID:       target.sessionID,
		},
	)
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
