package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	jwtrequest "github.com/golang-jwt/jwt/v5/request"
	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const internalTenantNamespaceHeader = "X-AgentZ-Tenant-Namespace"

type authContextKey struct{}

type tenantContextKey struct{}

type requestAuth struct {
	claims          *gatewayClaims
	apiKeyID        string
	organizationID  string
	workspaceID     string
	tenantName      string
	tenantNamespace string
}

type tenantRequest struct {
	tenant *agentzv1alpha1.Tenant
}

// GetTenant handles GET /api/tenant.
func (s *Service) GetTenant(w http.ResponseWriter, r *http.Request) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims == nil {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		))
		return
	}

	tenant, err := s.findTenant(r.Context(), auth)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("get tenant", err))
		return
	}

	view, err := s.tenantView(r.Context(), *auth.claims, tenant)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// EnsureTenant handles PUT /api/tenant.
func (s *Service) EnsureTenant(w http.ResponseWriter, r *http.Request) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims == nil {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		))
		return
	}

	tenant, err := s.findTenant(r.Context(), auth)
	if err == nil {
		view, err := s.tenantView(r.Context(), *auth.claims, tenant)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
		return
	}
	if !apierrors.IsNotFound(err) {
		writeError(w, r, mapKubeHTTPError("get tenant", err))
		return
	}

	tenantName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		auth.claims.OrganizationID,
	)
	created := agentzv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{
			Name: tenantName,
			Labels: map[string]string{
				agentzv1alpha1.TenantOrganizationIDLabel: tenantName,
			},
		},
		Spec: agentzv1alpha1.TenantSpec{
			OrganizationID: auth.claims.OrganizationID,
		},
	}
	err = s.k8sClient.Create(r.Context(), &created)
	if err != nil && !apierrors.IsAlreadyExists(err) {
		writeError(w, r, mapKubeHTTPError("create tenant", err))
		return
	}
	if apierrors.IsAlreadyExists(err) {
		err = s.k8sClient.Get(
			r.Context(),
			ctrlclient.ObjectKey{Name: tenantName},
			&created,
		)
		if err != nil {
			writeError(w, r, mapKubeHTTPError("get tenant", err))
			return
		}
	}

	if created.Spec.OrganizationID != auth.claims.OrganizationID {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"tenant identity conflicts with current state",
			errors.New("tenant identity conflict"),
		))
		return
	}

	view, err := s.tenantView(r.Context(), *auth.claims, &created)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Service) tenantView(ctx context.Context, claims gatewayClaims, tenant *agentzv1alpha1.Tenant) (gatewayapi.Tenant, error) {
	conditions := make([]gatewayapi.TenantCondition, 0, len(tenant.Status.Conditions))
	var ready, degraded bool
	for _, cond := range tenant.Status.Conditions {
		conditions = append(conditions, gatewayapi.TenantCondition{
			Message: cond.Message,
			Reason:  cond.Reason,
			Status:  gatewayapi.TenantConditionStatus(cond.Status),
			Type:    cond.Type,
		})
		if cond.Type == agentzv1alpha1.TenantConditionReady && cond.Status == metav1.ConditionTrue {
			ready = true
		}
		if cond.Type == agentzv1alpha1.TenantConditionDegraded && cond.Status == metav1.ConditionTrue {
			degraded = true
		}
	}

	phase := gatewayapi.BOOTSTRAPPING
	if ready {
		phase = gatewayapi.READY
	}
	if !ready && degraded {
		phase = gatewayapi.FAILED
	}

	capabilities, err := s.resolveResourceCapabilities(ctx, claims, "")
	if err != nil {
		return gatewayapi.Tenant{}, err
	}
	return gatewayapi.Tenant{
		Conditions:                    conditions,
		SkillCapabilities:             capabilities.skill,
		McpConnectionCapabilities:     capabilities.mcp,
		SandboxCapabilities:           capabilities.sandbox,
		InferenceProviderCapabilities: capabilities.inferenceProvider,
		InferencePoolCapabilities:     capabilities.inferencePool,
		Namespace:                     tenant.Status.Namespace,
		Phase:                         phase,
		Ready:                         ready,
		OrganizationId:                tenant.Spec.OrganizationID,
	}, nil
}

