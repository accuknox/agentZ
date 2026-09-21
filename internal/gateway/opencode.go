package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tmaxmax/go-sse"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	opencodePrefix              = "/api/opencode"
	opencodeProxyBodyLimitBytes = 16 * 1024 * 1024
	opencodeActorMetadataKey    = "agentz.dev/actor"
)

var opencodeRouteMatcher = newOpenCodeRouteMatcher()

var opencodeRouteIndex = func() map[opencodeRouteKey]opencodeRoute {
	routes := make(map[opencodeRouteKey]opencodeRoute, len(opencodeRoutes))
	for _, route := range opencodeRoutes {
		key := opencodeRouteKey{method: route.Method, path: route.Path}
		routes[key] = route
	}
	return routes
}()

type opencodeRouteKey struct {
	method string
	path   string
}

type opencodeRoute struct {
	ID        string
	Method    string
	Path      string
	Operation authorization.Operation
}

type opencodeRouteMatch struct {
	ID        string
	Method    string
	Path      string
	Operation authorization.Operation
	Params    map[string]string
}

type opencodeMessageActor struct {
	Version int              `json:"version"`
	Type    requestActorType `json:"type"`
	ID      string           `json:"id"`
	Name    string           `json:"name"`
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusMethodNotAllowed,
					"method_not_allowed",
					"method is not allowed for this route",
					nil,
				),
			)
			return
		}

		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusNotFound,
				"not_found",
				"route not found",
				nil,
			),
		)
		return
	}
	endpoint := strings.TrimPrefix(route.Path, opencodePrefix+"/{agentName}")
	endpoint = strings.TrimPrefix(endpoint, "/api")
	pty := endpoint == "/pty" || strings.HasPrefix(endpoint, "/pty/")
	if pty {
		origin := r.Header.Get("Origin")
		if origin != "" && !slices.Contains(s.cfg.AllowedWebOrigins, origin) {
			apiutil.WriteError(w, r, resourceForbidden(errors.New("terminal origin is not allowed")))
			return
		}
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, route.Operation)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	connection, apiErr := s.nativeAdmission(r.Context(), access.namespace, agentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if expected := r.Header.Get("X-Agentz-Compute-Connection"); connection != "" && expected != "" && expected != connection {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "host_reconnected", "The host reconnected; submit new work explicitly.", nil))
		return
	}
	if connection != "" {
		r.Header.Set("X-Agentz-Compute-Connection", connection)
	}
	auth, authenticated := requestAuthState(r.Context())
	stop := route.ID == "session.abort" || route.ID == "v2.session.interrupt"
	if authenticated && auth.actorType != requestActorSystem && stop {
		s.stopOpenCodeSession(w, r, route, agentName)
		return
	}
	switch r.Method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
		if r.ContentLength > opencodeProxyBodyLimitBytes {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
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
	query := r.URL.Query()
	if query.Get("directory") == "" && r.Header.Get("X-Opencode-Directory") != "" {
		directory, err := url.PathUnescape(r.Header.Get("X-Opencode-Directory"))
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest, "invalid_directory",
				"Invalid checkout directory", err,
			))
			return
		}
		query.Set("directory", directory)
		r.URL.RawQuery = query.Encode()
		r.Header.Del("X-Opencode-Directory")
	}
	// Reserve one execution connection before taking admission. Stop and
	// events use separate capacity, including for non-Coding workspaces.
	input := false
	switch route.ID {
	case "session.prompt", "session.prompt_async", "session.command",
		"session.shell", "v2.session.prompt":
		input = true
		ctx, release, err := gatewayLocks(r.Context(), s.lockDB)
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("submit input", err))
			return
		}
		if release != nil {
			defer release()
		}
		r = r.WithContext(ctx)
	}
	if authenticated && auth.actorType != requestActorSystem {
		release, apiErr := s.enforceCodingSession(r, access, route, agentName)
		if release != nil {
			defer release()
		}
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
	}

	// Admission is short-lived for synchronous input so Stop and queue
	// controls remain available during generation. The execution lease lets
	// Stop drain requests that passed admission before it acquired the lock.
	changesInput := input || r.Method == http.MethodDelete
	switch route.ID {
	case "session.abort", "session.revert", "session.unrevert",
		"v2.session.interrupt", "v2.session.revert.stage",
		"v2.session.revert.commit", "v2.session.revert.clear":
		changesInput = true
	}
	sessionID := route.Params["sessionID"]
	if sessionID != "" && changesInput {
		release, err := s.lockChatInputs(
			r.Context(), access.workspaceID, agentName, sessionID, "",
		)
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("submit input", err))
			return
		}
		switch {
		case !input:
			defer release()
		default:
			stopping, err := s.queries.GatewayChatInputsStopping(
				r.Context(),
				gatewaydb.GatewayChatInputsStoppingParams{
					WorkspaceID: access.workspaceID,
					AgentName:   agentName,
					SessionID:   sessionID,
				},
			)
			if err != nil || stopping {
				release()
				if err != nil {
					apiutil.WriteInternalError(w, r, err)
					return
				}
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusConflict, "session_stopping",
					"The session is stopping; retry Stop before sending another input", nil,
				))
				return
			}
			identity := "session-execution/" + access.workspaceID + "/" + agentName + "/" + sessionID
			_, finish, err := lockGatewayResource(r.Context(), s.lockDB, identity, true)
			release()
			if err != nil {
				apiutil.WriteError(w, r, mapGatewayStoreError("submit input", err))
				return
			}
			defer finish()
		}
	}

	if route.ID == "session.status" {
		identity := "session-status/" + access.workspaceID + "/" + agentName
		_, release, err := lockGatewayResource(r.Context(), s.controlDB, identity, false)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		defer release()
	}

	resolved, err := s.resolver.resolveAgent(r.Context(), access.namespace, agentName)
	if err != nil {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
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
		apiutil.WriteInternalError(w, r, err)
		return
	}

	if route.ID == "event.subscribe" || route.ID == "global.event" {
		s.streamOpenCodeEvents(w, r, route, target, access, agentName)
		return
	}

	path, rawPath, err := openCodeUpstreamPath(r.URL, agentName)
	if err != nil {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusNotFound,
				"not_found",
				"route not found",
				err,
			),
		)
		return
	}

	if err := attributeOpenCodePrompt(r, route, auth); err != nil {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"bad_request",
				"invalid OpenCode prompt",
				err,
			),
		)
		return
	}
	proxy := &httputil.ReverseProxy{
		Transport: s.outboundHTTP.Transport,
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
			preq.Out.Header.Del("Cookie")
			// The gateway validates browser origins. OpenCode sees a server
			// request because its allowlist does not include the public app.
			if pty {
				preq.Out.Header.Del("Origin")
			}
			// Let the transport negotiate and decode compression before
			// ModifyResponse reads session JSON for the sidebar catalog.
			preq.Out.Header.Del("Accept-Encoding")
			preq.SetXForwarded()
			preq.Out.Header.Set("X-Request-ID", requestID(preq.In))
		},
		ModifyResponse: s.openCodeModifyResponse(
			r.Context(), route, target, auth, access.workspaceID, agentName,
		),
		FlushInterval: -1,
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			if _, ok := errors.AsType[*http.MaxBytesError](proxyErr); ok {
				apiutil.WriteError(
					rw,
					req,
					apiutil.NewError(
						http.StatusRequestEntityTooLarge,
						"request_too_large",
						"request body exceeds the maximum allowed size",
						proxyErr,
					),
				)
				return
			}

			if apiErr, ok := errors.AsType[*apiutil.APIError](proxyErr); ok {
				apiutil.WriteError(rw, req, apiErr)
				return
			}

			apiutil.WriteError(
				rw,
				req,
				apiutil.NewError(
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

// streamOpenCodeEvents observes the client's existing stream. The global TUI
// envelope is built from the directory-scoped stream so private checkouts never
// receive the agent's unfiltered global bus.
func (s *Service) streamOpenCodeEvents(w http.ResponseWriter, r *http.Request, route *opencodeRouteMatch, target *url.URL, access resourceAccess, agentName string) {
	auth, _ := requestAuthState(r.Context())
	nativeGlobal := route.ID == "global.event" && auth.workspaceType != agentzv1alpha1.WorkspaceTypeCoding
	endpoint := "event"
	if nativeGlobal {
		endpoint = "global/event"
	}
	target = target.JoinPath(endpoint)
	target.RawQuery = r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	req.Header.Set("Accept", "text/event-stream")
	client := *s.outboundHTTP
	client.Timeout = 0
	resp, err := client.Do(req)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadGateway, "event_failed",
			"Could not connect to agent events", err,
		))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	controller := http.NewResponseController(w)
	if err := controller.Flush(); err != nil {
		return
	}
	directory := target.Query().Get("directory")
	if directory == "" {
		resolved, err := s.resolver.resolveAgent(r.Context(), access.namespace, agentName)
		if err != nil {
			return
		}
		directory = resolved.Root
	}
	upstream := *target
	upstream.Path = ""
	for frame, err := range sse.Read(resp.Body, &sse.ReadConfig{MaxEventSize: opencodeProxyBodyLimitBytes}) {
		if err != nil {
			if r.Context().Err() == nil {
				slog.ErrorContext(r.Context(), "read agent events", "agent", agentName, "error", err)
			}
			return
		}
		data := []byte(frame.Data)
		if nativeGlobal {
			var envelope gatewayapi.OpencodeGlobalEvent
			if err := json.Unmarshal(data, &envelope); err != nil {
				return
			}
			data, err = envelope.Payload.MarshalJSON()
			if err != nil {
				return
			}
			query := upstream.Query()
			query.Set("directory", envelope.Directory)
			upstream.RawQuery = query.Encode()
		}
		var event gatewayapi.OpencodeEvent
		if err := json.Unmarshal(data, &event); err != nil {
			slog.ErrorContext(r.Context(), "decode agent event", "agent", agentName, "error", err)
			return
		}
		kind, err := event.Discriminator()
		if err != nil {
			return
		}
		var sessionID string
		switch kind {
		case string(gatewayapi.OpencodeEventSessionCreatedTypeSessionCreated):
			value, decodeErr := event.AsOpencodeEventSessionCreated()
			err, sessionID = decodeErr, value.Properties.SessionID
		case string(gatewayapi.OpencodeEventSessionUpdatedTypeSessionUpdated):
			value, decodeErr := event.AsOpencodeEventSessionUpdated()
			err, sessionID = decodeErr, value.Properties.SessionID
		case string(gatewayapi.OpencodeEventSessionDeletedTypeSessionDeleted):
			value, decodeErr := event.AsOpencodeEventSessionDeleted()
			err, sessionID = decodeErr, value.Properties.SessionID
		case string(gatewayapi.OpencodeEventSessionStatusTypeSessionStatus),
			string(gatewayapi.OpencodeEventSessionIdleTypeSessionIdle):
			err = s.refreshOpenCodeStatus(r.Context(), &upstream, access.workspaceID, agentName)
		}
		if err == nil && sessionID != "" {
			err = s.refreshOpenCodeSession(r.Context(), &upstream, access.workspaceID, agentName, sessionID)
			if errors.Is(err, pgx.ErrNoRows) {
				// Deleted sessions cannot be resurrected by delayed observations.
				err = nil
				if kind != string(gatewayapi.OpencodeEventSessionDeletedTypeSessionDeleted) {
					continue
				}
			}
		}
		if err != nil {
			slog.ErrorContext(r.Context(), "persist agent event",
				"agent", agentName, "session", sessionID, "error", err)
			return
		}
		data = []byte(frame.Data)
		if route.ID == "global.event" && !nativeGlobal {
			var envelope gatewayapi.OpencodeGlobalEvent
			envelope.Directory = directory
			if err := envelope.Payload.UnmarshalJSON(data); err != nil {
				return
			}
			data, err = json.Marshal(envelope)
			if err != nil {
				return
			}
		}
		var message sse.Message
		message.AppendData(string(data))
		message.Type, err = sse.NewType(frame.Type)
		if err != nil {
			return
		}
		message.ID, err = sse.NewID(frame.LastEventID)
		if err != nil {
			return
		}
		if _, err := message.WriteTo(w); err != nil {
			return
		}
		if err := controller.Flush(); err != nil {
			return
		}
	}
}

