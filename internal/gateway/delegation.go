package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	jwtrequest "github.com/golang-jwt/jwt/v5/request"
	"github.com/jackc/pgx/v5/pgtype"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	kjson "sigs.k8s.io/json"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type delegationClaims struct {
	jwt.RegisteredClaims
	ClientID string `json:"client_id"`
	GrantID  string `json:"agentz_grant_id"`
	Scope    string `json:"scope"`
}

type inferenceRequest struct {
	Model              string               `json:"model"`
	Store              *bool                `json:"store"`
	Background         bool                 `json:"background"`
	PreviousResponseID string               `json:"previous_response_id"`
	Conversation       json.RawMessage      `json:"conversation"`
	Prompt             json.RawMessage      `json:"prompt"`
	WebSearchOptions   json.RawMessage      `json:"web_search_options"`
	Tools              []inferenceTool      `json:"tools"`
	Input              json.RawMessage      `json:"input"`
	Messages           []inferenceInputItem `json:"messages"`
}

type inferenceTool struct {
	Type string `json:"type"`
}

type inferenceInputItem struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
	Output  json.RawMessage `json:"output"`
	Audio   json.RawMessage `json:"audio"`
}

type inferenceContentPart struct {
	FileID string         `json:"file_id"`
	File   *inferenceFile `json:"file"`
}

type inferenceFile struct {
	FileID string `json:"file_id"`
}

type delegatedMCPMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
}

type openAIModel struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type openAIModels struct {
	Object string        `json:"object"`
	Data   []openAIModel `json:"data"`
}

type openAIErrorDetail struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Param   *string `json:"param"`
	Code    string  `json:"code"`
}

type openAIError struct {
	Error openAIErrorDetail `json:"error"`
}

// GetDelegationCatalog discovers exact capabilities under current Workspace permissions.
func (s *Service) GetDelegationCatalog(w http.ResponseWriter, r *http.Request, _ gatewayapi.GetDelegationCatalogParams) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims == nil || auth.claims.WorkspaceID == "" {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusForbidden, "forbidden", "Select a workspace.", nil))
		return
	}
	catalog, err := s.delegationCatalog(
		r.Context(), auth.claims.UserID, auth.claims.OrganizationID, auth.claims.WorkspaceID,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, catalog)
}

func (s *Service) delegationCatalog(ctx context.Context, userID, organizationID, workspaceID string) (gatewayapi.DelegationCatalog, error) {
	catalog := gatewayapi.DelegationCatalog{Models: []gatewayapi.DelegationModel{}, Mcp: []gatewayapi.DelegationMCP{}}
	workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
		ID: workspaceID, OrganizationID: organizationID,
	})
	if err != nil {
		return catalog, err
	}
	if workspace.DeletedAt.Valid || workspace.State != gatewaydb.WorkspaceStateReady {
		return catalog, errors.New("workspace is unavailable")
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: userID, OrganizationID: organizationID,
	})
	if err != nil {
		return catalog, err
	}
	selectedScope := authorization.Scope{OrganizationID: organizationID, WorkspaceID: workspaceID}
	workspaceNamespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, workspaceID)
	organizationNamespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeOrganisation, organizationID)
	for _, namespace := range []string{workspaceNamespace, organizationNamespace} {
		resourceScope := agentzv1alpha1.ResourceScopeWorkspace
		if namespace == organizationNamespace {
			resourceScope = agentzv1alpha1.ResourceScopeOrganisation
		}
		if effective.CanDelegate(selectedScope, gatewaydb.PermissionResourceInferenceProvider) {
			providers := &agentzv1alpha1.InferenceProviderList{}
			if err := s.k8sClient.List(ctx, providers, ctrlclient.InNamespace(namespace)); err != nil {
				return catalog, err
			}
			for _, provider := range providers.Items {
				if !provider.DeletionTimestamp.IsZero() || provider.Status.State != agentzv1alpha1.InferenceProviderStateReady {
					continue
				}
				_, err := scope.SelectedNamespace(ctx, s.k8sClient, workspaceNamespace, scope.Selection{
					Scope: resourceScope, Kind: agentzv1alpha1.OrganizationResourceKindInferenceProvider, Name: provider.Name,
				})
				if err != nil {
					continue
				}
				for _, model := range provider.Spec.Models {
					catalog.Models = append(catalog.Models, gatewayapi.DelegationModel{
						Id:          workspaceID + "/" + string(provider.UID) + "/" + model.ID,
						WorkspaceId: workspaceID, Namespace: namespace, Provider: provider.Name,
						Uid: string(provider.UID), Model: model.ID,
					})
				}
			}
		}
		if !effective.CanDelegate(selectedScope, gatewaydb.PermissionResourceMcpConnection) {
			continue
		}
		connections := &agentzv1alpha1.MCPConnectionList{}
		if err := s.k8sClient.List(ctx, connections, ctrlclient.InNamespace(namespace)); err != nil {
			return catalog, err
		}
		for _, connection := range connections.Items {
			if !connection.DeletionTimestamp.IsZero() || !connection.Status.ToolCatalogReady {
				continue
			}
			_, err := scope.SelectedNamespace(ctx, s.k8sClient, workspaceNamespace, scope.Selection{
				Scope: resourceScope, Kind: agentzv1alpha1.OrganizationResourceKindMCPConnection, Name: connection.Name,
			})
			if err != nil {
				continue
			}
			tools := make([]string, 0, len(connection.Status.Tools))
			for _, tool := range connection.Status.Tools {
				tools = append(tools, tool.Name)
			}
			targetID := sha256.Sum256([]byte(workspaceID + "/" + string(connection.UID)))
			catalog.Mcp = append(catalog.Mcp, gatewayapi.DelegationMCP{
				Id: fmt.Sprintf("mcp-%x", targetID[:16]), WorkspaceId: workspaceID, Namespace: namespace,
				Connection: connection.Name, Uid: string(connection.UID), Tools: tools,
				Prompts:   append([]string{}, connection.Status.Prompts...),
				Resources: append([]string{}, connection.Status.Resources...),
			})
		}
	}
	return catalog, nil
}

