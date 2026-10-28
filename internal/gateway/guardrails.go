package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	baoapi "github.com/openbao/openbao/api/v2"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/guardrails"
	"github.com/accuknox/agentz/internal/scope"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListGuardrailConnections lists scoped and explicitly inherited connections.
func (s *Service) ListGuardrailConnections(w http.ResponseWriter, r *http.Request, _ gatewayapi.ListGuardrailConnectionsParams) {
	s.serveGuardrailConnections(w, r, "")
}

// GetGuardrailConnection reads one owned connection.
func (s *Service) GetGuardrailConnection(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.GetGuardrailConnectionParams) {
	s.serveGuardrailConnections(w, r, name)
}

// CreateGuardrailConnection creates a detector transport.
func (s *Service) CreateGuardrailConnection(w http.ResponseWriter, r *http.Request, _ gatewayapi.CreateGuardrailConnectionParams) {
	s.serveGuardrailConnections(w, r, "")
}

// UpdateGuardrailConnection updates a detector transport without exposing credentials.
func (s *Service) UpdateGuardrailConnection(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.UpdateGuardrailConnectionParams) {
	s.serveGuardrailConnections(w, r, name)
}

// DeleteGuardrailConnection removes an unreferenced connection.
func (s *Service) DeleteGuardrailConnection(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.DeleteGuardrailConnectionParams) {
	s.serveGuardrailConnections(w, r, name)
}