func requireGatewayAuth(s *Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			auth, err := s.resolveRequestAuth(r)
			if err != nil {
				apiErr, ok := err.(*apiError)
				if !ok {
					apiErr = newAPIError(
						http.StatusUnauthorized,
						"unauthorized",
						"missing or invalid bearer token",
						err,
					)
				}
				writeError(w, r, apiErr)
				return
			}

			ctx := context.WithValue(r.Context(), authContextKey{}, auth)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func requireExplicitCapability(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer, bearerMapped := r.Context().Value(gatewayapi.GatewayBearerScopes).([]string)
		apiKey, apiKeyMapped := r.Context().Value(gatewayapi.GatewayAPIKeyScopes).([]string)
		bearerValid := bearerMapped && len(bearer) == 1 && bearer[0] != ""
		apiKeyValid := apiKeyMapped && len(apiKey) == 1 && apiKey[0] != ""
		if bearerValid != apiKeyValid {
			next.ServeHTTP(w, r)
			return
		}

		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"operation has no unambiguous capability mapping",
			fmt.Errorf("generated operation capability mapping is missing or ambiguous"),
		))
	})
}

func requireTenantRequest(s *Service) func(http.Handler) http.Handler {
	auth := requireGatewayAuth(s)
	tenant := loadTenant(s)
	return func(next http.Handler) http.Handler {
		return auth(tenant(requireTenantReady(s, next)))
	}
}

func loadTenant(s *Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth, ok := requestAuthState(r.Context())
			if !ok {
				writeError(w, r, newAPIError(
					http.StatusUnauthorized,
					"unauthorized",
					"missing request auth",
					fmt.Errorf("missing request auth"),
				))
				return
			}

			tenant, err := s.findTenant(r.Context(), auth)
			switch {
			case err == nil:
				ctx := context.WithValue(
					r.Context(),
					tenantContextKey{},
					tenantRequest{tenant: tenant},
				)
				next.ServeHTTP(w, r.WithContext(ctx))
			case apierrors.IsNotFound(err):
				cleanupNamespace := auth.tenantNamespace
				if cleanupNamespace == "" && auth.claims != nil {
					cleanupNamespace = agentzv1alpha1.ScopeNamespace(
						agentzv1alpha1.ResourceScopeOrganisation,
						auth.claims.OrganizationID,
					)
				}
				if cleanupNamespace != "" {
					cleanupErr := s.syncTenantAgentRows(
						r.Context(),
						cleanupNamespace,
					)
					if cleanupErr != nil {
						writeInternalError(w, r, cleanupErr)
						return
					}
				}
				if tenantRoute(r) {
					next.ServeHTTP(w, r)
					return
				}
				writeError(w, r, newAPIError(
					http.StatusNotFound,
					"tenant_not_found",
					"tenant is not initialized",
					err,
				))
			default:
				if apiErr, ok := errors.AsType[*apiError](err); ok {
					writeError(w, r, apiErr)
					return
				}
				writeInternalError(w, r, err)
			}
		})
	}
}

func requireTenantReady(s *Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions || tenantRoute(r) {
			next.ServeHTTP(w, r)
			return
		}

		req, ok := tenantState(r.Context())
		if !ok || req.tenant == nil {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"tenant_not_found",
				"tenant is not initialized",
				fmt.Errorf("missing tenant context"),
			))
			return
		}

		if tenantReady(req.tenant) {
			err := s.syncTenantAgentRows(r.Context(), req.tenant.Status.Namespace)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		writeError(w, r, newAPIError(
			http.StatusConflict,
			"tenant_not_ready",
			"tenant is not ready",
			fmt.Errorf("tenant %q is not ready", req.tenant.Name),
		))
	})
}