func (s *Service) checkDelegation(ctx context.Context, claims delegationClaims) (gatewaydb.GatewayGetDelegationGrantRow, gatewayapi.DelegationCatalog, error) {
	grant, err := s.queries.GatewayGetDelegationGrant(ctx, gatewaydb.GatewayGetDelegationGrantParams{
		ID: claims.GrantID, ClientID: claims.ClientID, UserID: claims.Subject,
	})
	selection := gatewayapi.DelegationCatalog{}
	if err != nil {
		return grant, selection, err
	}
	if err := json.Unmarshal(grant.Selection, &selection); err != nil {
		return grant, selection, err
	}
	for _, requestedScope := range strings.Fields(claims.Scope) {
		if !slices.Contains(grant.Scopes, requestedScope) {
			return grant, selection, errors.New("scope is not granted")
		}
	}
	catalogs := make(map[string]gatewayapi.DelegationCatalog)
	workspaceIDs := make(map[string]struct{})
	for _, model := range selection.Models {
		workspaceIDs[model.WorkspaceId] = struct{}{}
	}
	for _, connection := range selection.Mcp {
		workspaceIDs[connection.WorkspaceId] = struct{}{}
	}
	for workspaceID := range workspaceIDs {
		catalog, err := s.delegationCatalog(ctx, claims.Subject, grant.OrganizationID.String, workspaceID)
		if err != nil {
			return grant, selection, err
		}
		catalogs[workspaceID] = catalog
	}
	for _, model := range selection.Models {
		catalog := catalogs[model.WorkspaceId]
		if !slices.Contains(catalog.Models, model) {
			return grant, selection, errors.New("model delegation is no longer allowed")
		}
	}
	for _, connection := range selection.Mcp {
		catalog := catalogs[connection.WorkspaceId]
		found := false
		for _, current := range catalog.Mcp {
			sameIdentity := current.Id == connection.Id && current.Uid == connection.Uid
			sameTarget := current.Namespace == connection.Namespace && current.Connection == connection.Connection
			if !sameIdentity || !sameTarget {
				continue
			}
			found = true
			for _, name := range connection.Tools {
				found = found && slices.Contains(current.Tools, name)
			}
			for _, name := range connection.Prompts {
				found = found && slices.Contains(current.Prompts, name)
			}
			for _, uri := range connection.Resources {
				found = found && slices.Contains(current.Resources, uri)
			}
		}
		if !found {
			return grant, selection, errors.New("MCP delegation is no longer allowed")
		}
	}
	return grant, selection, nil
}