func (s *Service) serveGuardrailConnections(w http.ResponseWriter, r *http.Request, name string) {
	operation := authorization.OperationListGuardrailConnections
	switch r.Method {
	case http.MethodPost:
		operation = authorization.OperationCreateGuardrailConnection
	case http.MethodPut:
		operation = authorization.OperationUpdateGuardrailConnection
	case http.MethodDelete:
		operation = authorization.OperationDeleteGuardrailConnection
	case http.MethodGet:
		if name != "" {
			operation = authorization.OperationGetGuardrailConnection
		}
	}
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Provider",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   operation,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if r.Method == http.MethodGet && name == "" {
		list := &api.GuardrailConnectionList{}
		err := s.k8sClient.List(r.Context(), list, ctrlclient.InNamespace(access.namespace))
		if err != nil {
			apiutil.WriteError(w, r, mapKubeHTTPError("list guardrail providers", err))
			return
		}
		items := make([]gatewayapi.GuardrailConnection, 0, len(list.Items))
		for _, item := range list.Items {
			items = append(items, guardrailConnectionView(item, resourceScope(access.workspaceID), access))
		}
		if access.workspaceID != "" {
			workspace := &api.Workspace{}
			err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Name: access.namespace}, workspace)
			if err != nil {
				apiutil.WriteError(w, r, mapKubeHTTPError("get workspace", err))
				return
			}
			org := api.ScopeNamespace(api.ResourceScopeOrganisation, access.claims.OrganizationID)
			for _, selected := range workspace.Spec.SelectedOrganizationResources.GuardrailConnections {
				item := &api.GuardrailConnection{}
				err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: org, Name: selected}, item)
				if err != nil {
					if apierrors.IsNotFound(err) {
						continue
					}
					apiutil.WriteError(w, r, mapKubeHTTPError("get inherited provider", err))
					return
				}
				items = append(items, guardrailConnectionView(*item, gatewayapi.ResourceScopeOrganisation, access))
			}
		}
		apiutil.WriteJSON(w, http.StatusOK, map[string][]gatewayapi.GuardrailConnection{"items": items})
		return
	}
	item := &api.GuardrailConnection{}
	if r.Method != http.MethodPost {
		err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: name}, item)
		if err != nil {
			apiutil.WriteError(w, r, mapKubeHTTPError("get guardrail provider", err))
			return
		}
	}
	if r.Method == http.MethodGet {
		apiutil.WriteJSON(w, http.StatusOK, guardrailConnectionView(*item, resourceScope(access.workspaceID), access))
		return
	}
	if r.Method == http.MethodDelete {
		conflict, err := s.selectedOrganizationResourceConflict(
			r.Context(),
			access,
			api.OrganizationResourceKindGuardrailConnection,
			item.Name,
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if conflict != nil {
			apiutil.WriteError(w, r, conflict)
			return
		}
		policies := &api.GuardrailPolicyList{}
		if err := s.k8sClient.List(r.Context(), policies); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		for _, policy := range policies.Items {
			for _, check := range policy.Spec.Checks {
				if check.Connection == nil || check.Connection.Name != item.Name {
					continue
				}
				ns, err := scope.Namespace(r.Context(), s.k8sClient, policy.Namespace, check.Connection.Scope)
				if err != nil {
					apiutil.WriteInternalError(w, r, err)
					return
				}
				if ns == item.Namespace {
					apiutil.WriteError(w, r, apiutil.NewError(
						http.StatusConflict, "resource_in_use",
						"provider is referenced by policy "+policy.Name, errors.New("referenced guardrail provider"),
					))
					return
				}
			}
		}
		err = s.k8sClient.Delete(r.Context(), item)
		apiErr = s.recordGuardrailMutation(r.Context(), access, gatewaydb.EventTrailTargetGuardrailConnection, item.Name, err)
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var input gatewayapi.GuardrailConnectionInput
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	if len(validation.IsDNS1123Label(input.Name)) > 0 || (name != "" && input.Name != name) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request",
			"name must be a valid immutable resource name", errBadRequest,
		))
		return
	}
	spec := api.GuardrailConnectionSpec{
		ResourceAudit:      item.Spec.ResourceAudit,
		DisplayName:        input.DisplayName,
		Provider:           api.GuardrailProvider(input.Provider),
		SecretName:         item.Spec.SecretName,
		CredentialRevision: item.Spec.CredentialRevision,
	}
	if input.Description != nil {
		spec.Description = *input.Description
	}
	if input.Endpoint != nil {
		spec.Endpoint = *input.Endpoint
	}
	if input.Region != nil {
		spec.Region = *input.Region
	}
	if err := guardrails.ValidateConnection(spec); err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", err.Error(), err))
		return
	}
	if r.Method == http.MethodPost {
		existing := &api.GuardrailConnection{}
		err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: input.Name}, existing)
		if err == nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "already_exists", "guardrail provider already exists", errBadRequest))
			return
		}
		if !apierrors.IsNotFound(err) {
			apiutil.WriteError(w, r, mapKubeHTTPError("check provider name", err))
			return
		}
	}
	if r.Method == http.MethodPut && spec.Provider != item.Spec.Provider {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "provider service is immutable", errBadRequest))
		return
	}
	credentialPath := ""
	if input.Credentials != nil {
		if s.baoKV == nil {
			apiutil.WriteInternalError(w, r, errors.New("credential store is unavailable"))
			return
		}
		credentials := input.Credentials
		data := map[string]any{}
		switch spec.Provider {
		case "OpenAI", "Webhook":
			var token string
			if credentials.ApiKey != nil {
				token = *credentials.ApiKey
			}
			if credentials.Token != nil {
				token = *credentials.Token
			}
			if strings.TrimSpace(token) == "" {
				apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "a nonempty API key or bearer token is required", errBadRequest))
				return
			}
			data["token"] = token
		case "Bedrock":
			missingAccessKey := credentials.AccessKeyId == nil || strings.TrimSpace(*credentials.AccessKeyId) == ""
			missingSecretKey := credentials.SecretAccessKey == nil || strings.TrimSpace(*credentials.SecretAccessKey) == ""
			if missingAccessKey || missingSecretKey {
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest, "invalid_request",
					"AWS credentials require both an access key ID and secret access key", errBadRequest,
				))
				return
			}
			data["accessKey"] = *credentials.AccessKeyId
			data["secretKey"] = *credentials.SecretAccessKey
			if credentials.SessionToken != nil {
				data["sessionToken"] = *credentials.SessionToken
			}
		case "ModelArmor":
			if credentials.GoogleCredentialsJson == nil || !json.Valid([]byte(*credentials.GoogleCredentialsJson)) {
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest, "invalid_request",
					"Google credentials must be valid ADC credential JSON on a Model Armor provider", errBadRequest,
				))
				return
			}
			data["credentials.json"] = *credentials.GoogleCredentialsJson
		}
		spec.CredentialRevision = uuid.NewString()
		path := access.namespace + "/guardrail-connections/" + input.Name + "/" + spec.CredentialRevision
		_, err := s.baoKV.Put(r.Context(), path, data, baoapi.WithCheckAndSet(0))
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		credentialPath = path
		spec.SecretName = guardrails.ConnectionRuntimeName(&api.GuardrailConnection{
			ObjectMeta: metav1.ObjectMeta{Namespace: access.namespace, Name: input.Name},
		})
	}
	if spec.Provider == "OpenAI" && spec.SecretName == "" {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request",
			"OpenAI moderation requires an API key", errBadRequest,
		))
		return
	}
	spec.LastModifiedByUserID = access.claims.UserID
	status := http.StatusOK
	if r.Method == http.MethodPost {
		spec.CreatedByUserID = access.claims.UserID
		item.ObjectMeta = metav1.ObjectMeta{
			Name:            input.Name,
			Namespace:       access.namespace,
			Finalizers:      []string{api.GuardrailConnectionFinalizer},
			OwnerReferences: []metav1.OwnerReference{access.owner},
		}
		status = http.StatusCreated
	}
	item.Spec = spec
	var err error
	switch r.Method {
	case http.MethodPost:
		err = s.k8sClient.Create(r.Context(), item)
	default:
		err = s.k8sClient.Update(r.Context(), item)
	}
	// A transport error can follow a committed Kubernetes write. Only discard
	// credentials after an authoritative rejection; uncertain revisions remain
	// available and the connection finalizer removes them on deletion.
	rejected := apierrors.IsConflict(err) || apierrors.IsInvalid(err) || apierrors.IsForbidden(err) ||
		apierrors.IsUnauthorized(err) || apierrors.IsAlreadyExists(err) || apierrors.IsNotFound(err) || apierrors.IsBadRequest(err)
	if rejected && credentialPath != "" {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		cleanupErr := s.baoKV.DeleteMetadata(cleanupCtx, credentialPath)
		cancel()
		if cleanupErr != nil && !errors.Is(cleanupErr, baoapi.ErrSecretNotFound) {
			err = errors.Join(err, cleanupErr)
		}
	}
	apiErr = s.recordGuardrailMutation(r.Context(), access, gatewaydb.EventTrailTargetGuardrailConnection, item.Name, err)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	apiutil.WriteJSON(w, status, guardrailConnectionView(*item, resourceScope(access.workspaceID), access))
}