// refreshOpenCodeStatus reads runtime status after mutation and stream observations.
func (s *Service) refreshOpenCodeStatus(ctx context.Context, target *url.URL, workspaceID, agentName string) error {
	identity := "session-status/" + workspaceID + "/" + agentName
	_, release, err := lockGatewayResource(ctx, s.controlDB, identity, false)
	if err != nil {
		return err
	}
	defer release()
	statusURL := target.JoinPath("session", "status")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusURL.String(), nil)
	if err != nil {
		return err
	}
	resp, err := s.outboundHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("read session status: %s", resp.Status)
	}
	var directory pgtype.Text
	auth, ok := requestAuthState(ctx)
	if ok && auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
		namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, workspaceID)
		resolved, err := s.resolver.resolveAgent(ctx, namespace, agentName)
		if err != nil {
			return err
		}
		directory = pgtype.Text{
			String: strings.TrimPrefix(target.Query().Get("directory"), resolved.Root+"/"),
			Valid:  true,
		}
	}
	return s.storeOpenCodeSessionStatusResponse(ctx, resp, workspaceID, agentName, directory)
}

// replaceOpenCodeRequest keeps forwarded body framing consistent after typed edits.
func replaceOpenCodeRequest(r *http.Request, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if err := r.Body.Close(); err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	r.ContentLength = int64(len(raw))
	r.Header.Set("Content-Length", strconv.Itoa(len(raw)))
	return nil
}