// delegatedInferenceModel validates the resource-bearing portions of the OpenAI
// request. Case-sensitive decoding matches the upstream contract, while strict
// duplicate detection prevents two parsers from authorizing different values.
func delegatedInferenceModel(body []byte, responses bool) (string, error) {
	var input inferenceRequest
	strictErrors, err := kjson.UnmarshalStrict(body, &input, kjson.DisallowDuplicateFields)
	if err != nil || len(strictErrors) != 0 || input.Model == "" {
		return "", errors.New("provide a valid inference request with a model and no duplicate fields")
	}
	storedResponse := responses && (input.Store == nil || input.Background || input.PreviousResponseID != "")
	conversation := len(input.Conversation) != 0 && string(input.Conversation) != "null"
	if input.Store != nil && *input.Store || storedResponse || responses && conversation {
		return "", errors.New("use store:false and explicit conversation input; stored and background responses are unavailable")
	}
	// A model grant never authorizes the owner's stored data or hosted tools.
	storedPrompt := len(input.Prompt) != 0 && string(input.Prompt) != "null"
	hostedTools := slices.ContainsFunc(input.Tools, func(tool inferenceTool) bool {
		return tool.Type != "function"
	})
	hostedSearch := !responses && len(input.WebSearchOptions) != 0 && string(input.WebSearchOptions) != "null"
	if storedPrompt || hostedTools || hostedSearch {
		return "", errors.New("use inline prompts and client-side function tools; provider account resources are unavailable")
	}
	items := input.Messages
	if responses {
		items = nil
		// Responses input has a documented string/array union.
		if len(input.Input) != 0 && input.Input[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(input.Input, &items, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return "", errors.New("invalid response input")
			}
		}
	}
	for _, item := range items {
		if !responses && len(item.Audio) != 0 && string(item.Audio) != "null" {
			return "", errors.New("stored audio is unavailable; provide inline audio input")
		}
		// ItemReference permits omitting its type; explicit messages with IDs
		// carry type:"message" in the Responses input contract.
		implicitReference := responses && item.Type == "" && item.ID != ""
		if item.Type == "item_reference" || implicitReference {
			return "", errors.New("stored input items are unavailable; provide explicit input")
		}
		var content []inferenceContentPart
		if len(item.Content) != 0 && item.Content[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(item.Content, &content, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return "", errors.New("invalid message content")
			}
		}
		if responses {
			switch item.Type {
			case "function_call_output":
				// Function output is text or an array of text, images, and files.
				if len(item.Output) != 0 && item.Output[0] == '[' {
					var output []inferenceContentPart
					strictErrors, err = kjson.UnmarshalStrict(item.Output, &output, kjson.DisallowDuplicateFields)
					if err != nil || len(strictErrors) != 0 {
						return "", errors.New("invalid function output")
					}
					content = append(content, output...)
				}
			case "computer_call_output":
				var screenshot inferenceContentPart
				strictErrors, err = kjson.UnmarshalStrict(item.Output, &screenshot, kjson.DisallowDuplicateFields)
				if err != nil || len(strictErrors) != 0 {
					return "", errors.New("invalid computer output")
				}
				content = append(content, screenshot)
			}
		}
		for _, part := range content {
			if part.FileID != "" || part.File != nil && part.File.FileID != "" {
				return "", errors.New("stored provider files are unavailable; provide inline content or a URL")
			}
		}
	}
	return input.Model, nil
}