func guardrailConnectionView(item api.GuardrailConnection, scope gatewayapi.ResourceScope, access resourceAccess) gatewayapi.GuardrailConnection {
	permissionScope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	owned := item.Namespace == access.namespace
	state := item.Status.State
	if state == "" || item.Status.ObservedGeneration != item.Generation {
		state = "Pending"
	}
	return gatewayapi.GuardrailConnection{
		Name:                  item.Name,
		DisplayName:           item.Spec.DisplayName,
		Description:           item.Spec.Description,
		Provider:              gatewayapi.GuardrailConnectionProvider(item.Spec.Provider),
		Endpoint:              item.Spec.Endpoint,
		Region:                item.Spec.Region,
		Scope:                 scope,
		CredentialsConfigured: item.Spec.SecretName != "",
		CanModify:             owned && access.effective.Allows(permissionScope, authorization.OperationUpdateGuardrailConnection),
		CanDelete:             owned && access.effective.Allows(permissionScope, authorization.OperationDeleteGuardrailConnection),
		Status: gatewayapi.GuardrailStatus{
			State:              gatewayapi.GuardrailStatusState(state),
			Revision:           item.Status.Revision,
			Message:            item.Status.Message,
			ObservedGeneration: item.Status.ObservedGeneration,
		},
	}
}