func (s *Service) syncTenantAgentRows(ctx context.Context, namespace string) error {
	if s == nil || s.queries == nil || s.k8sClient == nil {
		return nil
	}
	if strings.TrimSpace(namespace) == "" {
		return nil
	}

	list := &agentzv1alpha1.AgentList{}
	err := s.k8sClient.List(ctx, list, ctrlclient.InNamespace(namespace))
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("list tenant agents: %w", err)
	}

	live := make(map[string]struct{}, len(list.Items))
	for i := range list.Items {
		live[list.Items[i].Name] = struct{}{}
	}

	rows, err := s.queries.GatewayListAgents(
		ctx,
		gatewaydb.GatewayListAgentsParams{
			TenantNamespace: namespace,
			Limit:           1 << 30,
			Offset:          0,
		},
	)
	if err != nil {
		return fmt.Errorf("list tenant agent rows: %w", err)
	}

	for i := range rows {
		if _, ok := live[rows[i].AgentName]; ok {
			continue
		}
		_, err := s.queries.GatewayDeleteAgent(
			ctx,
			gatewaydb.GatewayDeleteAgentParams{
				TenantNamespace: namespace,
				AgentName:       rows[i].AgentName,
			},
		)
		if err != nil {
			return fmt.Errorf(
				"delete stale agent row %q: %w",
				rows[i].AgentName,
				err,
			)
		}
	}

	return nil
}

func (s *Service) resolveRequestAuth(r *http.Request) (requestAuth, error) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "basic ") {
		return s.resolveOpenCodeAPIKeyAuth(r)
	}
	if _, ok := r.Context().Value(gatewayapi.GatewayAPIKeyScopes).([]string); ok {
		return s.resolveWebhookAPIKeyAuth(r)
	}

	token, err := jwtrequest.BearerExtractor{}.ExtractToken(r)
	if err != nil {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid bearer token",
			fmt.Errorf("missing bearer token"),
		)
	}

	tenantNamespace := strings.TrimSpace(r.Header.Get(internalTenantNamespaceHeader))
	if tenantNamespace != "" {
		return s.resolveTenantRequestAuth(r.Context(), token, tenantNamespace)
	}

	claims, err := s.parseGatewayClaims(token)
	if err == nil {
		return requestAuth{claims: &claims}, nil
	}

	auth, reviewErr := s.resolveAgentRequestAuth(r, token)
	if reviewErr == nil {
		return auth, nil
	}
	if apiErr, ok := reviewErr.(*apiError); ok {
		return requestAuth{}, apiErr
	}

	return requestAuth{}, newAPIError(
		http.StatusUnauthorized,
		"unauthorized",
		"missing or invalid bearer token",
		err,
	)
}

func (s *Service) parseGatewayClaims(token string) (gatewayClaims, error) {
	claims := gatewayClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}),
		jwt.WithIssuer(s.cfg.ExternalJWTIssuer),
		jwt.WithAudience(s.cfg.ExternalJWTAudience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
	)

	_, err := parser.ParseWithClaims(token, &claims, s.externalJWTKeyfunc)
	if err != nil {
		return gatewayClaims{}, fmt.Errorf("verify external bearer: %w", err)
	}
	if strings.TrimSpace(claims.OrganizationID) == "" {
		return gatewayClaims{}, fmt.Errorf("missing organization_id claim")
	}
	if strings.TrimSpace(claims.UserID) == "" {
		return gatewayClaims{}, fmt.Errorf("missing user_id claim")
	}
	if strings.TrimSpace(claims.ScopeID) == "" {
		return gatewayClaims{}, fmt.Errorf("missing scope_id claim")
	}
	if claims.Capabilities == nil {
		return gatewayClaims{}, fmt.Errorf("missing capabilities claim")
	}
	if claims.AdministrativeBypass == nil {
		return gatewayClaims{}, fmt.Errorf("missing administrative_bypass claim")
	}
	if claims.AgentACL == nil {
		return gatewayClaims{}, fmt.Errorf("missing agent_acl claim")
	}

	switch claims.ScopeType {
	case gatewayScopeOrganization:
		if claims.ScopeID != claims.OrganizationID {
			return gatewayClaims{}, fmt.Errorf("organization scope does not match organization_id")
		}
		if len(*claims.AgentACL) != 0 {
			return gatewayClaims{}, fmt.Errorf("organization scope cannot contain an Agent ACL")
		}
	case gatewayScopeWorkspace:
		claims.WorkspaceID = claims.ScopeID
	default:
		return gatewayClaims{}, fmt.Errorf("invalid scope_type claim")
	}
	return claims, nil
}