func (s *Service) handleDelegatedRequest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	requestContext := r.Context()
	admissionContext, cancelAdmission := context.WithTimeout(requestContext, 30*time.Second)
	defer cancelAdmission()
	r = r.WithContext(admissionContext)
	controller := http.NewResponseController(w)
	err := controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The gateway is unavailable.")
		return
	}
	mcpRequest := r.URL.Path == "/api/mcp"
	resourcePath, requiredScope := "/api/inference/v1", "inference:use"
	if mcpRequest {
		resourcePath, requiredScope = "/api/mcp", "mcp:use"
	}
	audience := strings.TrimRight(s.cfg.ExternalJWTIssuer, "/") + resourcePath
	claims := delegationClaims{}
	bearer, err := jwtrequest.BearerExtractor{}.ExtractToken(r)
	if err == nil {
		var token *jwt.Token
		token, err = jwt.ParseWithClaims(bearer, &claims, s.externalJWTKeyfunc,
			jwt.WithValidMethods([]string{"ES256", "RS256"}), jwt.WithIssuer(s.cfg.ExternalJWTIssuer),
			jwt.WithAudience(audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithStrictDecoding(),
		)
		if err == nil {
			missingIdentity := claims.GrantID == "" || claims.ClientID == "" || claims.Subject == ""
			if token.Header["typ"] != "at+jwt" || missingIdentity || claims.IssuedAt == nil {
				err = errors.New("invalid delegated access token")
			}
		}
	}
	if err != nil {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata=%q`, strings.TrimRight(s.cfg.ExternalJWTIssuer, "/")+"/.well-known/oauth-protected-resource"+resourcePath))
		s.delegationError(w, r, http.StatusUnauthorized, "invalid_token", "A valid AgentZ access token is required.")
		return
	}
	if !slices.Contains(strings.Fields(claims.Scope), requiredScope) {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer error="insufficient_scope", scope=%q`, requiredScope))
		s.delegationError(w, r, http.StatusForbidden, "insufficient_scope", "The required scope was not granted.")
		return
	}
	grant, selection, err := s.checkDelegation(r.Context(), claims)
	if err != nil {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "This authorization is no longer available.")
		return
	}
	if !slices.Contains(grant.Resources, audience) {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "The gateway resource was not granted.")
		return
	}
	if r.URL.Path == "/api/inference/v1/models" {
		models := openAIModels{Object: "list", Data: []openAIModel{}}
		for _, model := range selection.Models {
			models.Data = append(models.Data, openAIModel{
				ID: model.Id, Object: "model",
				Created: grant.CreatedAt.Time.Unix(), OwnedBy: model.Provider,
			})
		}
		apiutil.WriteJSON(w, http.StatusOK, models)
		return
	}
	path := "/delegations/" + claims.GrantID + "/mcp"
	routeName := "d-" + claims.GrantID + "-mcp"
	if !mcpRequest {
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			s.delegationError(w, r, http.StatusBadRequest, "invalid_request_error", "The inference request body cannot be read.")
			return
		}
		model, err := delegatedInferenceModel(body, strings.HasSuffix(r.URL.Path, "/responses"))
		if err != nil {
			s.delegationError(w, r, http.StatusBadRequest, "invalid_request_error", err.Error())
			return
		}
		index := slices.IndexFunc(selection.Models, func(selected gatewayapi.DelegationModel) bool {
			return selected.Id == model
		})
		if index < 0 {
			s.delegationError(w, r, http.StatusNotFound, "model_not_found", "The requested model is not available.")
			return
		}
		path = fmt.Sprintf("/delegations/%s/models/%d%s", claims.GrantID, index, strings.TrimPrefix(r.URL.Path, resourcePath))
		routeName = fmt.Sprintf("d-%s-model-%d", claims.GrantID, index)
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	if mcpRequest {
		if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "GET, POST, DELETE, OPTIONS")
			s.delegationError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Use a supported MCP transport method.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		if r.Method == http.MethodPost {
			body, err := io.ReadAll(r.Body)
			var message delegatedMCPMessage
			strictErrors, decodeErr := kjson.UnmarshalStrict(body, &message, kjson.DisallowDuplicateFields)
			invalid := err != nil || decodeErr != nil || len(strictErrors) != 0
			if invalid || message.JSONRPC != "2.0" || message.Method == "" {
				s.delegationError(w, r, http.StatusBadRequest, "invalid_request", "Provide a valid MCP JSON-RPC message.")
				return
			}
			switch message.Method {
			case "initialize", "ping", "notifications/initialized", "notifications/cancelled",
				"tools/list", "tools/call", "prompts/list", "prompts/get",
				"resources/list", "resources/read", "resources/templates/list":
			default:
				if len(message.ID) == 0 {
					w.WriteHeader(http.StatusAccepted)
					return
				}
				apiutil.WriteJSON(w, http.StatusOK, map[string]any{
					"jsonrpc": "2.0", "id": message.ID,
					"error": map[string]any{"code": -32601, "message": "This MCP operation is unavailable through delegated access."},
				})
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		if session := r.Header.Get("Mcp-Session-Id"); session != "" {
			valid, err := s.queries.GatewayCheckDelegationMCPSession(r.Context(), gatewaydb.GatewayCheckDelegationMCPSessionParams{
				ID: session, GrantID: grant.ID,
			})
			if err != nil || !valid {
				s.delegationError(w, r, http.StatusNotFound, "invalid_session", "The MCP session does not belong to this authorization.")
				return
			}
		}
	}
	if err := s.delegationReady(r.Context(), grant, routeName, mcpRequest, len(selection.Mcp)); err != nil {
		w.Header().Set("Retry-After", "5")
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "This authorization is being prepared. Retry shortly.")
		return
	}
	err = controller.SetReadDeadline(time.Time{})
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The gateway is unavailable.")
		return
	}
	deadline := time.Now().Add(10 * time.Minute)
	err = controller.SetWriteDeadline(deadline)
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The gateway is unavailable.")
		return
	}
	ctx, cancel := context.WithDeadline(requestContext, deadline)
	cancelAdmission()
	defer cancel()
	target, err := url.Parse(s.cfg.DelegationGatewayURL)
	if err != nil || target.Host == "" {
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated gateway is unavailable.")
		return
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(req *httputil.ProxyRequest) {
			req.SetURL(target)
			req.Out.URL.Path = path
			req.Out.URL.RawPath = ""
			// Let the transport negotiate and decode compression before inspecting errors.
			req.Out.Header.Del("Accept-Encoding")
			req.Out.Header.Del("Authorization")
			req.Out.Header.Del("Cookie")
			req.Out.Header.Del("Origin")
			req.Out.Header.Del("OpenAI-Organization")
			req.Out.Header.Del("OpenAI-Project")
			req.Out.Header.Del("ChatGPT-Account-Id")
			req.Out.Header.Del("Api-Key")
			req.Out.Header.Del("X-Api-Key")
			for key := range req.Out.Header {
				name := strings.ToLower(key)
				if strings.HasPrefix(name, "x-agentz-") || strings.HasPrefix(name, "x-sandbox-") {
					req.Out.Header.Del(key)
				}
			}
		},
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			response.Header.Del("Set-Cookie")
			// Intermediary compression must not buffer streamed inference or MCP events.
			response.Header.Set("Cache-Control", "no-store, no-transform")
			if !mcpRequest {
				if response.StatusCode < http.StatusBadRequest {
					return nil
				}
				body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
				if err != nil {
					return err
				}
				if err := response.Body.Close(); err != nil {
					return err
				}
				var upstream openAIError
				if json.Unmarshal(body, &upstream) != nil || upstream.Error.Message == "" {
					response.Header.Del("Content-Encoding")
					body, err = json.Marshal(openAIError{Error: openAIErrorDetail{
						Message: "The inference provider could not complete this request.",
						Type:    "server_error", Code: "upstream_error",
					}})
					if err != nil {
						return err
					}
				}
				response.Body = io.NopCloser(bytes.NewReader(body))
				response.ContentLength = int64(len(body))
				response.Header.Set("Content-Type", "application/json")
				response.Header.Del("Content-Length")
				return nil
			}
			session := response.Header.Get("Mcp-Session-Id")
			if session == "" {
				return nil
			}
			updated, err := s.queries.GatewaySaveDelegationMCPSession(ctx, gatewaydb.GatewaySaveDelegationMCPSessionParams{
				ID: session, GrantID: grant.ID, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(24 * time.Hour), Valid: true},
			})
			if err != nil {
				return err
			}
			if updated != 1 {
				return errors.New("MCP session binding collision")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, _ error) {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated gateway is unavailable.")
		},
	}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