// ListGuardrailPolicies lists optional and mandatory scoped policies.
func (s *Service) ListGuardrailPolicies(w http.ResponseWriter, r *http.Request, _ gatewayapi.ListGuardrailPoliciesParams) {
	s.serveGuardrailPolicies(w, r, "")
}

// GetGuardrailPolicy reads one policy.
func (s *Service) GetGuardrailPolicy(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.GetGuardrailPolicyParams) {
	s.serveGuardrailPolicies(w, r, name)
}

// CreateGuardrailPolicy saves a reusable ordered policy.
func (s *Service) CreateGuardrailPolicy(w http.ResponseWriter, r *http.Request, _ gatewayapi.CreateGuardrailPolicyParams) {
	s.serveGuardrailPolicies(w, r, "")
}

// UpdateGuardrailPolicy updates an owned policy.
func (s *Service) UpdateGuardrailPolicy(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.UpdateGuardrailPolicyParams) {
	s.serveGuardrailPolicies(w, r, name)
}

// DeleteGuardrailPolicy deletes an unreferenced policy.
func (s *Service) DeleteGuardrailPolicy(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.DeleteGuardrailPolicyParams) {
	s.serveGuardrailPolicies(w, r, name)
}

func (s *Service) serveGuardrailPolicies(w http.ResponseWriter, r *http.Request, name string) {
	operation := authorization.OperationListGuardrailPolicies
	switch r.Method {
	case http.MethodPost:
		operation = authorization.OperationCreateGuardrailPolicy
	case http.MethodPut:
		operation = authorization.OperationUpdateGuardrailPolicy
	case http.MethodDelete:
		operation = authorization.OperationDeleteGuardrailPolicy
	case http.MethodGet:
		if name != "" {
			operation = authorization.OperationGetGuardrailPolicy
		}
	}
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Policy",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   operation,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	org := api.ScopeNamespace(api.ResourceScopeOrganisation, access.claims.OrganizationID)
	tenant := &api.Tenant{}
	if err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Name: org}, tenant); err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get organization settings", err))
		return
	}
	if r.Method == http.MethodGet && name == "" {
		list := &api.GuardrailPolicyList{}
		err := s.k8sClient.List(r.Context(), list, ctrlclient.InNamespace(access.namespace))
		if err != nil {
			apiutil.WriteError(w, r, mapKubeHTTPError("list guardrail policies", err))
			return
		}
		items := make([]gatewayapi.GuardrailPolicy, 0, len(list.Items))
		for _, item := range list.Items {
			items = append(items, guardrailPolicyView(item, resourceScope(access.workspaceID), access, tenant.Spec.Guardrails))
		}
		if access.workspaceID != "" {
			workspace := &api.Workspace{}
			err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Name: access.namespace}, workspace)
			if err != nil {
				apiutil.WriteError(w, r, mapKubeHTTPError("get workspace", err))
				return
			}
			names := slices.Clone(tenant.Spec.Guardrails.MandatoryPolicies)
			for _, selected := range workspace.Spec.SelectedOrganizationResources.GuardrailPolicies {
				if !slices.Contains(names, selected) {
					names = append(names, selected)
				}
			}
			for _, selected := range names {
				item := &api.GuardrailPolicy{}
				err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: org, Name: selected}, item)
				if err != nil {
					if apierrors.IsNotFound(err) {
						continue
					}
					apiutil.WriteError(w, r, mapKubeHTTPError("get inherited policy", err))
					return
				}
				items = append(items, guardrailPolicyView(*item, gatewayapi.ResourceScopeOrganisation, access, tenant.Spec.Guardrails))
			}
		}
		apiutil.WriteJSON(w, http.StatusOK, map[string][]gatewayapi.GuardrailPolicy{"items": items})
		return
	}
	item := &api.GuardrailPolicy{}
	if r.Method != http.MethodPost {
		err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: name}, item)
		if err != nil {
			apiutil.WriteError(w, r, mapKubeHTTPError("get guardrail policy", err))
			return
		}
	}
	if r.Method == http.MethodGet {
		apiutil.WriteJSON(w, http.StatusOK, guardrailPolicyView(*item, resourceScope(access.workspaceID), access, tenant.Spec.Guardrails))
		return
	}
	if r.Method == http.MethodDelete {
		conflict, err := s.selectedOrganizationResourceConflict(
			r.Context(),
			access,
			api.OrganizationResourceKindGuardrailPolicy,
			item.Name,
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if conflict != nil {
			apiutil.WriteError(w, r, conflict)
			return
		}
		if item.Namespace == org && slices.Contains(tenant.Spec.Guardrails.MandatoryPolicies, item.Name) {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusConflict, "resource_in_use",
				"policy is in the mandatory organization baseline", errBadRequest,
			))
			return
		}
		sandboxes := &api.SandboxList{}
		if err := s.k8sClient.List(r.Context(), sandboxes); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		for _, sandbox := range sandboxes.Items {
			for _, ref := range sandbox.Spec.Guardrails.Policies {
				if ref.Name != item.Name {
					continue
				}
				ns, err := scope.Namespace(r.Context(), s.k8sClient, sandbox.Namespace, ref.Scope)
				if err != nil {
					apiutil.WriteInternalError(w, r, err)
					return
				}
				if ns == item.Namespace {
					apiutil.WriteError(w, r, apiutil.NewError(
						http.StatusConflict, "resource_in_use",
						"policy is assigned to Sandbox "+sandbox.Name, errBadRequest,
					))
					return
				}
			}
		}
		assignments, err := s.queries.GatewayListOrganizationExternalAgentGuardrails(r.Context(), access.claims.OrganizationID)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		for _, assignment := range assignments {
			for _, ref := range assignment.Policies {
				if ref.Name != item.Name {
					continue
				}
				ns := org
				if ref.Scope == api.ResourceScopeWorkspace {
					ns = api.ScopeNamespace(api.ResourceScopeWorkspace, assignment.WorkspaceID)
				}
				if ns == item.Namespace {
					apiutil.WriteError(w, r, apiutil.NewError(
						http.StatusConflict, "resource_in_use",
						"policy is assigned to an external agent", errBadRequest,
					))
					return
				}
			}
		}
		err = s.k8sClient.Delete(r.Context(), item)
		apiErr = s.recordGuardrailMutation(r.Context(), access, gatewaydb.EventTrailTargetGuardrailPolicy, item.Name, err)
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var input gatewayapi.GuardrailPolicyInput
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	if len(validation.IsDNS1123Label(input.Name)) > 0 || (name != "" && input.Name != name) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request",
			"name must be a valid immutable resource name", errBadRequest,
		))
		return
	}
	spec := api.GuardrailPolicySpec{
		ResourceAudit: item.Spec.ResourceAudit,
		DisplayName:   input.DisplayName,
		Checks:        input.Checks,
	}
	if input.Description != nil {
		spec.Description = *input.Description
	}
	proposed := &api.GuardrailPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: input.Name, Namespace: access.namespace},
		Spec:       spec,
	}
	_, err := guardrails.CompilePolicy(r.Context(), s.k8sClient, access.namespace, proposed)
	replacing := r.Method == http.MethodPut
	mandatory := access.namespace == org && slices.Contains(tenant.Spec.Guardrails.MandatoryPolicies, input.Name)
	if err == nil && (replacing || mandatory) {
		err = s.validateGuardrailChange(r.Context(), access, tenant, proposed)
	}
	if err != nil {
		var status apierrors.APIStatus
		if errors.As(err, &status) {
			apiutil.WriteError(w, r, mapKubeHTTPError("get detector provider", err))
			return
		}
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", err.Error(), err))
		return
	}
	spec.LastModifiedByUserID = access.claims.UserID
	status := http.StatusOK
	if r.Method == http.MethodPost {
		spec.CreatedByUserID = access.claims.UserID
		item.ObjectMeta = metav1.ObjectMeta{
			Name:            input.Name,
			Namespace:       access.namespace,
			OwnerReferences: []metav1.OwnerReference{access.owner},
		}
		status = http.StatusCreated
	}
	item.Spec = spec
	switch r.Method {
	case http.MethodPost:
		err = s.k8sClient.Create(r.Context(), item)
	default:
		err = s.k8sClient.Update(r.Context(), item)
	}
	apiErr = s.recordGuardrailMutation(r.Context(), access, gatewaydb.EventTrailTargetGuardrailPolicy, item.Name, err)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	apiutil.WriteJSON(w, status, guardrailPolicyView(*item, resourceScope(access.workspaceID), access, tenant.Spec.Guardrails))
}