func (s *Service) resolveTenantRequestAuth(ctx context.Context, token, tenantNamespace string) (requestAuth, error) {
	review, err := s.reviewServiceAccountToken(ctx, token)
	if err != nil {
		return requestAuth{}, err
	}

	tenant, err := s.findTenantByNamespace(ctx, tenantNamespace)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return requestAuth{}, newAPIError(
				http.StatusNotFound,
				"tenant_not_found",
				"tenant is not initialized",
				err,
			)
		}
		return requestAuth{}, err
	}

	err = s.authorizeServiceAccount(
		ctx,
		review.Status.User,
		authorizationv1.ResourceAttributes{
			Verb:     "use",
			Group:    agentzv1alpha1.SchemeGroupVersion.Group,
			Resource: "tenants",
			Name:     tenant.Name,
		},
		"tenant",
	)
	if err != nil {
		return requestAuth{}, err
	}

	return requestAuth{
		tenantName:      tenant.Name,
		tenantNamespace: tenant.Status.Namespace,
	}, nil
}

func (s *Service) resolveAgentRequestAuth(r *http.Request, token string) (requestAuth, error) {
	review, err := s.reviewServiceAccountToken(r.Context(), token)
	if err != nil {
		return requestAuth{}, err
	}

	agentName, verb, ok := workflowAgentAccess(r)
	if !ok {
		return requestAuth{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"internal caller is not authorized for route",
			fmt.Errorf("internal caller is not authorized for route %s %s", r.Method, r.URL.Path),
		)
	}

	user, err := serviceAccountUser(review.Status.User.Username)
	if err != nil {
		return requestAuth{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid bearer token",
			err,
		)
	}
	if user.name != agentName {
		return requestAuth{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"internal caller is not authorized for agent",
			fmt.Errorf("serviceaccount %q cannot access agent %q", user.name, agentName),
		)
	}

	agt := &agentzv1alpha1.Agent{}
	err = s.k8sClient.Get(
		r.Context(),
		ctrlclient.ObjectKey{
			Name:      agentName,
			Namespace: user.namespace,
		},
		agt,
	)
	if err != nil {
		return requestAuth{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"internal caller is not authorized for agent",
			err,
		)
	}

	err = s.authorizeServiceAccount(
		r.Context(),
		review.Status.User,
		authorizationv1.ResourceAttributes{
			Verb:      verb,
			Group:     agentzv1alpha1.SchemeGroupVersion.Group,
			Resource:  "agents",
			Namespace: agt.Namespace,
			Name:      agt.Name,
		},
		"agent",
	)
	if err != nil {
		return requestAuth{}, err
	}

	return requestAuth{
		tenantNamespace: agt.Namespace,
	}, nil
}

func (s *Service) reviewServiceAccountToken(ctx context.Context, token string) (*authenticationv1.TokenReview, error) {
	review, err := s.k8s.AuthenticationV1().TokenReviews().Create(
		ctx,
		&authenticationv1.TokenReview{
			Spec: authenticationv1.TokenReviewSpec{
				Token:     token,
				Audiences: []string{s.cfg.InternalK8sTokenAudience},
			},
		},
		metav1.CreateOptions{},
	)
	if err != nil {
		return nil, fmt.Errorf("review internal bearer token: %w", err)
	}
	if !review.Status.Authenticated {
		return nil, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid bearer token",
			fmt.Errorf("internal bearer token is not authenticated"),
		)
	}
	if !slices.Contains(review.Status.Audiences, s.cfg.InternalK8sTokenAudience) {
		return nil, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid bearer token",
			fmt.Errorf("internal bearer token audience mismatch"),
		)
	}
	_, err = serviceAccountUser(review.Status.User.Username)
	if err != nil {
		return nil, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid bearer token",
			err,
		)
	}
	return review, nil
}

