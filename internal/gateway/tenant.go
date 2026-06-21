package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	jwtrequest "github.com/golang-jwt/jwt/v5/request"
	authenticationv1 "k8s.io/api/authentication/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/clawarmor/internal/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const internalTenantNamespaceHeader = "X-ClawArmor-Tenant-Namespace"

type authContextKey struct{}

type tenantContextKey struct{}

type requestAuth struct {
	claims          *gatewayClaims
	tenantNamespace string
}

type tenantRequest struct {
	tenant *clawarmorv1alpha1.Tenant
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

	tenantName := clawarmorv1alpha1.TenantName(auth.claims.TenantID)
	var tenant clawarmorv1alpha1.Tenant
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Name: tenantName}, &tenant)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("get tenant", err))
		return
	}

	writeJSON(w, http.StatusOK, tenantView(&tenant))
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

	tenantName := clawarmorv1alpha1.TenantName(auth.claims.TenantID)
	tenant := clawarmorv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{
			Name: tenantName,
		},
		Spec: clawarmorv1alpha1.TenantSpec{
			OrganizationID: auth.claims.TenantID,
			UserID:         auth.claims.UserID,
		},
	}
	err := s.k8sClient.Create(r.Context(), &tenant)
	if err != nil && !apierrors.IsAlreadyExists(err) {
		writeError(w, r, mapKubeHTTPError("create tenant", err))
		return
	}
	if apierrors.IsAlreadyExists(err) {
		err = s.k8sClient.Get(
			r.Context(),
			ctrlclient.ObjectKey{Name: tenantName},
			&tenant,
		)
		if err != nil {
			writeError(w, r, mapKubeHTTPError("get tenant", err))
			return
		}
	}

	if tenant.Spec.OrganizationID != auth.claims.TenantID ||
		tenant.Spec.UserID != auth.claims.UserID {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"tenant identity conflicts with current state",
			errors.New("tenant identity conflict"),
		))
		return
	}

	writeJSON(w, http.StatusOK, tenantView(&tenant))
}

func tenantView(tenant *clawarmorv1alpha1.Tenant) gatewayapi.Tenant {
	conditions := make([]gatewayapi.TenantCondition, 0, len(tenant.Status.Conditions))
	var ready, degraded bool
	for _, cond := range tenant.Status.Conditions {
		conditions = append(conditions, gatewayapi.TenantCondition{
			Message: cond.Message,
			Reason:  cond.Reason,
			Status:  gatewayapi.TenantConditionStatus(cond.Status),
			Type:    cond.Type,
		})
		if cond.Type == clawarmorv1alpha1.TenantConditionReady &&
			cond.Status == metav1.ConditionTrue {
			ready = true
		}
		if cond.Type == clawarmorv1alpha1.TenantConditionDegraded &&
			cond.Status == metav1.ConditionTrue {
			degraded = true
		}
	}

	phase := gatewayapi.BOOTSTRAPPING
	if ready {
		phase = gatewayapi.READY
	} else if degraded {
		phase = gatewayapi.FAILED
	}

	return gatewayapi.Tenant{
		Conditions: conditions,
		Namespace:  tenant.Status.Namespace,
		Phase:      phase,
		Ready:      ready,
		TenantId:   tenant.Spec.OrganizationID,
		UserId:     tenant.Spec.UserID,
	}
}