func guardrailPolicyView(item api.GuardrailPolicy, scope gatewayapi.ResourceScope, access resourceAccess, settings api.GuardrailSettings) gatewayapi.GuardrailPolicy {
	permissionScope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	owned := item.Namespace == access.namespace
	state := item.Status.State
	if state == "" || item.Status.ObservedGeneration != item.Generation {
		state = "Pending"
	}
	return gatewayapi.GuardrailPolicy{
		Name:        item.Name,
		DisplayName: item.Spec.DisplayName,
		Description: item.Spec.Description,
		Checks:      item.Spec.Checks,
		Scope:       scope,
		Mandatory:   scope == gatewayapi.ResourceScopeOrganisation && slices.Contains(settings.MandatoryPolicies, item.Name),
		CanModify:   owned && access.effective.Allows(permissionScope, authorization.OperationUpdateGuardrailPolicy),
		CanDelete:   owned && access.effective.Allows(permissionScope, authorization.OperationDeleteGuardrailPolicy),
		Status: gatewayapi.GuardrailStatus{
			State:              gatewayapi.GuardrailStatusState(state),
			Revision:           item.Status.Revision,
			Message:            item.Status.Message,
			ObservedGeneration: item.Status.ObservedGeneration,
		},
	}
}

// GetGuardrailSettings reads organization-owned settings from either scope.
func (s *Service) GetGuardrailSettings(w http.ResponseWriter, r *http.Request, _ gatewayapi.GetGuardrailSettingsParams) {
	s.serveGuardrailSettings(w, r)
}