// attributeOpenCodePrompt binds the authenticated gateway principal to
// OpenCode prompts without changing unrecognized or synthetic ingress routes.
func attributeOpenCodePrompt(r *http.Request, route *opencodeRouteMatch, auth requestAuth) error {
	if r.Method != http.MethodPost || auth.actorID == "" {
		return nil
	}
	if route.ID != "session.prompt" && route.ID != "session.prompt_async" {
		return nil
	}

	var body gatewayapi.SessionPromptJSONBody
	if err := apiutil.DecodeJSONBody(r, &body, false); err != nil {
		return err
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
	// API keys identify their creator to the agent and other participants.
	// The request still retains the key actor for audit attribution.
	if auth.userID != "" {
		actor.Type = requestActorUser
		actor.ID = auth.userID
		actor.Name = auth.userName
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

	return replaceOpenCodeRequest(r, body)
}

// openCodeModifyResponse persists native mutations without changing their wire contracts.
func (s *Service) openCodeModifyResponse(ctx context.Context, route *opencodeRouteMatch, upstream *url.URL, auth requestAuth, workspaceID, agentName string) func(*http.Response) error {
	return func(resp *http.Response) error {
		stripOpenCodeCORSHeaders(resp)
		if resp.StatusCode == http.StatusSwitchingProtocols {
			if resp.Request.Header.Get("Sec-WebSocket-Protocol") == "agentz.pty" {
				resp.Header.Set("Sec-WebSocket-Protocol", "agentz.pty")
			}
			return nil
		}
		contentType := resp.Header.Get("Content-Type")
		if contentType == "text/event-stream" || strings.HasPrefix(contentType, "text/event-stream;") {
			return nil
		}
		// Upstream may already have committed when the client disconnects.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		var runtimeRoot string
		if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
			namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, workspaceID)
			resolved, err := s.resolver.resolveAgent(ctx, namespace, agentName)
			if err != nil {
				return err
			}
			runtimeRoot = resolved.Root
		}
		target := *upstream
		target.RawQuery = resp.Request.URL.RawQuery
		sessionID := route.Params["sessionID"]
		success := resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices
		if route.ID == "session.delete" && (success || resp.StatusCode == http.StatusNotFound) {
			err := s.refreshOpenCodeSession(ctx, &target, workspaceID, agentName, sessionID)
			if !errors.Is(err, pgx.ErrNoRows) {
				if err != nil {
					return err
				}
				return errors.New("OpenCode session still exists after deletion")
			}
			resp.StatusCode = http.StatusOK
			resp.Status = "200 OK"
			resp.Header.Set("Content-Type", "application/json")
			return replaceOpenCodeResponse(resp, true)
		}
		if !success {
			// PATCH and prompt handlers can commit before reporting an error.
			refresh := route.Method != http.MethodGet || resp.StatusCode == http.StatusNotFound
			if sessionID != "" && refresh {
				err := s.refreshOpenCodeSession(ctx, &target, workspaceID, agentName, sessionID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			return nil
		}
		if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
			directory := target.Query().Get("directory")
			switch route.ID {
			case "project.current":
				project, err := decodeOpenCodeResponse[gatewayapi.OpencodeProject](resp)
				if err != nil {
					return err
				}
				project.Worktree = directory
				project.Sandboxes = []string{}
				return replaceOpenCodeResponse(resp, project)
			case "project.directories":
				directories, err := decodeOpenCodeResponse[gatewayapi.OpencodeProjectDirectories](resp)
				if err != nil {
					return err
				}
				filtered := directories[:0]
				for _, entry := range directories {
					if entry.Directory == directory {
						filtered = append(filtered, entry)
					}
				}
				return replaceOpenCodeResponse(resp, filtered)
			case "v2.session.active":
				result, err := gatewayapi.ParseV2SessionActiveResp(resp)
				if err != nil {
					return err
				}
				if result.JSON200 == nil {
					return errors.New("invalid active sessions response")
				}
				for sessionID := range result.JSON200.Data {
					row, err := s.queries.GatewayResolveCodingSession(
						ctx, gatewaydb.GatewayResolveCodingSessionParams{
							WorkspaceID: workspaceID,
							AgentName:   agentName,
							SessionID:   sessionID,
							OwnerID:     auth.userID,
						},
					)
					if err != nil && !errors.Is(err, pgx.ErrNoRows) {
						return err
					}
					worktree := path.Join(runtimeRoot, row.CodingWorktree.Directory)
					if errors.Is(err, pgx.ErrNoRows) || worktree != directory {
						delete(result.JSON200.Data, sessionID)
					}
				}
				return replaceOpenCodeResponse(resp, result.JSON200)
			}
		}
		switch route.ID {
		case "session.create", "session.fork", "session.get", "session.update",
			"session.revert", "session.unrevert", "session.share", "session.unshare":
			session, err := decodeOpenCodeResponse[gatewayapi.OpencodeSession](resp)
			if err != nil {
				return err
			}
			sessionID = session.Id
		case "v2.session.create":
			result, err := gatewayapi.ParseV2SessionCreateResp(resp)
			if err != nil {
				return err
			}
			resp.Body = io.NopCloser(bytes.NewReader(result.Body))
			if result.JSON200 == nil {
				return errors.New("OpenCode returned an invalid session")
			}
			sessionID = result.JSON200.Data.Id
		case "v2.session.list":
			result, err := decodeOpenCodeResponse[gatewayapi.OpencodeSessionsResponse](resp)
			if err != nil {
				return err
			}
			for _, session := range result.Data {
				err := s.refreshOpenCodeSession(ctx, &target, workspaceID, agentName, session.Id)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			return nil
		case "session.list", "session.children":
			sessions, err := decodeOpenCodeResponse[[]gatewayapi.OpencodeSession](resp)
			if err != nil {
				return err
			}
			for _, session := range sessions {
				err := s.refreshOpenCodeSession(ctx, &target, workspaceID, agentName, session.Id)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			return nil
		case "session.status":
			var directory pgtype.Text
			if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
				directory = pgtype.Text{
					String: strings.TrimPrefix(target.Query().Get("directory"), runtimeRoot+"/"),
					Valid:  true,
				}
			}
			return s.storeOpenCodeSessionStatusResponse(ctx, resp, workspaceID, agentName, directory)
		}
		if sessionID == "" {
			return nil
		}
		// Transcript reads do not need another metadata request.
		if route.Method == http.MethodGet && route.ID != "session.get" && route.ID != "v2.session.get" {
			return nil
		}
		err := s.refreshOpenCodeSession(ctx, &target, workspaceID, agentName, sessionID)
		if err != nil {
			message := fmt.Sprintf(
				"Could not save the workspace record for session %s. Read this session to retry persistence before creating another.",
				sessionID,
			)
			return apiutil.NewError(
				http.StatusBadGateway, "session_persistence_failed", message, err,
			)
		}
		if err := s.recordOpenCodePrompt(ctx, route, auth, workspaceID, agentName); err != nil {
			return err
		}
		if route.Method == http.MethodPost {
			return s.refreshOpenCodeStatus(ctx, &target, workspaceID, agentName)
		}
		return nil
	}
}

func (s *Service) recordOpenCodePrompt(ctx context.Context, route *opencodeRouteMatch, auth requestAuth, workspaceID, agentName string) error {
	if route.Method != http.MethodPost || auth.actorType == requestActorSystem {
		return nil
	}
	switch route.ID {
	case "session.prompt", "session.prompt_async", "session.command",
		"session.shell", "session.init", "v2.session.prompt":
	default:
		return nil
	}
	err := s.queries.GatewayTouchChatSessionParticipant(
		ctx, gatewaydb.GatewayTouchChatSessionParticipantParams{
			WorkspaceID: workspaceID,
			AgentName:   agentName,
			SessionID:   route.Params["sessionID"],
			UserID:      auth.userID,
			MessagedAt:  pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		},
	)
	if err != nil {
		return fmt.Errorf("record chat session participant: %w", err)
	}
	return nil
}

func (s *Service) storeOpenCodeSessionStatusResponse(ctx context.Context, resp *http.Response, workspaceID, agentName string, directory pgtype.Text) error {
	statuses, err := decodeOpenCodeResponse[map[string]gatewayapi.OpencodeSessionStatus](resp)
	if err != nil {
		return fmt.Errorf("decode OpenCode session status response: %w", err)
	}
	if directory.Valid {
		auth, _ := requestAuthState(ctx)
		for sessionID := range statuses {
			row, err := s.queries.GatewayResolveCodingSession(
				ctx, gatewaydb.GatewayResolveCodingSessionParams{
					WorkspaceID: workspaceID,
					AgentName:   agentName,
					OwnerID:     auth.userID,
					SessionID:   sessionID,
				},
			)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if errors.Is(err, pgx.ErrNoRows) || row.CodingWorktree.Directory != directory.String {
				delete(statuses, sessionID)
			}
		}
		if err := replaceOpenCodeResponse(resp, statuses); err != nil {
			return err
		}
	}
	busySessionIDs := make([]string, 0, len(statuses))
	retrySessionIDs := make([]string, 0, len(statuses))
	for sessionID, status := range statuses {
		kind, err := status.Discriminator()
		if err != nil {
			return err
		}
		switch kind {
		case string(gatewayapi.Idle):
		case string(gatewayapi.Retry):
			retrySessionIDs = append(retrySessionIDs, sessionID)
		case string(gatewayapi.Busy):
			busySessionIDs = append(busySessionIDs, sessionID)
		default:
			return fmt.Errorf("unknown session status %q", kind)
		}
	}
	err = s.queries.GatewaySyncAgentChatSessionStatuses(
		ctx,
		gatewaydb.GatewaySyncAgentChatSessionStatusesParams{
			CodingDirectory: directory,
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
	identity := "session-metadata/" + workspaceID + "/" + agentName + "/" + sessionID
	_, release, err := lockGatewayResource(ctx, s.controlDB, identity, false)
	if err != nil {
		return err
	}
	defer release()
	sessionURL := target.JoinPath("session", sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sessionURL.String(), nil)
	if err != nil {
		return err
	}
	resp, err := s.outboundHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("refresh OpenCode session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		var missing gatewayapi.OpencodeNotFoundError
		if err := json.NewDecoder(resp.Body).Decode(&missing); err != nil {
			return err
		}
		if missing.Name != gatewayapi.NotFoundError {
			return errors.New("unexpected OpenCode not-found response")
		}
		namespace, err := tenantNamespace(ctx)
		if err != nil {
			return err
		}
		err = s.queries.GatewayDeleteChatSession(ctx, gatewaydb.GatewayDeleteChatSessionParams{
			WorkspaceID:     workspaceID,
			AgentName:       agentName,
			SessionID:       pgtype.Text{String: sessionID, Valid: true},
			TenantNamespace: namespace,
		})
		if err != nil {
			return err
		}
		return pgx.ErrNoRows
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("refresh OpenCode session: unexpected status %s", resp.Status)
	}
	var session gatewayapi.OpencodeSession
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		return fmt.Errorf("decode refreshed OpenCode session: %w", err)
	}
	kind := gatewaydb.ChatSessionKindChat
	if auth, ok := requestAuthState(ctx); ok && auth.actorType == requestActorSystem {
		kind = gatewaydb.ChatSessionKindWorkflowRun
	}
	return s.storeOpenCodeSession(ctx, workspaceID, agentName, kind, session)
}

func (s *Service) storeOpenCodeSession(ctx context.Context, workspaceID, agentName string, kind gatewaydb.ChatSessionKind, session gatewayapi.OpencodeSession) error {
	var parentID pgtype.Text
	if session.ParentID != nil {
		parentID = pgtype.Text{String: *session.ParentID, Valid: true}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	q := gatewaydb.New(tx)
	auth, _ := requestAuthState(ctx)
	if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding && auth.actorType != requestActorSystem {
		namespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, workspaceID)
		resolved, err := s.resolver.resolveAgent(ctx, namespace, agentName)
		if err != nil {
			return err
		}
		tree, err := q.GatewayOwnedCodingDirectory(ctx, gatewaydb.GatewayOwnedCodingDirectoryParams{
			WorkspaceID: workspaceID, AgentName: agentName, OwnerID: auth.userID,
			Directory: strings.TrimPrefix(session.Directory, resolved.Root+"/"),
		})
		if err != nil {
			return err
		}
		if tree.Deleting || !tree.Ready {
			return errors.New("checkout is unavailable")
		}
		if session.ParentID == nil {
			// Lock before the insertion statement so concurrent first bindings
			// see each other when deciding whether revert is still safe.
			if err := q.GatewayLockCodingWorktree(ctx, tree.ID); err != nil {
				return err
			}
			err = q.GatewayBindCodingSession(ctx, gatewaydb.GatewayBindCodingSessionParams{
				ID: uuid.NewString(), WorkspaceID: workspaceID, AgentName: agentName,
				WorktreeID: tree.ID, SessionID: pgtype.Text{String: session.Id, Valid: true},
			})
			if err != nil {
				return err
			}
		}
	}
	err = q.GatewayUpsertChatSession(
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
	return tx.Commit(ctx)
}

// replaceOpenCodeResponse updates framing when ownership filtering changes JSON.
func replaceOpenCodeResponse(resp *http.Response, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))
	resp.Header.Set("Content-Length", strconv.Itoa(len(raw)))
	return nil
}

func decodeOpenCodeResponse[T any](resp *http.Response) (T, error) {
	const responseLimit = 1024 * 1024

	var value T
	raw, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return value, fmt.Errorf("read response: %w", err)
	}
	if len(raw) > responseLimit {
		return value, errors.New("response exceeds catalog limit")
	}
	if err := resp.Body.Close(); err != nil {
		return value, fmt.Errorf("close response: %w", err)
	}
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, err
	}
	return value, nil
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
		params := make(map[string]string, len(rctx.URLParams.Keys))
		for i, key := range rctx.URLParams.Keys {
			params[key] = rctx.URLParams.Values[i]
		}
		route := opencodeRouteIndex[opencodeRouteKey{method: method, path: rctx.RoutePattern()}]
		return &opencodeRouteMatch{
			Method:    method,
			Path:      route.Path,
			ID:        route.ID,
			Operation: route.Operation,
			Params:    params,
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

// ptyWebsocketAuth carries a browser bearer in the WebSocket handshake rather
// than the URL. It is removed before proxying and uses the normal live grants.
func (s *Service) ptyWebsocketAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			allowed := slices.Contains(s.cfg.AllowedWebOrigins, r.Header.Get("Origin"))
			if !allowed {
				apiutil.WriteError(w, r, resourceForbidden(errors.New("WebSocket origin is not allowed")))
				return
			}
			for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
				token, ok := strings.CutPrefix(strings.TrimSpace(protocol), "agentz.bearer.")
				if ok {
					r.Header.Set("Authorization", "Bearer "+token)
				}
			}
			r.Header.Set("Sec-WebSocket-Protocol", "agentz.pty")
		}
		next.ServeHTTP(w, r)
	})
}
