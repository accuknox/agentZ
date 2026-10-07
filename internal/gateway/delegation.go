package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"github.com/go-chi/chi/v5"
	jwtrequest "github.com/golang-jwt/jwt/v5/request"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/semaphore"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	kjson "sigs.k8s.io/json"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

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
func (s *Service) GetDelegationCatalog(w http.ResponseWriter, r *http.Request, params gatewayapi.GetDelegationCatalogParams) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims == nil || auth.claims.WorkspaceID == "" {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusForbidden, "forbidden", "Select a workspace.", nil))
		return
	}
	catalog, err := s.delegationCatalog(
		r.Context(), auth.claims.UserID, auth.claims.OrganizationID, auth.claims.WorkspaceID, params.IncludeUnavailable != nil && *params.IncludeUnavailable,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, catalog)
}

func (s *Service) delegationCatalog(ctx context.Context, userID, organizationID, workspaceID string, includeUnavailable bool) (gatewayapi.DelegationCatalog, error) {
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
				if !provider.DeletionTimestamp.IsZero() || (!includeUnavailable && provider.Status.State != agentzv1alpha1.InferenceProviderStateReady) {
					continue
				}
				_, err := scope.SelectedNamespace(ctx, s.k8sClient, workspaceNamespace, scope.Selection{
					Scope: resourceScope, Kind: agentzv1alpha1.OrganizationResourceKindInferenceProvider, Name: provider.Name,
				})
				if err != nil {
					continue
				}
				for _, model := range provider.Spec.Models {
					target, err := inference.RenderProviderTarget(&provider, model.ID)
					if err != nil || target.Policies.TLS == nil || target.Policies.TLS.InsecureSkipVerify != nil {
						continue
					}
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
			if !connection.DeletionTimestamp.IsZero() || connection.Spec.Endpoint.InsecureSkipVerify || (!includeUnavailable && !connection.Status.ToolCatalogReady) {
				continue
			}
			target, err := mcp.ParseTarget(&connection)
			if err != nil || !target.Secure {
				continue
			}
			_, err = scope.SelectedNamespace(ctx, s.k8sClient, workspaceNamespace, scope.Selection{
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

func (s *Service) checkDelegation(ctx context.Context, claims authorization.DelegationClaims, target string) (gatewaydb.GatewayGetDelegationGrantRow, gatewayapi.DelegationCatalog, error) {
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
	if target != "" {
		selection.Models = slices.DeleteFunc(selection.Models, func(model gatewayapi.DelegationModel) bool { return model.Id != target })
		selection.Mcp = slices.DeleteFunc(selection.Mcp, func(connection gatewayapi.DelegationMCP) bool { return connection.Id != target })
		if len(selection.Models)+len(selection.Mcp) != 1 {
			return grant, selection, errors.New("target is not delegated")
		}
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: claims.Subject, OrganizationID: grant.OrganizationID.String,
	})
	if err != nil {
		return grant, selection, err
	}
	workspaces := make(map[string]bool)
	// Health affects execution, not consent. Recheck ownership and permissions
	// without coupling a healthy target to another target's catalog probe.
	selectedNamespace := func(workspaceID, namespace, name string, kind agentzv1alpha1.OrganizationResourceKind, resource gatewaydb.PermissionResource) error {
		selectedScope := authorization.Scope{OrganizationID: grant.OrganizationID.String, WorkspaceID: workspaceID}
		if !effective.CanDelegate(selectedScope, resource) {
			return errors.New("resource delegation is no longer allowed")
		}
		if !workspaces[workspaceID] {
			workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
				ID: workspaceID, OrganizationID: grant.OrganizationID.String,
			})
			if err != nil {
				return err
			}
			if workspace.DeletedAt.Valid || workspace.State != gatewaydb.WorkspaceStateReady {
				return errors.New("workspace is unavailable")
			}
			workspaces[workspaceID] = true
		}
		workspaceNamespace := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, workspaceID)
		resourceScope := agentzv1alpha1.ResourceScopeWorkspace
		if namespace != workspaceNamespace {
			resourceScope = agentzv1alpha1.ResourceScopeOrganisation
		}
		current, err := scope.SelectedNamespace(ctx, s.k8sClient, workspaceNamespace, scope.Selection{
			Scope: resourceScope, Kind: kind, Name: name,
		})
		if err != nil {
			return err
		}
		if current != namespace {
			return errors.New("resource owner changed")
		}
		return nil
	}
	for _, model := range selection.Models {
		err := selectedNamespace(model.WorkspaceId, model.Namespace, model.Provider,
			agentzv1alpha1.OrganizationResourceKindInferenceProvider, gatewaydb.PermissionResourceInferenceProvider)
		if err != nil {
			return grant, selection, err
		}
		provider := &agentzv1alpha1.InferenceProvider{}
		if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: model.Namespace, Name: model.Provider}, provider); err != nil {
			return grant, selection, err
		}
		identity := model.WorkspaceId + "/" + string(provider.UID) + "/" + model.Model
		currentModel := slices.ContainsFunc(provider.Spec.Models, func(current agentzv1alpha1.InferenceModel) bool { return current.ID == model.Model })
		if !provider.DeletionTimestamp.IsZero() || string(provider.UID) != model.Uid || model.Id != identity || !currentModel {
			return grant, selection, errors.New("model delegation is no longer allowed")
		}
		target, err := inference.RenderProviderTarget(provider, model.Model)
		if err != nil {
			return grant, selection, err
		}
		if target.Policies.TLS == nil || target.Policies.TLS.InsecureSkipVerify != nil {
			return grant, selection, errors.New("delegated inference requires verified upstream TLS")
		}
	}
	for _, selected := range selection.Mcp {
		err := selectedNamespace(selected.WorkspaceId, selected.Namespace, selected.Connection,
			agentzv1alpha1.OrganizationResourceKindMCPConnection, gatewaydb.PermissionResourceMcpConnection)
		if err != nil {
			return grant, selection, err
		}
		connection := &agentzv1alpha1.MCPConnection{}
		if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}, connection); err != nil {
			return grant, selection, err
		}
		target, err := mcp.ParseTarget(connection)
		if err != nil {
			return grant, selection, err
		}
		if !target.Secure || connection.Spec.Endpoint.InsecureSkipVerify {
			return grant, selection, errors.New("delegated MCP requires verified upstream TLS")
		}
		identity := sha256.Sum256([]byte(selected.WorkspaceId + "/" + string(connection.UID)))
		if !connection.DeletionTimestamp.IsZero() || string(connection.UID) != selected.Uid || selected.Id != fmt.Sprintf("mcp-%x", identity[:16]) {
			return grant, selection, errors.New("MCP delegation is no longer allowed")
		}
	}
	return grant, selection, nil
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
	bearer, err := jwtrequest.BearerExtractor{}.ExtractToken(r)
	claims := authorization.DelegationClaims{}
	if err == nil {
		claims, err = authorization.VerifyDelegationToken(bearer, s.cfg.ExternalJWTIssuer, audience, s.externalJWTKeyfunc)
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
	grant, err := s.queries.GatewayGetDelegationGrant(r.Context(), gatewaydb.GatewayGetDelegationGrantParams{ID: claims.GrantID, ClientID: claims.ClientID, UserID: claims.Subject})
	selection := gatewayapi.DelegationCatalog{}
	if err == nil {
		err = json.Unmarshal(grant.Selection, &selection)
	}
	if err == nil {
		err = s.admitDelegation(r.Context(), r, "admission")
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || status.Code(err) == codes.PermissionDenied {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "This authorization is no longer available.")
			return
		}
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Authorization is temporarily unavailable.")
		return
	}
	if !slices.Contains(grant.Resources, audience) {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "The gateway resource was not granted.")
		return
	}
	if r.URL.Path == "/api/inference/v1/models" {
		if err := s.admitDelegation(r.Context(), r, "discovery"); err != nil {
			if status.Code(err) == codes.PermissionDenied {
				s.delegationError(w, r, http.StatusForbidden, "access_denied", "Model discovery is no longer available.")
				return
			}
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Model discovery is temporarily unavailable.")
			return
		}
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
	var body []byte
	if r.Method == http.MethodPost {
		limit := int64(32 << 20)
		if mcpRequest {
			limit = 4 << 20
		}
		weight := r.ContentLength
		if weight < 0 {
			weight = limit
		}
		if weight > limit {
			s.delegationError(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "The request body exceeds the gateway limit.")
			return
		}
		// Bound retained request buffers across concurrent streams, including
		// chunked requests whose size is unknown before reading.
		if !s.delegationBodies.TryAcquire(weight) {
			w.Header().Set("Retry-After", "1")
			s.delegationError(w, r, http.StatusTooManyRequests, "rate_limit_exceeded", "The gateway is busy. Retry shortly.")
			return
		}
		defer s.delegationBodies.Release(weight)
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		body, err = io.ReadAll(r.Body)
		if err != nil {
			status := http.StatusBadRequest
			message := "The request body cannot be read."
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				status = http.StatusRequestEntityTooLarge
				message = "The request body exceeds the gateway limit."
			}
			s.delegationError(w, r, status, "invalid_request_error", message)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}

	targetURL := s.cfg.DelegationGatewayURL
	path := "/delegations/" + claims.GrantID + "/mcp"
	if !mcpRequest {
		model, err := inference.ValidateDelegatedRequest(body, strings.HasSuffix(r.URL.Path, "/responses"))
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
		targetURL = "https://inference." + selection.Models[index].Namespace + ".svc.cluster.local:8443"
	}
	if mcpRequest {
		if r.Method != http.MethodPost {
			r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		}
		if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "GET, POST, DELETE, OPTIONS")
			s.delegationError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Use a supported MCP transport method.")
			return
		}
		if r.Method == http.MethodPost {
			var message delegatedMCPMessage
			strictErrors, decodeErr := kjson.UnmarshalStrict(body, &message, kjson.DisallowDuplicateFields)
			invalid := decodeErr != nil || len(strictErrors) != 0
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
	if err := controller.SetReadDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
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
	target, err := url.Parse(targetURL)
	if err != nil || target.Host == "" {
		s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated gateway is unavailable.")
		return
	}
	proxy := &httputil.ReverseProxy{
		Transport: s.delegationTransport,
		Rewrite: func(req *httputil.ProxyRequest) {
			req.SetURL(target)
			req.Out.URL.RawQuery = ""
			req.Out.URL.Path = path
			req.Out.URL.RawPath = ""
			// Let the transport negotiate and decode compression before inspecting errors.
			req.Out.Header.Del("Accept-Encoding")
			req.Out.Header.Set("Authorization", "Bearer "+bearer)
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
				if err := response.Body.Close(); err != nil {
					return err
				}
				// Providers may include their API key or account details in errors.
				// Preserve the HTTP status while keeping credential-bearing diagnostics private.
				response.Header.Del("Content-Encoding")
				body, err := json.Marshal(openAIError{Error: openAIErrorDetail{
					Message: "The inference provider could not complete this request.",
					Type:    "server_error", Code: "upstream_error",
				}})
				if err != nil {
					return err
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

func serveDelegation(ctx context.Context, cfg Config) error {
	if cfg.PostgresDSN == "" || cfg.ExternalJWTJWKSURL == "" || cfg.ExternalJWTIssuer == "" {
		return errors.New("delegation database, issuer and JWKS are required")
	}
	target, err := url.Parse(cfg.DelegationGatewayURL)
	if err != nil || target.Scheme != "https" || target.Host == "" {
		return errors.New("delegation gateway must use HTTPS")
	}
	if cfg.DelegationAuthorityTarget == "" || cfg.DelegationTLSDir == "" {
		return errors.New("delegation authority and workload TLS are required")
	}
	database, err := pgxpool.ParseConfig(cfg.PostgresDSN)
	if err != nil {
		return errors.New("invalid delegation database connection configuration")
	}
	db, err := pgxpool.NewWithConfig(ctx, database)
	if err != nil {
		return fmt.Errorf("create delegation database pool: %w", err)
	}
	defer db.Close()
	queries := gatewaydb.New(db)
	restricted, err := queries.GatewayCheckDelegationDatabasePrivileges(ctx)
	if err != nil {
		return fmt.Errorf("check delegation database privileges: %w", err)
	}
	if !restricted.Bool {
		return errors.New("delegation database role has credential access or authority-write privileges")
	}
	key, err := newExternalJWTKeyfunc(ctx, cfg.ExternalJWTJWKSURL)
	if err != nil {
		return err
	}
	tlsConfig, err := authorization.DelegationTLS(cfg.DelegationTLSDir)
	if err != nil {
		return err
	}
	authority, err := grpc.NewClient(cfg.DelegationAuthorityTarget, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	if err != nil {
		return fmt.Errorf("create delegation authority client: %w", err)
	}
	defer authority.Close()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	defer transport.CloseIdleConnections()
	svc := &Service{
		ctx: ctx, cfg: cfg, queries: queries, externalJWTKeyfunc: key,
		delegationRequests:  make(chan struct{}, 64),
		delegationBodies:    semaphore.NewWeighted(128 << 20),
		delegationAuthority: authv3.NewAuthorizationClient(authority), delegationTransport: transport,
	}
	router := chi.NewRouter()
	router.Use(requestLog)
	router.Route("/api/inference/v1", func(r chi.Router) {
		r.Use(svc.delegationCORS)
		r.Get("/models", svc.handleDelegatedRequest)
		r.Post("/chat/completions", svc.handleDelegatedRequest)
		r.Post("/responses", svc.handleDelegatedRequest)
		for _, path := range []string{"/models", "/chat/completions", "/responses"} {
			r.Options(path, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
		}
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			svc.delegationError(w, r, http.StatusNotFound, "not_found", "This inference endpoint is unavailable.")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
			svc.delegationError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Use the supported HTTP method for this endpoint.")
		})
	})
	router.With(svc.delegationCORS).HandleFunc("/api/mcp", svc.handleDelegatedRequest)
	server := &http.Server{Addr: cfg.Addr, Handler: router, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func (s *Service) admitDelegation(ctx context.Context, request *http.Request, operation string) error {
	response, err := s.delegationAuthority.Check(ctx, &authv3.CheckRequest{Attributes: &authv3.AttributeContext{
		ContextExtensions: map[string]string{"agentz.operation": operation},
		Request: &authv3.AttributeContext_Request{Http: &authv3.AttributeContext_HttpRequest{
			Path: request.URL.Path, Headers: map[string]string{"authorization": request.Header.Get("Authorization")},
		}},
	}})
	if err != nil {
		return fmt.Errorf("delegation authority unavailable: %w", err)
	}
	if response.GetStatus().GetCode() != int32(codes.OK) {
		if response.GetDeniedResponse().GetStatus().GetCode() == 503 {
			return status.Error(codes.Unavailable, "delegation authority unavailable")
		}
		return status.Error(codes.PermissionDenied, "delegation is no longer allowed")
	}
	return nil
}

// Check authorizes a signed delegation for an authenticated workload. It never
// reads or returns provider credentials.
func (s *Service) Check(ctx context.Context, request *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	extensions := request.GetAttributes().GetContextExtensions()
	remote, ok := peer.FromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("delegation peer missing")
	}
	identity, ok := remote.AuthInfo.(credentials.TLSInfo)
	if !ok || len(identity.State.VerifiedChains) == 0 {
		return nil, fmt.Errorf("delegation peer unauthenticated")
	}
	operation := extensions["agentz.operation"]
	public := false
	for _, name := range identity.State.PeerCertificates[0].DNSNames {
		public = public || name == s.cfg.DelegationPublicPeer
	}
	owner := ""
	target := ""
	var err error
	switch operation {
	case "admission", "discovery":
		if !public {
			err = errors.New("only the public gateway may request admission")
		}
	case "aggregation":
		trusted := false
		for _, name := range identity.State.PeerCertificates[0].DNSNames {
			trusted = trusted || name == "delegations."+s.cfg.DelegationNamespace+".svc"
		}
		if !trusted {
			err = errors.New("peer is not the delegation aggregator")
		}
	case "inference", "mcp", "mcp-admission":
		owner, err = authorization.DelegationOwner(identity.State)
		target = extensions["agentz.target"]
		if err == nil && (target == "" || owner != extensions["agentz.namespace"]) {
			err = errors.New("delegation owner mismatch")
		}
	default:
		err = errors.New("invalid delegation operation")
	}
	path := "/api/mcp"
	requiredScope := "mcp:use"
	if operation == "inference" || strings.HasPrefix(request.GetAttributes().GetRequest().GetHttp().GetPath(), "/api/inference/v1") {
		path = "/api/inference/v1"
		requiredScope = "inference:use"
	}
	audience := strings.TrimRight(s.cfg.ExternalJWTIssuer, "/") + path
	scheme, bearer, valid := strings.Cut(request.GetAttributes().GetRequest().GetHttp().GetHeaders()["authorization"], " ")
	claims := authorization.DelegationClaims{}
	if err == nil && (!valid || !strings.EqualFold(scheme, "Bearer")) {
		err = errors.New("access token missing")
	}
	if err == nil {
		claims, err = authorization.VerifyDelegationToken(bearer, s.cfg.ExternalJWTIssuer, audience, s.externalJWTKeyfunc)
	}
	if err == nil && !slices.Contains(strings.Fields(claims.Scope), requiredScope) {
		err = errors.New("required scope missing")
	}
	if err == nil && claims.SessionID != "" {
		active, sessionErr := s.queries.GatewayCheckDelegationSession(ctx, gatewaydb.GatewayCheckDelegationSessionParams{ID: claims.SessionID, UserID: claims.Subject})
		err = sessionErr
		if err == nil && !active {
			err = errors.New("sign-in session revoked")
		}
	}
	grant := gatewaydb.GatewayGetDelegationGrantRow{}
	selection := gatewayapi.DelegationCatalog{}
	if err == nil {
		switch operation {
		case "admission":
			grant, err = s.queries.GatewayGetDelegationGrant(ctx, gatewaydb.GatewayGetDelegationGrantParams{ID: claims.GrantID, ClientID: claims.ClientID, UserID: claims.Subject})
		default:
			grant, selection, err = s.checkDelegation(ctx, claims, target)
		}
	}
	if err == nil && !slices.Contains(grant.Resources, audience) {
		err = errors.New("resource is not granted")
	}
	if err == nil {
		for _, scope := range strings.Fields(claims.Scope) {
			if !slices.Contains(grant.Scopes, scope) {
				err = errors.New("scope is not granted")
			}
		}
	}
	if err == nil && (target != "" || operation == "aggregation") {
		if claims.GrantID != extensions["agentz.grant"] || claims.ClientID != extensions["agentz.client"] || claims.Subject != extensions["agentz.user"] {
			err = errors.New("token does not match the projected grant")
		}
		switch operation {
		case "inference":
			if len(selection.Models) != 1 || selection.Models[0].Namespace != owner || selection.Models[0].Uid != extensions["agentz.uid"] || selection.Models[0].Provider != extensions["agentz.name"] {
				err = errors.New("provider owner mismatch")
			}
		case "mcp", "mcp-admission":
			if len(selection.Mcp) != 1 || selection.Mcp[0].Namespace != owner || selection.Mcp[0].Uid != extensions["agentz.uid"] || selection.Mcp[0].Connection != extensions["agentz.name"] {
				err = errors.New("MCP owner mismatch")
			}
		}
	}
	if err == nil && target != "" {
		full := gatewayapi.DelegationCatalog{}
		err = json.Unmarshal(grant.Selection, &full)
		if err == nil && operation == "inference" {
			index := slices.IndexFunc(full.Models, func(model gatewayapi.DelegationModel) bool { return model.Id == target })
			err = s.delegationReady(ctx, grant, owner, inference.GatewayName, fmt.Sprintf("d-%s-model-%d", grant.ID, index))
		}
		if err == nil && (operation == "mcp" || operation == "mcp-admission") {
			index := slices.IndexFunc(full.Mcp, func(connection gatewayapi.DelegationMCP) bool { return connection.Id == target })
			name := fmt.Sprintf("d-%s-mcp-%d", grant.ID, index)
			err = s.delegationReady(ctx, grant, owner, mcp.GatewayName, name, name+"-auth", name+"-admission")
		}
		if err != nil {
			err = status.Error(codes.Unavailable, "delegated owner route is not ready")
		}
	}

	if err == nil && operation == "aggregation" {
		name := "d-" + grant.ID + "-mcp"
		err = s.delegationReady(ctx, grant, s.cfg.DelegationNamespace, "delegations", name, name+"-admission")
		if err != nil {
			err = status.Error(codes.Unavailable, "delegated MCP route is not ready")
		}
	}

	if err != nil {
		code, httpStatus := codes.PermissionDenied, typev3.StatusCode_Forbidden
		var networkError net.Error
		var databaseError *pgconn.PgError
		dependencyError := errors.As(err, &networkError) || errors.As(err, &databaseError) || errors.Is(err, context.DeadlineExceeded)
		dependencyError = dependencyError || apierrors.IsServiceUnavailable(err) || apierrors.IsTimeout(err) || apierrors.IsServerTimeout(err)
		if dependencyError || status.Code(err) == codes.Unavailable {
			code, httpStatus = codes.Unavailable, typev3.StatusCode_ServiceUnavailable
		}
		slog.WarnContext(ctx, "delegated request denied", slog.String("grant", claims.GrantID), slog.String("target", target), slog.Any("error", err))
		return &authv3.CheckResponse{
			Status:       &statuspb.Status{Code: int32(code)},
			HttpResponse: &authv3.CheckResponse_DeniedResponse{DeniedResponse: &authv3.DeniedHttpResponse{Status: &typev3.HttpStatus{Code: httpStatus}}},
		}, nil
	}
	return &authv3.CheckResponse{Status: &statuspb.Status{Code: int32(codes.OK)}, HttpResponse: &authv3.CheckResponse_OkResponse{OkResponse: &authv3.OkHttpResponse{}}}, nil
}