// UpdateGuardrailSettings changes the mandatory organization baseline.
func (s *Service) UpdateGuardrailSettings(w http.ResponseWriter, r *http.Request, _ gatewayapi.UpdateGuardrailSettingsParams) {
	s.serveGuardrailSettings(w, r)
}

func (s *Service) serveGuardrailSettings(w http.ResponseWriter, r *http.Request) {
	operation := authorization.OperationGetGuardrailSettings
	if r.Method == http.MethodPut {
		operation = authorization.OperationUpdateGuardrailSettings
		if r.Header.Get("X-AgentZ-Workspace-ID") != "" {
			apiutil.WriteError(w, r, resourceForbidden(errors.New("only organization administrators can change guardrail settings")))
			return
		}
	}
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Settings",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   operation,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	tenant := &api.Tenant{}
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{
		Name: api.ScopeNamespace(api.ResourceScopeOrganisation, access.claims.OrganizationID),
	}, tenant)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get organization settings", err))
		return
	}
	if r.Method == http.MethodPut {
		allowed, err := s.queries.GatewayIsActiveSuperadmin(r.Context(), gatewaydb.GatewayIsActiveSuperadminParams{
			OrganizationID: access.claims.OrganizationID,
			UserID:         access.claims.UserID,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if !allowed {
			apiutil.WriteError(w, r, resourceForbidden(errors.New("organization administrator authority is required")))
			return
		}
		var input gatewayapi.GuardrailSettings
		if !decodeJSONBody(w, r, &input, false) {
			return
		}
		seen := make(map[string]bool, len(input.MandatoryPolicies))
		for _, name := range input.MandatoryPolicies {
			if seen[name] {
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest, "invalid_request",
					"mandatory policy references must be unique", errBadRequest,
				))
				return
			}
			seen[name] = true
		}
		tenant.Spec.Guardrails = api.GuardrailSettings{
			MandatoryPolicies: input.MandatoryPolicies,
		}
		err = s.validateGuardrailChange(r.Context(), access, tenant, nil)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", err.Error(), err))
			return
		}
		err = s.k8sClient.Update(r.Context(), tenant)
		apiErr = s.recordGuardrailMutation(r.Context(), access, gatewaydb.EventTrailTargetGuardrailSettings, tenant.Name, err)
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
	}
	settings := gatewayapi.GuardrailSettings{
		MandatoryPolicies: tenant.Spec.Guardrails.MandatoryPolicies,
	}
	if settings.MandatoryPolicies == nil {
		settings.MandatoryPolicies = []string{}
	}
	apiutil.WriteJSON(w, http.StatusOK, settings)
}

