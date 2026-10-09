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

	jwtrequest "github.com/golang-jwt/jwt/v5/request"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/net/http/httpguts"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
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

var errDelegationLookup = errors.New("delegation lookup failed")

// Empty grants have no upstream routes or MCP session state. The SDK still
// handles initialization, empty discovery, and rejected execution requests.
var emptyDelegationMCP = func() http.Handler {
	server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "agentz", Version: "v0.0.1"}, &mcpsdk.ServerOptions{
		Capabilities: &mcpsdk.ServerCapabilities{
			Tools: &mcpsdk.ToolCapabilities{}, Prompts: &mcpsdk.PromptCapabilities{},
			Resources: &mcpsdk.ResourceCapabilities{},
		},
		GetSessionID: func() string { return "" },
	})
	return mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server {
		return server
	}, &mcpsdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
}()

type delegatedMCPMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
}

type openAIModel struct {
	ID                 string   `json:"id"`
	Object             string   `json:"object"`
	Created            int64    `json:"created"`
	OwnedBy            string   `json:"owned_by"`
	SupportedEndpoints []string `json:"supported_endpoints"`
	StreamingOnly      bool     `json:"streaming_only"`
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
	namespaces := []string{workspaceNamespace, organizationNamespace}
	for _, namespace := range namespaces {
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
				unavailable := !includeUnavailable && provider.Status.State != agentzv1alpha1.InferenceProviderStateReady
				if !provider.DeletionTimestamp.IsZero() || unavailable {
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
						Id:                  workspaceID + "/" + string(provider.UID) + "/" + model.ID,
						WorkspaceId:         workspaceID,
						Namespace:           namespace,
						Provider:            provider.Name,
						ProviderDisplayName: provider.Spec.DisplayName,
						Uid:                 string(provider.UID),
						Model:               model.ID,
						ModelDisplayName:    model.DisplayName,
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
			probe := meta.FindStatusCondition(connection.Status.Conditions, mcp.ConditionProbeHealthy)
			currentCatalog := probe != nil && probe.ObservedGeneration == connection.Generation
			unavailable := !includeUnavailable && (!connection.Status.ToolCatalogReady || !currentCatalog)
			if !connection.DeletionTimestamp.IsZero() || connection.Spec.Endpoint.InsecureSkipVerify || unavailable {
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

func (s *Service) checkDelegation(ctx context.Context, grant gatewaydb.DelegationGrant, selection gatewayapi.DelegationCatalog) error {
	if len(selection.Models) == 0 && len(selection.Mcp) == 0 {
		return nil
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{
		UserID: grant.UserID, OrganizationID: grant.OrganizationID.String,
	})
	if err != nil {
		return errors.Join(errDelegationLookup, err)
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
				if errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				return errors.Join(errDelegationLookup, err)
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
			return err
		}
		provider := &agentzv1alpha1.InferenceProvider{}
		key := ctrlclient.ObjectKey{Namespace: model.Namespace, Name: model.Provider}
		err = s.k8sClient.Get(ctx, key, provider)
		if err != nil {
			return err
		}
		identity := model.WorkspaceId + "/" + string(provider.UID) + "/" + model.Model
		currentModel := slices.ContainsFunc(provider.Spec.Models, func(current agentzv1alpha1.InferenceModel) bool { return current.ID == model.Model })
		changed := string(provider.UID) != model.Uid || model.Id != identity || !currentModel
		if !provider.DeletionTimestamp.IsZero() || changed {
			return errors.New("model delegation is no longer allowed")
		}
		target, err := inference.RenderProviderTarget(provider, model.Model)
		if err != nil {
			return err
		}
		if target.Policies.TLS == nil || target.Policies.TLS.InsecureSkipVerify != nil {
			return errors.New("delegated inference requires verified upstream TLS")
		}
	}
	for _, selected := range selection.Mcp {
		err := selectedNamespace(selected.WorkspaceId, selected.Namespace, selected.Connection,
			agentzv1alpha1.OrganizationResourceKindMCPConnection, gatewaydb.PermissionResourceMcpConnection)
		if err != nil {
			return err
		}
		connection := &agentzv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}
		err = s.k8sClient.Get(ctx, key, connection)
		if err != nil {
			return err
		}
		target, err := mcp.ParseTarget(connection)
		if err != nil {
			return err
		}
		if !target.Secure || connection.Spec.Endpoint.InsecureSkipVerify {
			return errors.New("delegated MCP requires verified upstream TLS")
		}
		identity := sha256.Sum256([]byte(selected.WorkspaceId + "/" + string(connection.UID)))
		changed := string(connection.UID) != selected.Uid || selected.Id != fmt.Sprintf("mcp-%x", identity[:16])
		if !connection.DeletionTimestamp.IsZero() || changed {
			return errors.New("MCP delegation is no longer allowed")
		}
	}
	return nil
}

func (s *Service) handleDelegatedRequest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	requestContext := r.Context()
	admissionContext, cancelAdmission := context.WithTimeout(requestContext, 30*time.Second)
	defer cancelAdmission()
	r = r.WithContext(admissionContext)
	controller := http.NewResponseController(w)
	// Deadlines belong to this request, not later requests on its connection.
	defer func() {
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
	}()
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
	claimedScopes := strings.Fields(claims.Scope)
	if !slices.Contains(claimedScopes, requiredScope) {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer error="insufficient_scope", scope=%q`, requiredScope))
		s.delegationError(w, r, http.StatusForbidden, "insufficient_scope", "The required scope was not granted.")
		return
	}
	deny := func(err error, unavailable bool) {
		var networkError net.Error
		unavailable = unavailable || errors.Is(err, errDelegationLookup) || errors.As(err, &networkError)
		unavailable = unavailable || errors.Is(err, context.DeadlineExceeded)
		unavailable = unavailable || apierrors.IsServiceUnavailable(err) || apierrors.IsTimeout(err) || apierrors.IsServerTimeout(err)
		status, code, message := http.StatusForbidden, "access_denied", "This authorization is no longer available."
		if unavailable {
			status, code, message = http.StatusServiceUnavailable, "service_unavailable", "Authorization is temporarily unavailable."
		}
		slog.WarnContext(r.Context(), "delegated request denied", slog.String("grant", claims.GrantID), slog.Any("error", err))
		s.delegationError(w, r, status, code, message)
	}
	if claims.SessionID != "" && !slices.Contains(claimedScopes, "offline_access") {
		active, err := s.queries.GatewayCheckDelegationSession(r.Context(), gatewaydb.GatewayCheckDelegationSessionParams{ID: claims.SessionID, UserID: claims.Subject})
		if err != nil {
			deny(err, true)
			return
		}
		if !active {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "This sign-in session is no longer available.")
			return
		}
	}
	grant, err := s.queries.GatewayGetDelegationGrant(r.Context(), gatewaydb.GatewayGetDelegationGrantParams{
		ID: claims.GrantID, ClientID: claims.ClientID, UserID: claims.Subject,
		Origin: r.Header.Get("Origin"),
	})
	if err != nil {
		deny(err, !errors.Is(err, pgx.ErrNoRows))
		return
	}
	selection := gatewayapi.DelegationCatalog{}
	if err := json.Unmarshal(grant.Selection, &selection); err != nil {
		deny(err, true)
		return
	}
	for _, scope := range claimedScopes {
		if !slices.Contains(grant.Scopes, scope) {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "The requested scope is not granted.")
			return
		}
	}
	if !slices.Contains(grant.Resources, audience) {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "The gateway resource was not granted.")
		return
	}
	if r.URL.Path == "/api/inference/v1/models" {
		err := s.checkDelegation(r.Context(), grant, gatewayapi.DelegationCatalog{Models: selection.Models})
		if err != nil {
			deny(err, false)
			return
		}
		models := openAIModels{Object: "list", Data: []openAIModel{}}
		for _, model := range selection.Models {
			provider := &agentzv1alpha1.InferenceProvider{}
			err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: model.Namespace, Name: model.Provider}, provider)
			if err != nil {
				deny(err, false)
				return
			}
			models.Data = append(models.Data, openAIModel{
				ID: model.Id, Object: "model",
				Created: grant.CreatedAt.Time.Unix(), OwnedBy: model.Provider,
				SupportedEndpoints: inference.DelegatedProviderEndpoints(provider.Spec.Kind),
				StreamingOnly:      provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex,
			})
		}
		apiutil.WriteJSON(w, http.StatusOK, models)
		return
	}
	if mcpRequest {
		err := s.checkDelegation(r.Context(), grant, gatewayapi.DelegationCatalog{Mcp: selection.Mcp})
		if err != nil {
			deny(err, false)
			return
		}
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

	initializingMCP := false
	targetURL := s.cfg.DelegationGatewayURL
	path := "/delegations/" + claims.GrantID + "/mcp"
	if !mcpRequest {
		responses := strings.HasSuffix(r.URL.Path, "/responses")
		model, err := inference.ValidateDelegatedRequest(body, responses)
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
		selected := selection.Models[index]
		err = s.checkDelegation(r.Context(), grant, gatewayapi.DelegationCatalog{Models: []gatewayapi.DelegationModel{selected}})
		if err != nil {
			deny(err, false)
			return
		}
		provider := &agentzv1alpha1.InferenceProvider{}
		err = s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Provider}, provider)
		if err != nil {
			deny(err, false)
			return
		}
		err = inference.ValidateDelegatedProviderRequest(provider.Spec.Kind, body, responses)
		if err != nil {
			s.delegationError(w, r, http.StatusBadRequest, "invalid_request_error", err.Error())
			return
		}
		name := fmt.Sprintf("d-%s-model-%d", grant.ID, index)
		err = s.delegationReady(r.Context(), grant, selected.Namespace, inference.GatewayName, name)
		if err != nil {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated inference route is not ready.")
			return
		}
		err = s.delegationReady(r.Context(), grant, s.cfg.DelegationNamespace, "delegations", name)
		if err != nil {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated inference route is not ready.")
			return
		}
		path = fmt.Sprintf("/delegations/%s/models/%d%s", claims.GrantID, index, strings.TrimPrefix(r.URL.Path, resourcePath))
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
			initializingMCP = message.Method == "initialize"
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
		if len(selection.Mcp) == 0 {
			emptyDelegationMCP.ServeHTTP(w, r)
			return
		}
		if session := r.Header.Get("Mcp-Session-Id"); session != "" {
			valid, err := s.queries.GatewayCheckDelegationMCPSession(r.Context(), gatewaydb.GatewayCheckDelegationMCPSessionParams{
				ID: session, GrantID: grant.ID,
			})
			if err != nil {
				deny(err, true)
				return
			}
			if !valid {
				s.delegationError(w, r, http.StatusNotFound, "invalid_session", "The MCP session does not belong to this authorization.")
				return
			}
		}
		for index, selected := range selection.Mcp {
			name := fmt.Sprintf("d-%s-mcp-%d", grant.ID, index)
			err := s.delegationReady(r.Context(), grant, selected.Namespace, mcp.GatewayName, name, name+"-auth")
			if err != nil {
				s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated MCP route is not ready.")
				return
			}
		}
		err := s.delegationReady(r.Context(), grant, s.cfg.DelegationNamespace, "delegations", "d-"+grant.ID+"-mcp")
		if err != nil {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "The delegated MCP route is not ready.")
			return
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
			for header := range response.Header {
				if strings.HasPrefix(strings.ToLower(header), "access-control-") {
					delete(response.Header, header)
				}
			}
			response.Header.Del("Set-Cookie")
			// Intermediary compression must not buffer streamed inference or MCP events.
			response.Header.Set("Cache-Control", "no-store, no-transform")
			if response.StatusCode >= http.StatusMultipleChoices {
				if err := response.Body.Close(); err != nil {
					return err
				}
				// Providers may include their API key or account details in errors.
				// Preserve the HTTP status while keeping credential-bearing diagnostics private.
				// Resource clients must not follow upstream redirects with their bearer.
				if response.StatusCode < http.StatusBadRequest {
					response.StatusCode = http.StatusBadGateway
				}
				response.Header = http.Header{"Cache-Control": {"no-store, no-transform"}}
				response.Trailer = nil
				body, err := json.Marshal(openAIError{Error: openAIErrorDetail{
					Message: "The upstream service could not complete this request.",
					Type:    "server_error", Code: "upstream_error",
				}})
				if err != nil {
					return err
				}
				response.Body = io.NopCloser(bytes.NewReader(body))
				response.ContentLength = int64(len(body))
				response.Header.Set("Content-Type", "application/json")
				return nil
			}
			if !mcpRequest {
				return nil
			}
			if r.Method == http.MethodDelete {
				response.Header.Del("Mcp-Session-Id")
				return s.queries.GatewayDeleteDelegationMCPSession(ctx, gatewaydb.GatewayDeleteDelegationMCPSessionParams{
					ID: r.Header.Get("Mcp-Session-Id"), GrantID: grant.ID,
				})
			}
			if !initializingMCP {
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
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.ErrorContext(r.Context(), "proxy delegated request", slog.String("grant", grant.ID), slog.String("target", target.Host), slog.Any("error", err))
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
		w.Header().Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.Header().Add("Vary", "Access-Control-Request-Method, Access-Control-Request-Headers")
		}
		select {
		case s.delegationRequests <- struct{}{}:
			defer func() { <-s.delegationRequests }()
		default:
			w.Header().Set("Retry-After", "1")
			s.delegationError(w, r, http.StatusTooManyRequests, "rate_limit_exceeded", "The gateway is busy. Retry shortly.")
			return
		}
		origins, present := r.Header["Origin"]
		if !present {
			next.ServeHTTP(w, r)
			return
		}
		if len(origins) != 1 || origins[0] == "" {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "An exact application origin is required.")
			return
		}
		origin := origins[0]
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		allowed, err := s.queries.GatewayCheckDelegationOrigin(ctx, origin)
		cancel()
		if err != nil {
			s.delegationError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Application registration is unavailable.")
			return
		}
		if !allowed {
			s.delegationError(w, r, http.StatusForbidden, "access_denied", "This application origin is not registered.")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate, Retry-After, X-Request-Id")
		if r.Method == http.MethodOptions {
			methods := []string{http.MethodPost}
			switch r.URL.Path {
			case "/api/mcp":
				methods = []string{http.MethodGet, http.MethodPost, http.MethodDelete}
			case "/api/inference/v1/models":
				methods = []string{http.MethodGet}
			case "/api/inference/v1/chat/completions", "/api/inference/v1/responses":
			default:
				methods = nil
			}
			if !slices.Contains(methods, r.Header.Get("Access-Control-Request-Method")) {
				s.delegationError(w, r, http.StatusForbidden, "access_denied", "Unsupported CORS method.")
				return
			}
			headers := []string{"Authorization"}
			for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				header = strings.TrimSpace(header)
				if header == "" && r.Header.Get("Access-Control-Request-Headers") == "" {
					break
				}
				if !httpguts.ValidHeaderFieldName(header) {
					s.delegationError(w, r, http.StatusForbidden, "access_denied", "Invalid CORS header name.")
					return
				}
				if !strings.EqualFold(header, "Authorization") {
					headers = append(headers, header)
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", strings.Join(methods, ", ")+", OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", strings.Join(headers, ", "))
			w.Header().Set("Access-Control-Max-Age", "300")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