func requireGatewayAuth(k8s kubernetes.Interface) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			auth, err := resolveRequestAuth(r, k8s)
			if err != nil {
				writeError(w, r, newAPIError(
					http.StatusUnauthorized,
					"unauthorized",
					"missing or invalid bearer token",
					err,
				))
				return
			}

			ctx := context.WithValue(r.Context(), authContextKey{}, auth)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func requireTenantRequest(s *Service) func(http.Handler) http.Handler {
	auth := requireGatewayAuth(s.k8s)
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
					cleanupNamespace = clawarmorv1alpha1.TenantName(
						auth.claims.TenantID,
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

	list := &clawarmorv1alpha1.AgentList{}
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

func resolveRequestAuth(r *http.Request, k8s kubernetes.Interface) (requestAuth, error) {
	tenantNamespace := strings.TrimSpace(
		r.Header.Get(internalTenantNamespaceHeader),
	)
	if tenantNamespace != "" {
		if err := validateInternalBearer(r, k8s); err != nil {
			return requestAuth{}, err
		}
		return requestAuth{tenantNamespace: tenantNamespace}, nil
	}

	claims, err := parseGatewayClaims(r)
	if err != nil {
		return requestAuth{}, err
	}
	return requestAuth{claims: &claims}, nil
}

func parseGatewayClaims(r *http.Request) (gatewayClaims, error) {
	token, err := extractBearerToken(r)
	if err != nil {
		return gatewayClaims{}, err
	}

	parser := jwt.NewParser()
	claims := gatewayClaims{}
	if _, _, err := parser.ParseUnverified(token, &claims); err != nil {
		return gatewayClaims{}, fmt.Errorf("parse jwt claims: %w", err)
	}
	if strings.TrimSpace(claims.TenantID) == "" {
		return gatewayClaims{}, fmt.Errorf("missing tenant_id claim")
	}
	if strings.TrimSpace(claims.UserID) == "" {
		return gatewayClaims{}, fmt.Errorf("missing user_id claim")
	}
	return claims, nil
}

func extractBearerToken(r *http.Request) (string, error) {
	token, err := jwtrequest.BearerExtractor{}.ExtractToken(r)
	if err != nil {
		return "", fmt.Errorf("missing bearer token")
	}
	return token, nil
}

func validateInternalBearer(r *http.Request, k8s kubernetes.Interface) error {
	token, err := extractBearerToken(r)
	if err != nil {
		return err
	}

	review, err := k8s.AuthenticationV1().TokenReviews().Create(
		r.Context(),
		&authenticationv1.TokenReview{
			Spec: authenticationv1.TokenReviewSpec{Token: token},
		},
		metav1.CreateOptions{},
	)
	if err != nil {
		return fmt.Errorf("review internal bearer token: %w", err)
	}
	if !review.Status.Authenticated {
		return fmt.Errorf("internal bearer token is not authenticated")
	}
	if !strings.HasPrefix(review.Status.User.Username, "system:serviceaccount:") {
		return fmt.Errorf("internal bearer token is not a service account token")
	}
	return nil
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
	req, ok := tenantState(ctx)
	if !ok || req.tenant == nil {
		return "", fmt.Errorf("missing tenant context")
	}
	if strings.TrimSpace(req.tenant.Status.Namespace) == "" {
		return "", fmt.Errorf("tenant namespace is empty")
	}
	return req.tenant.Status.Namespace, nil
}

func tenantObject(ctx context.Context) (*clawarmorv1alpha1.Tenant, error) {
	req, ok := tenantState(ctx)
	if !ok || req.tenant == nil {
		return nil, fmt.Errorf("missing tenant context")
	}
	return req.tenant, nil
}

func tenantRoute(r *http.Request) bool {
	return r.URL.Path == "/api/tenant"
}

func tenantReady(tenant *clawarmorv1alpha1.Tenant) bool {
	if tenant == nil {
		return false
	}
	for _, cond := range tenant.Status.Conditions {
		if cond.Type != clawarmorv1alpha1.TenantConditionReady {
			continue
		}
		return cond.Status == metav1.ConditionTrue
	}
	return false
}

func (s *Service) findTenant(ctx context.Context, auth requestAuth) (*clawarmorv1alpha1.Tenant, error) {
	if auth.claims != nil {
		tenant := &clawarmorv1alpha1.Tenant{}
		name := clawarmorv1alpha1.TenantName(auth.claims.TenantID)
		err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name}, tenant)
		if err != nil {
			return nil, err
		}
		return tenant, nil
	}

	list := &clawarmorv1alpha1.TenantList{}
	if err := s.k8sClient.List(ctx, list); err != nil {
		return nil, fmt.Errorf("list tenants: %w", err)
	}
	for i := range list.Items {
		tenant := &list.Items[i]
		if tenant.Status.Namespace == auth.tenantNamespace {
			return tenant, nil
		}
	}
	return nil, apierrors.NewNotFound(
		clawarmorv1alpha1.Resource("tenant"),
		auth.tenantNamespace,
	)
}