// GetEffectiveGuardrails previews the authoritative baseline plus applicable additions.
func (s *Service) GetEffectiveGuardrails(w http.ResponseWriter, r *http.Request, _ gatewayapi.GetEffectiveGuardrailsParams) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Policy",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   authorization.OperationGetEffectiveGuardrails,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var input gatewayapi.GuardrailEffectiveInput
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	assignment := input.Assignment
	contextNamespace := access.namespace
	if input.Sandbox != nil {
		selectedScope := api.ResourceScope(resourceScope(access.workspaceID))
		if input.SandboxScope != nil {
			selectedScope = api.ResourceScope(*input.SandboxScope)
		}
		namespace, err := scope.SelectedNamespace(r.Context(), s.k8sClient, access.namespace, scope.Selection{
			Scope: selectedScope,
			Kind:  api.OrganizationResourceKindSandbox,
			Name:  *input.Sandbox,
		})
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", err.Error(), err))
			return
		}
		sandbox := &api.Sandbox{}
		err = s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: namespace, Name: *input.Sandbox}, sandbox)
		if err != nil {
			apiutil.WriteError(w, r, mapKubeHTTPError("get sandbox", err))
			return
		}
		assignment = sandbox.Spec.Guardrails
		contextNamespace = sandbox.Namespace
	}
	bundle, err := guardrails.Resolve(r.Context(), s.k8sClient, contextNamespace, assignment)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", err.Error(), err))
		return
	}
	checks := make([]gatewayapi.GuardrailEffectiveCheck, 0, len(bundle.Checks))
	for _, resolved := range bundle.Checks {
		checks = append(checks, gatewayapi.GuardrailEffectiveCheck{
			Check:      resolved.Check,
			Mandatory:  resolved.Mandatory,
			PolicyId:   string(resolved.Policy.UID),
			PolicyName: resolved.Policy.Spec.DisplayName,
		})
	}
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.GuardrailEffective{Revision: bundle.Revision, Checks: checks})
}

