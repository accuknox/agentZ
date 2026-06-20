package gateway

import (
	"errors"
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// GetTenant handles GET /api/tenant.
func (s *Service) GetTenant(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(r.Context())
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		))
		return
	}

	tenantName := clawarmorv1alpha1.TenantName(claims.TenantID)
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
	claims, ok := requestClaims(r.Context())
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		))
		return
	}

	tenantName := clawarmorv1alpha1.TenantName(claims.TenantID)
	tenant := clawarmorv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{
			Name: tenantName,
		},
		Spec: clawarmorv1alpha1.TenantSpec{
			OrganizationID: claims.TenantID,
			UserID:         claims.UserID,
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

	if tenant.Spec.OrganizationID != claims.TenantID ||
		tenant.Spec.UserID != claims.UserID {
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