func (s *Service) delegationError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	if r.URL.Path == "/api/mcp" {
		apiutil.WriteError(w, r, apiutil.NewError(status, code, message, nil))
		return
	}
	apiutil.WriteJSON(w, status, openAIError{Error: openAIErrorDetail{Message: message, Type: code, Code: code}})
}

func (s *Service) delegationCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.delegationRequests <- struct{}{}:
			defer func() { <-s.delegationRequests }()
		default:
			w.Header().Set("Retry-After", "1")
			s.delegationError(w, r, http.StatusTooManyRequests, "rate_limit_exceeded", "The gateway is busy. Retry shortly.")
			return
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		redirects, err := s.queries.GatewayListDelegationRedirects(ctx)
		cancel()
		if err != nil {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Application registration is unavailable.")
			return
		}
		allowed := false
		for _, uris := range redirects {
			for _, uri := range uris {
				registered, err := url.Parse(uri)
				if err != nil {
					continue
				}
				host := strings.ToLower(registered.Host)
				defaultPort := registered.Scheme == "https" && registered.Port() == "443"
				defaultPort = defaultPort || registered.Scheme == "http" && registered.Port() == "80"
				if defaultPort {
					host = strings.TrimSuffix(host, ":"+registered.Port())
				}
				if registered.Scheme+"://"+host == origin {
					allowed = true
				}
			}
		}
		if !allowed {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "This application origin is not registered.")
			return
		}
		w.Header().Add("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate, X-Request-Id")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, "+r.Header.Get("Access-Control-Request-Headers"))
			w.Header().Set("Access-Control-Max-Age", "300")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