// resolveExternalAgentGuardrails reads additions only for registered external agents.
func (s *Service) resolveExternalAgentGuardrails(ctx context.Context, organizationID, workspaceID, clientID string) (api.GuardrailAssignment, error) {
	policies, err := s.queries.GatewayGetExternalAgentGuardrails(ctx, gatewaydb.GatewayGetExternalAgentGuardrailsParams{
		OrganizationID: organizationID,
		WorkspaceID:    workspaceID,
		ClientID:       clientID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.GuardrailAssignment{}, nil
	}
	if err != nil {
		return api.GuardrailAssignment{}, err
	}
	return api.GuardrailAssignment{Policies: policies}, nil
}

// recordGuardrailMutation records the persistence result without storing policy content or credentials.
func (s *Service) recordGuardrailMutation(ctx context.Context, access resourceAccess, target gatewaydb.EventTrailTarget, name string, mutationErr error) *apiutil.APIError {
	action := "modify"
	switch access.operation {
	case authorization.OperationCreateGuardrailConnection, authorization.OperationCreateGuardrailPolicy:
		action = "create"
	case authorization.OperationDeleteGuardrailConnection, authorization.OperationDeleteGuardrailPolicy:
		action = "delete"
	}
	result := gatewaydb.EventTrailResultSucceeded
	if mutationErr != nil {
		result = gatewaydb.EventTrailResultFailed
	}
	category := string(target)
	auditErr := s.createResourceEventTrail(ctx, access, target, name, category, action, result)
	if auditErr != nil {
		return apiutil.NewError(http.StatusInternalServerError, "internal_error", "request failed", errors.Join(mutationErr, auditErr))
	}
	if mutationErr != nil {
		return mapKubeHTTPError(action+" "+category, mutationErr)
	}
	return nil
}

func (s *Service) validateGuardrailChange(ctx context.Context, access resourceAccess, tenant *api.Tenant, policy *api.GuardrailPolicy) error {
	org := api.ScopeNamespace(api.ResourceScopeOrganisation, access.claims.OrganizationID)
	mandatory := policy == nil
	if policy != nil {
		mandatory = policy.Namespace == org && slices.Contains(tenant.Spec.Guardrails.MandatoryPolicies, policy.Name)
	}
	if mandatory {
		err := guardrails.ValidateConfiguration(ctx, s.k8sClient, org, tenant.Spec.Guardrails, api.GuardrailAssignment{}, policy)
		if err != nil {
			return err
		}
	}
	sandboxes := &api.SandboxList{}
	options := []ctrlclient.ListOption{}
	if access.workspaceID != "" {
		options = append(options, ctrlclient.InNamespace(access.namespace))
	}
	if err := s.k8sClient.List(ctx, sandboxes, options...); err != nil {
		return err
	}
	for _, sandbox := range sandboxes.Items {
		affected := mandatory
		for _, ref := range sandbox.Spec.Guardrails.Policies {
			namespace := org
			if ref.Scope == api.ResourceScopeWorkspace {
				namespace = sandbox.Namespace
			}
			if policy != nil && ref.Name == policy.Name && namespace == policy.Namespace {
				affected = true
			}
		}
		if !affected {
			continue
		}
		owner, err := scope.Namespace(ctx, s.k8sClient, sandbox.Namespace, api.ResourceScopeOrganisation)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		if owner != org {
			continue
		}
		err = guardrails.ValidateConfiguration(ctx, s.k8sClient, sandbox.Namespace, tenant.Spec.Guardrails, sandbox.Spec.Guardrails, policy)
		if err != nil {
			return fmt.Errorf("sandbox %q: %w", sandbox.Name, err)
		}
	}
	assignments, err := s.queries.GatewayListOrganizationExternalAgentGuardrails(ctx, access.claims.OrganizationID)
	if err != nil {
		return err
	}
	for _, selected := range assignments {
		assignment := api.GuardrailAssignment{Policies: selected.Policies}
		namespace := api.ScopeNamespace(api.ResourceScopeWorkspace, selected.WorkspaceID)
		affected := mandatory
		for _, ref := range assignment.Policies {
			source := org
			if ref.Scope == api.ResourceScopeWorkspace {
				source = namespace
			}
			if policy != nil && ref.Name == policy.Name && source == policy.Namespace {
				affected = true
			}
		}
		if !affected {
			continue
		}
		err := guardrails.ValidateConfiguration(ctx, s.k8sClient, namespace, tenant.Spec.Guardrails, assignment, policy)
		if err != nil {
			return fmt.Errorf("external agent assignment: %w", err)
		}
	}
	return nil
}