func (s *Service) authorizeServiceAccount(ctx context.Context, user authenticationv1.UserInfo, resource authorizationv1.ResourceAttributes, kind string) error {
	sar, err := s.k8s.AuthorizationV1().SubjectAccessReviews().Create(
		ctx,
		&authorizationv1.SubjectAccessReview{
			Spec: authorizationv1.SubjectAccessReviewSpec{
				User:               user.Username,
				UID:                user.UID,
				Groups:             user.Groups,
				ResourceAttributes: &resource,
			},
		},
		metav1.CreateOptions{},
	)
	if err != nil {
		return fmt.Errorf("authorize internal bearer: %w", err)
	}
	if !sar.Status.Allowed {
		return newAPIError(
			http.StatusForbidden,
			"forbidden",
			"internal caller is not authorized",
			fmt.Errorf(
				"internal caller is not authorized for %s %q: %s %s",
				kind,
				resource.Name,
				sar.Status.Reason,
				sar.Status.EvaluationError,
			),
		)
	}
	return nil
}

type serviceAccountName struct {
	namespace string
	name      string
}

func serviceAccountUser(username string) (serviceAccountName, error) {
	const prefix = "system:serviceaccount:"

	rest, ok := strings.CutPrefix(username, prefix)
	if !ok {
		return serviceAccountName{}, fmt.Errorf("internal bearer token is not a service account token")
	}

	namespace, name, ok := strings.Cut(rest, ":")
	if !ok || strings.TrimSpace(namespace) == "" || strings.TrimSpace(name) == "" {
		return serviceAccountName{}, fmt.Errorf("internal bearer token is not a service account token")
	}

	return serviceAccountName{
		namespace: namespace,
		name:      name,
	}, nil
}

func workflowAgentAccess(r *http.Request) (string, string, bool) {
	agentName := strings.TrimSpace(chi.URLParam(r, "agentName"))
	if agentName == "" {
		return "", "", false
	}

	switch chi.RouteContext(r.Context()).RoutePattern() {
	case "/api/workflow/{agentName}":
		return workflowAgentAccessRoot(agentName, r.Method)
	case "/api/workflow/{agentName}/schedule":
		if r.Method == http.MethodGet {
			return agentName, "list-workflow-schedules", true
		}
	case "/api/workflow/{agentName}/{workflowName}":
		if r.Method == http.MethodGet {
			return agentName, "get-workflow", true
		}
	case "/api/workflow/{agentName}/{workflowName}/schedule":
		return workflowAgentAccessSchedule(agentName, r.Method)
	case "/api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}":
		return workflowAgentAccessScheduleItem(agentName, r.Method)
	case "/api/workflow/{agentName}/{workflowName}/run/{runName}/status":
		if r.Method == http.MethodPatch {
			return agentName, "set-workflowrun-status", true
		}
	case "/api/workflow/{agentName}/{workflowName}/run/{runName}/nodes/{nodeName}/status":
		if r.Method == http.MethodPatch {
			return agentName, "set-workflowrun-status", true
		}
	}

	return "", "", false
}

func workflowAgentAccessRoot(agentName string, method string) (string, string, bool) {
	switch method {
	case http.MethodGet:
		return agentName, "list-workflows", true
	case http.MethodPost:
		return agentName, "create-workflow", true
	case http.MethodDelete:
		return agentName, "delete-workflows", true
	default:
		return "", "", false
	}
}

func workflowAgentAccessSchedule(agentName string, method string) (string, string, bool) {
	switch method {
	case http.MethodGet:
		return agentName, "list-workflow-schedules", true
	case http.MethodPost:
		return agentName, "create-workflow-schedule", true
	default:
		return "", "", false
	}
}

func workflowAgentAccessScheduleItem(agentName string, method string) (string, string, bool) {
	switch method {
	case http.MethodDelete:
		return agentName, "delete-workflow-schedule", true
	case http.MethodPut:
		return agentName, "update-workflow-schedule", true
	default:
		return "", "", false
	}
}

func requestAuthState(ctx context.Context) (requestAuth, bool) {
	auth, ok := ctx.Value(authContextKey{}).(requestAuth)
	return auth, ok
}

func tenantState(ctx context.Context) (tenantRequest, bool) {
	req, ok := ctx.Value(tenantContextKey{}).(tenantRequest)
	return req, ok
}

func tenantNamespace(ctx context.Context) (string, error) {
	auth, ok := requestAuthState(ctx)
	if ok && strings.TrimSpace(auth.tenantNamespace) != "" {
		return auth.tenantNamespace, nil
	}

	req, ok := tenantState(ctx)
	if !ok || req.tenant == nil {
		return "", fmt.Errorf("missing tenant context")
	}
	if strings.TrimSpace(req.tenant.Status.Namespace) == "" {
		return "", fmt.Errorf("tenant namespace is empty")
	}
	return req.tenant.Status.Namespace, nil
}

func tenantObject(ctx context.Context) (*agentzv1alpha1.Tenant, error) {
	req, ok := tenantState(ctx)
	if !ok || req.tenant == nil {
		return nil, fmt.Errorf("missing tenant context")
	}
	return req.tenant, nil
}

func tenantRoute(r *http.Request) bool {
	return chi.RouteContext(r.Context()).RoutePattern() == "/api/tenant"
}

func tenantReady(tenant *agentzv1alpha1.Tenant) bool {
	if tenant == nil {
		return false
	}
	for _, cond := range tenant.Status.Conditions {
		if cond.Type != agentzv1alpha1.TenantConditionReady {
			continue
		}
		return cond.Status == metav1.ConditionTrue
	}
	return false
}

func (s *Service) findTenant(ctx context.Context, auth requestAuth) (*agentzv1alpha1.Tenant, error) {
	organizationID := auth.organizationID
	if auth.claims != nil {
		organizationID = auth.claims.OrganizationID
	}
	if organizationID != "" {
		list := &agentzv1alpha1.TenantList{}
		selector := ctrlclient.MatchingLabels{
			agentzv1alpha1.TenantOrganizationIDLabel: agentzv1alpha1.ScopeNamespace(
				agentzv1alpha1.ResourceScopeOrganisation,
				organizationID,
			),
		}
		if err := s.k8sClient.List(ctx, list, selector); err != nil {
			return nil, fmt.Errorf("list tenants: %w", err)
		}
		var match *agentzv1alpha1.Tenant
		for i := range list.Items {
			tenant := &list.Items[i]
			if tenant.Spec.OrganizationID != organizationID {
				continue
			}
			if match != nil {
				return nil, newAPIError(
					http.StatusConflict,
					"conflict",
					"multiple tenants represent the current Organisation",
					fmt.Errorf("duplicate tenant identity"),
				)
			}
			match = tenant
		}
		if match != nil {
			return match, nil
		}
		return nil, apierrors.NewNotFound(
			agentzv1alpha1.Resource("tenant"),
			organizationID,
		)
	}

	if auth.tenantName != "" {
		tenant := &agentzv1alpha1.Tenant{}
		err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: auth.tenantName}, tenant)
		if err != nil {
			return nil, err
		}
		return tenant, nil
	}

	return s.findTenantByNamespace(ctx, auth.tenantNamespace)
}

func (s *Service) findTenantByNamespace(ctx context.Context, tenantNamespace string) (*agentzv1alpha1.Tenant, error) {
	tenant := &agentzv1alpha1.Tenant{}
	err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: tenantNamespace}, tenant)
	if err != nil {
		return nil, err
	}
	if tenant.Status.Namespace != tenantNamespace {
		return nil, apierrors.NewNotFound(
			agentzv1alpha1.Resource("tenant"),
			tenantNamespace,
		)
	}
	return tenant, nil
}
