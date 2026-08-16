package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/sandboxutil"
	"github.com/accuknox/agentz/internal/scoperesolver"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListSandboxes handles GET /api/sandbox.
func (s *Service) ListSandboxes(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSandboxesParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSandboxAccess(
		r.Context(), workspaceID, "", authorization.OperationListSandboxes,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	var sandboxList agentzv1alpha1.SandboxList
	if err := s.k8sClient.List(r.Context(), &sandboxList, ctrlclient.InNamespace(access.namespace)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list sandboxes: %w", err))
		return
	}
	refs, err := sandboxutil.ReferencedNames(
		r.Context(),
		s.k8sClient,
		access.namespace,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list sandbox references: %w", err))
		return
	}
	userIDs := make([]string, 0, len(sandboxList.Items)*2)
	for _, sandbox := range sandboxList.Items {
		userIDs = append(userIDs, sandbox.Spec.CreatedByUserID, sandbox.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(r.Context(), userIDs...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.Sandbox, 0, len(sandboxList.Items))
	for _, sb := range sandboxList.Items {
		items = append(items, sandboxFromCRD(sb, refs[sb.Name], access, actors))
	}
	if workspaceID != "" {
		inherited, err := s.listInheritedSandboxes(r.Context(), access, refs)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		items = append(items, inherited...)
	}
	slices.SortFunc(items, func(a, b gatewayapi.Sandbox) int {
		if a.Name != b.Name {
			return strings.Compare(a.Name, b.Name)
		}
		return strings.Compare(string(a.Scope), string(b.Scope))
	})

	start := min(offset, len(items))
	end := min(start+limit, len(items))

	page := items[start:end]
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListSandboxesResponse{
		Sandboxes:     page,
		NextPageToken: next,
	})
}

func (s *Service) listInheritedSandboxes(ctx context.Context, access resourceAccess, refs map[string]bool) ([]gatewayapi.Sandbox, error) {
	selected, err := s.selectedOrganizationResourceNames(
		ctx,
		access.workspaceID,
		access.claims.OrganizationID,
		agentzv1alpha1.OrganizationResourceKindSandbox,
	)
	if err != nil {
		return nil, err
	}
	if len(selected) == 0 {
		return []gatewayapi.Sandbox{}, nil
	}
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		access.claims.OrganizationID,
	)
	var sandboxes agentzv1alpha1.SandboxList
	if err := s.k8sClient.List(ctx, &sandboxes, ctrlclient.InNamespace(organizationNamespace)); err != nil {
		return nil, fmt.Errorf("list inherited Organisation Sandboxes: %w", err)
	}
	organizationAccess := access
	organizationAccess.workspaceID = ""
	userIDs := make([]string, 0, len(sandboxes.Items)*2)
	for _, sandbox := range sandboxes.Items {
		if _, ok := selected[sandbox.Name]; !ok {
			continue
		}
		userIDs = append(userIDs, sandbox.Spec.CreatedByUserID, sandbox.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(ctx, userIDs...)
	if err != nil {
		return nil, err
	}
	items := make([]gatewayapi.Sandbox, 0, len(sandboxes.Items))
	for _, sb := range sandboxes.Items {
		if _, ok := selected[sb.Name]; !ok {
			continue
		}
		item := sandboxFromCRD(sb, refs[sb.Name], organizationAccess, actors)
		item.CanModify = false
		item.CanDelete = false
		items = append(items, item)
	}
	return items, nil
}

// CreateSandbox handles POST /api/sandbox.
func (s *Service) CreateSandbox(w http.ResponseWriter, r *http.Request, params gatewayapi.CreateSandboxParams) {
	var req gatewayapi.CreateSandboxRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	name, fields := validateCreateSandboxRequest(req, workspaceID != "")
	access, apiErr := s.resolveSandboxAccess(
		r.Context(), workspaceID, "", authorization.OperationCreateSandbox,
	)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
				access: access,
				name:   name,
				result: access.failureResult(),
			})

			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	if len(fields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	var rawSkills []gatewayapi.ResourceReference
	if req.Skills != nil {
		rawSkills = *req.Skills
	}
	skills, skillFields, err := s.validateSkillRefs(r.Context(), access.namespace, rawSkills)
	fields = append(fields, skillFields...)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	packages := []string{}
	if req.Packages != nil {
		packages = *req.Packages
	}

	var rawAllowedHosts []string
	if req.AllowedHosts != nil {
		rawAllowedHosts = *req.AllowedHosts
	}
	allowedHosts := make([]string, 0, len(rawAllowedHosts))
	seenHosts := make(map[string]struct{}, len(rawAllowedHosts))
	for i, entry := range rawAllowedHosts {
		host, err := sandboxutil.ParseHost(entry)
		if err != nil {
			eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
				access: access,
				name:   name,
				result: gatewaydb.EventTrailResultFailed,
			})

			if eventTrailErr != nil {
				writeInternalError(w, r, errors.Join(err, eventTrailErr))
				return
			}
			writeAllowedHostsError(w, r, fmt.Errorf("allowedHosts[%d]: %w", i, err))
			return
		}
		if _, ok := seenHosts[host.Value]; ok {
			continue
		}
		seenHosts[host.Value] = struct{}{}
		allowedHosts = append(allowedHosts, host.Value)
	}

	var rawMCPConnectionRefs []gatewayapi.MCPConnectionRef
	if req.McpConnectionRefs != nil {
		rawMCPConnectionRefs = *req.McpConnectionRefs
	}
	mcpConnectionRefs := make([]agentzv1alpha1.MCPConnectionRef, 0, len(rawMCPConnectionRefs))
	for _, ref := range rawMCPConnectionRefs {
		name := ref.Name
		if name == "" {
			continue
		}
		tools := make([]agentzv1alpha1.SandboxMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := rawTool.Name
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.SandboxMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		mcpConnectionRefs = append(mcpConnectionRefs, agentzv1alpha1.MCPConnectionRef{
			ResourceReference: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScope(ref.Scope),
				Name:  name,
			},
			Tools: tools,
		})
	}
	fields = s.validateSandboxMCPConnections(r.Context(), access.namespace, mcpConnectionRefs)
	if len(fields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	access, apiErr = s.resolveSandboxAccess(
		r.Context(), workspaceID, "", authorization.OperationCreateSandbox,
	)
	if apiErr != nil {
		err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: access.failureResult(),
		})

		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, apiErr)
		return
	}

	sandbox := &agentzv1alpha1.Sandbox{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Sandbox",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:            name,
			Namespace:       access.namespace,
			OwnerReferences: []metav1.OwnerReference{access.owner},
		},
		Spec: agentzv1alpha1.SandboxSpec{
			ResourceAudit: agentzv1alpha1.ResourceAudit{
				CreatedByUserID:      access.claims.UserID,
				LastModifiedByUserID: access.claims.UserID,
			},
			Packages:          packages,
			AllowedHosts:      allowedHosts,
			MCPConnectionRefs: mcpConnectionRefs,
			Skills:            resourceReferencesToCRD(skills),
			Inference:         sandboxInferenceFromAPI(req.Inference),
		},
	}
	dependencyFields, err := s.validateSandboxDependencies(r.Context(), access, sandbox)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, err)
		return
	}
	if len(dependencyFields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			dependencyFields...,
		))
		return
	}

	if err := s.k8sClient.Create(r.Context(), sandbox); err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("create sandbox", err))
		return
	}
	if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
		access: access,
		name:   name,
		result: gatewaydb.EventTrailResultSucceeded,
	}); err != nil {
		writeInternalError(w, r, err)
		return
	}

	actors, err := s.resourceActors(
		r.Context(), sandbox.Spec.CreatedByUserID, sandbox.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sandboxFromCRD(*sandbox, false, access, actors))
}

// DeleteSandbox handles DELETE /api/sandbox/{sandboxName}.
func (s *Service) DeleteSandbox(w http.ResponseWriter, r *http.Request, sandboxName gatewayapi.SandboxName, params gatewayapi.DeleteSandboxParams) {
	name := strings.TrimSpace(sandboxName)
	if name == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "name", Message: "required"},
		))
		return
	}
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSandboxAccess(
		r.Context(), workspaceID, name, authorization.OperationDeleteSandbox,
	)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
				access: access,
				name:   name,
				result: access.failureResult(),
			})

			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	conflict, err := s.selectedOrganizationResourceConflict(
		r.Context(), access, agentzv1alpha1.OrganizationResourceKindSandbox, name,
	)
	if err != nil || conflict != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access, name: name, result: gatewaydb.EventTrailResultFailed,
		})

		if err != nil || eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, conflict)
		return
	}

	sandbox := &agentzv1alpha1.Sandbox{}
	sandbox.Name = name
	sandbox.Namespace = access.namespace
	agentNames, err := sandboxutil.ReferencingAgentNames(
		r.Context(),
		s.usageReader,
		access.namespace,
		name,
	)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, fmt.Errorf("check sandbox references: %w", err))
		return
	}
	if len(agentNames) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"sandbox_referenced",
			"sandbox is referenced by agent "+agentNames[0],
			errBadRequest,
		))
		return
	}
	access, apiErr = s.resolveSandboxAccess(
		r.Context(), workspaceID, name, authorization.OperationDeleteSandbox,
	)
	if apiErr != nil {
		err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: access.failureResult(),
		})

		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, apiErr)
		return
	}
	sandbox.Namespace = access.namespace

	if err := s.k8sClient.Delete(r.Context(), sandbox); err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete sandbox", err))
		return
	}
	if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
		access: access,
		name:   name,
		result: gatewaydb.EventTrailResultSucceeded,
	}); err != nil {
		writeInternalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateSandbox handles PUT /api/sandbox/{sandboxName}.
func (s *Service) UpdateSandbox(w http.ResponseWriter, r *http.Request, sandboxName gatewayapi.SandboxName, params gatewayapi.UpdateSandboxParams) {
	var req gatewayapi.UpdateSandboxRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	name := strings.TrimSpace(sandboxName)
	access, apiErr := s.resolveSandboxAccess(
		r.Context(), workspaceID, name, authorization.OperationUpdateSandbox,
	)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
				access: access,
				name:   name,
				result: access.failureResult(),
			})

			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	fields := validateUpdateSandboxRequest(req, workspaceID != "")
	if len(fields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	allowedHosts := make([]string, 0, len(req.AllowedHosts))
	seenHosts := make(map[string]struct{}, len(req.AllowedHosts))
	for i, entry := range req.AllowedHosts {
		host, err := sandboxutil.ParseHost(entry)
		if err != nil {
			eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
				access: access,
				name:   name,
				result: gatewaydb.EventTrailResultFailed,
			})

			if eventTrailErr != nil {
				writeInternalError(w, r, errors.Join(err, eventTrailErr))
				return
			}
			writeAllowedHostsError(w, r, fmt.Errorf("allowedHosts[%d]: %w", i, err))
			return
		}
		if _, ok := seenHosts[host.Value]; ok {
			continue
		}
		seenHosts[host.Value] = struct{}{}
		allowedHosts = append(allowedHosts, host.Value)
	}
	mcpConnectionRefs := make([]agentzv1alpha1.MCPConnectionRef, 0, len(req.McpConnectionRefs))
	for _, ref := range req.McpConnectionRefs {
		name := ref.Name
		if name == "" {
			continue
		}
		tools := make([]agentzv1alpha1.SandboxMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := rawTool.Name
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.SandboxMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		mcpConnectionRefs = append(mcpConnectionRefs, agentzv1alpha1.MCPConnectionRef{
			ResourceReference: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScope(ref.Scope),
				Name:  name,
			},
			Tools: tools,
		})
	}
	packages := req.Packages
	skills, skillFields, err := s.validateSkillRefs(r.Context(), access.namespace, req.Skills)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, err)
		return
	}
	fields = append(fields, skillFields...)
	fields = append(fields, s.validateSandboxMCPConnections(r.Context(), access.namespace, mcpConnectionRefs)...)
	if len(fields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	access, apiErr = s.resolveSandboxAccess(
		r.Context(), workspaceID, name, authorization.OperationUpdateSandbox,
	)
	if apiErr != nil {
		err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: access.failureResult(),
		})

		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, apiErr)
		return
	}
	desiredInference := sandboxInferenceFromAPI(req.Inference)
	dependencies := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Namespace: access.namespace},
		Spec: agentzv1alpha1.SandboxSpec{
			MCPConnectionRefs: mcpConnectionRefs,
			Skills:            resourceReferencesToCRD(skills),
			Inference:         desiredInference,
		},
	}
	dependencyFields, err := s.validateSandboxDependencies(r.Context(), access, dependencies)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, err)
		return
	}
	if len(dependencyFields) > 0 {
		if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		}); err != nil {
			writeInternalError(w, r, err)
			return
		}
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			dependencyFields...,
		))
		return
	}

	var updated *agentzv1alpha1.Sandbox
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		sandbox := &agentzv1alpha1.Sandbox{}
		if getErr := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{
			Name:      name,
			Namespace: access.namespace,
		}, sandbox); getErr != nil {
			return getErr
		}

		sandbox.Spec.Packages = packages
		sandbox.Spec.AllowedHosts = allowedHosts
		sandbox.Spec.MCPConnectionRefs = mcpConnectionRefs
		sandbox.Spec.Skills = resourceReferencesToCRD(skills)
		sandbox.Spec.Inference = desiredInference
		sandbox.Spec.LastModifiedByUserID = access.claims.UserID

		if updateErr := s.k8sClient.Update(r.Context(), sandbox); updateErr != nil {
			return updateErr
		}
		updated = sandbox
		return nil
	})
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("update sandbox", err))
		return
	}

	agentNames, err := sandboxutil.ReferencingAgentNames(
		r.Context(),
		s.usageReader,
		access.namespace,
		updated.Name,
	)
	if err != nil {
		eventTrailErr := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
			access: access,
			name:   name,
			result: gatewaydb.EventTrailResultFailed,
		})

		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeInternalError(w, r, fmt.Errorf("check sandbox references: %w", err))
		return
	}
	if err := s.createSandboxEventTrail(r.Context(), sandboxEventTrail{
		access: access,
		name:   name,
		result: gatewaydb.EventTrailResultSucceeded,
	}); err != nil {
		writeInternalError(w, r, err)
		return
	}
	actors, err := s.resourceActors(
		r.Context(), updated.Spec.CreatedByUserID, updated.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sandboxFromCRD(*updated, len(agentNames) > 0, access, actors))
}

func sandboxFromCRD(sb agentzv1alpha1.Sandbox, referenced bool, access resourceAccess, actors map[string]gatewayapi.ResourceActor) gatewayapi.Sandbox {
	packages := []string{}
	if sb.Spec.Packages != nil {
		packages = sb.Spec.Packages
	}
	allowedHosts := []string{}
	if sb.Spec.AllowedHosts != nil {
		allowedHosts = sb.Spec.AllowedHosts
	}
	mcpConnectionRefs := []gatewayapi.MCPConnectionRef{}
	if sb.Spec.MCPConnectionRefs != nil {
		mcpConnectionRefs = make([]gatewayapi.MCPConnectionRef, 0, len(sb.Spec.MCPConnectionRefs))
		for _, ref := range sb.Spec.MCPConnectionRefs {
			tools := make([]gatewayapi.MCPConnectionToolRef, 0, len(ref.Tools))
			for _, tool := range ref.Tools {
				tools = append(tools, gatewayapi.MCPConnectionToolRef{
					Name:           tool.Name,
					RequireConsent: tool.RequireConsent,
				})
			}
			mcpConnectionRefs = append(mcpConnectionRefs, gatewayapi.MCPConnectionRef{
				Scope: gatewayapi.ResourceScope(ref.Scope),
				Name:  ref.Name,
				Tools: tools,
			})
		}
	}
	out := gatewayapi.Sandbox{
		Scope:             resourceScope(access.workspaceID),
		Name:              sb.Name,
		CreatedBy:         actors[sb.Spec.CreatedByUserID],
		LastModifiedBy:    actors[sb.Spec.LastModifiedByUserID],
		Packages:          packages,
		AllowedHosts:      allowedHosts,
		McpConnectionRefs: mcpConnectionRefs,
		Skills:            resourceReferencesFromCRD(sb.Spec.Skills),
		CreatedAt:         sb.CreationTimestamp.Time,
		Inference:         sandboxInferenceToAPI(sb.Spec.Inference),
	}
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	creator := sb.Spec.CreatedByUserID == access.claims.UserID &&
		access.effective.Allows(scope, authorization.OperationCreateSandbox)
	out.CanModify = access.effective.Allows(scope, authorization.OperationUpdateSandbox) || creator
	out.CanDelete = access.effective.Allows(scope, authorization.OperationDeleteSandbox) || creator
	out.Metadata.PackageCount = int32(len(packages))
	out.Metadata.AllowedHostCount = int32(len(allowedHosts))
	out.Metadata.SkillCount = int32(len(sb.Spec.Skills))
	out.Metadata.ReferencedByAgent = referenced
	return out
}

func sandboxInferenceFromAPI(value gatewayapi.SandboxInference) agentzv1alpha1.SandboxInference {
	models := make([]agentzv1alpha1.InferenceModelRef, 0, len(value.Models))
	for _, model := range value.Models {
		models = append(models, agentzv1alpha1.InferenceModelRef{
			Scope:    agentzv1alpha1.ResourceScope(model.Scope),
			Provider: model.Provider,
			Model:    model.Model,
		})
	}
	out := agentzv1alpha1.SandboxInference{
		Models: models,
		DefaultModel: agentzv1alpha1.InferenceModelRef{
			Scope:    agentzv1alpha1.ResourceScope(value.DefaultModel.Scope),
			Provider: value.DefaultModel.Provider,
			Model:    value.DefaultModel.Model,
		},
	}
	if value.SmallModel != nil {
		out.SmallModel = &agentzv1alpha1.InferenceModelRef{
			Scope:    agentzv1alpha1.ResourceScope(value.SmallModel.Scope),
			Provider: value.SmallModel.Provider,
			Model:    value.SmallModel.Model,
		}
	}
	if value.AttachmentModel != nil {
		out.AttachmentModel = &agentzv1alpha1.InferenceModelRef{
			Scope:    agentzv1alpha1.ResourceScope(value.AttachmentModel.Scope),
			Provider: value.AttachmentModel.Provider,
			Model:    value.AttachmentModel.Model,
		}
	}
	return out
}

func sandboxInferenceToAPI(value agentzv1alpha1.SandboxInference) gatewayapi.SandboxInference {
	models := make([]gatewayapi.SandboxInferenceModelRef, 0, len(value.Models))
	for _, model := range value.Models {
		models = append(models, gatewayapi.SandboxInferenceModelRef{
			Scope:    gatewayapi.ResourceScope(model.Scope),
			Provider: model.Provider,
			Model:    model.Model,
		})
	}
	out := gatewayapi.SandboxInference{
		Models: models,
		DefaultModel: gatewayapi.SandboxInferenceModelRef{
			Scope:    gatewayapi.ResourceScope(value.DefaultModel.Scope),
			Provider: value.DefaultModel.Provider,
			Model:    value.DefaultModel.Model,
		},
	}
	if value.SmallModel != nil {
		out.SmallModel = &gatewayapi.SandboxInferenceModelRef{
			Scope:    gatewayapi.ResourceScope(value.SmallModel.Scope),
			Provider: value.SmallModel.Provider,
			Model:    value.SmallModel.Model,
		}
	}
	if value.AttachmentModel != nil {
		out.AttachmentModel = &gatewayapi.SandboxInferenceModelRef{
			Scope:    gatewayapi.ResourceScope(value.AttachmentModel.Scope),
			Provider: value.AttachmentModel.Provider,
			Model:    value.AttachmentModel.Model,
		}
	}
	return out
}

func validateCreateSandboxRequest(req gatewayapi.CreateSandboxRequest, workspace bool) (string, []gatewayapi.FieldError) {
	name := strings.TrimSpace(req.Name)
	fields := validateSandboxName(name)
	fields = append(fields, validateSandboxInferenceScopes(req.Inference, workspace)...)
	if req.Packages != nil {
		fields = append(fields, validatePackageList(*req.Packages)...)
	}
	if req.McpConnectionRefs != nil {
		fields = append(fields, validateMCPConnectionRefList(*req.McpConnectionRefs, workspace)...)
	}
	return name, fields
}

func validateUpdateSandboxRequest(req gatewayapi.UpdateSandboxRequest, workspace bool) []gatewayapi.FieldError {
	fields := validatePackageList(req.Packages)
	fields = append(fields, validateSandboxInferenceScopes(req.Inference, workspace)...)
	fields = append(fields, validateMCPConnectionRefList(req.McpConnectionRefs, workspace)...)
	return fields
}

func validateSandboxInferenceScopes(inference gatewayapi.SandboxInference, workspace bool) []gatewayapi.FieldError {
	if workspace {
		return []gatewayapi.FieldError{}
	}

	fields := []gatewayapi.FieldError{}
	for i, model := range inference.Models {
		if model.Scope == gatewayapi.ResourceScopeOrganisation {
			continue
		}
		fields = append(fields, gatewayapi.FieldError{
			Field:   fmt.Sprintf("inference.models[%d].scope", i),
			Message: "workspace scope is not available in Organisation scope",
		})
	}
	if inference.DefaultModel.Scope != gatewayapi.ResourceScopeOrganisation {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "inference.default_model.scope",
			Message: "workspace scope is not available in Organisation scope",
		})
	}
	if inference.SmallModel != nil && inference.SmallModel.Scope != gatewayapi.ResourceScopeOrganisation {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "inference.small_model.scope",
			Message: "workspace scope is not available in Organisation scope",
		})
	}
	if inference.AttachmentModel != nil && inference.AttachmentModel.Scope != gatewayapi.ResourceScopeOrganisation {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "inference.attachment_model.scope",
			Message: "workspace scope is not available in Organisation scope",
		})
	}
	return fields
}

func validateSandboxName(name string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: "name", Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); name != "" && len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be a valid DNS label",
		})
	}
	return fields
}

func validatePackageList(packages []string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	for i, p := range packages {
		if strings.TrimSpace(p) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("packages[%d]", i),
				Message: "must not be empty",
			})
		}
	}
	return fields
}

func validateMCPConnectionRefList(refs []gatewayapi.MCPConnectionRef, workspace bool) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	seen := map[gatewayapi.ResourceReference]int{}
	for i, ref := range refs {
		name := ref.Name
		if !workspace && ref.Scope != gatewayapi.ResourceScopeOrganisation {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].scope", i),
				Message: "workspace scope is not available in Organisation scope",
			})
			continue
		}
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: "must not be empty",
			})
			continue
		}
		key := gatewayapi.ResourceReference{Scope: ref.Scope, Name: name}
		if first, ok := seen[key]; ok {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: fmt.Sprintf("duplicate value %q first seen at index %d", name, first),
			})
			continue
		}
		seen[key] = i

		if len(ref.Tools) == 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].tools", i),
				Message: "must contain at least one tool",
			})
			continue
		}

		seenTools := map[string]int{}
		for toolIndex, tool := range ref.Tools {
			toolName := tool.Name
			if toolName == "" {
				fields = append(fields, gatewayapi.FieldError{
					Field:   fmt.Sprintf("mcp_connection_refs[%d].tools[%d].name", i, toolIndex),
					Message: "must not be empty",
				})
				continue
			}
			if firstToolIndex, ok := seenTools[toolName]; ok {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf(
						"mcp_connection_refs[%d].tools[%d].name",
						i,
						toolIndex,
					),
					Message: fmt.Sprintf(
						"duplicate value %q first seen at index %d",
						toolName,
						firstToolIndex,
					),
				})
				continue
			}
			seenTools[toolName] = toolIndex
		}
	}
	return fields
}

func (s *Service) validateSandboxMCPConnections(ctx context.Context, current string, refs []agentzv1alpha1.MCPConnectionRef) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	for i, ref := range refs {
		ns, err := scoperesolver.SelectedNamespace(ctx, s.k8sClient, current, scoperesolver.Selection{
			Scope: ref.Scope,
			Kind:  agentzv1alpha1.OrganizationResourceKindMCPConnection,
			Name:  ref.Name,
		})
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].scope", i),
				Message: "scope is not available from the selected Sandbox scope",
			})
			continue
		}
		conn := &agentzv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{
			Namespace: ns,
			Name:      ref.Name,
		}
		err = s.k8sClient.Get(ctx, key, conn)
		if apierrors.IsNotFound(err) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: fmt.Sprintf("mcp connection %q was not found", ref.Name),
			})
			continue
		}
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: fmt.Sprintf("failed to load mcp connection %q", ref.Name),
			})
			continue
		}
		if !conn.Status.ToolCatalogReady {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].tools", i),
				Message: fmt.Sprintf("mcp connection %q tool catalog is not ready", ref.Name),
			})
			continue
		}

		toolNames := make(map[string]struct{}, len(conn.Status.Tools))
		for _, tool := range conn.Status.Tools {
			toolName := strings.TrimSpace(tool.Name)
			if toolName == "" {
				continue
			}
			toolNames[toolName] = struct{}{}
		}
		for toolIndex, tool := range ref.Tools {
			toolName := tool.Name
			if _, ok := toolNames[toolName]; ok {
				continue
			}
			fields = append(fields, gatewayapi.FieldError{
				Field: fmt.Sprintf(
					"mcp_connection_refs[%d].tools[%d].name",
					i,
					toolIndex,
				),
				Message: fmt.Sprintf(
					"tool %q is not exposed by mcp connection %q",
					toolName,
					ref.Name,
				),
			})
		}
	}
	return fields
}

func (s *Service) validateSandboxDependencies(ctx context.Context, access resourceAccess, sandbox *agentzv1alpha1.Sandbox) ([]gatewayapi.FieldError, error) {
	fields := []gatewayapi.FieldError{}
	workspaceScope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	organizationScope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
	}
	allowsRead := func(scope agentzv1alpha1.ResourceScope, operation authorization.Operation) bool {
		if scope == agentzv1alpha1.ResourceScopeWorkspace {
			return access.workspaceID != "" && access.effective.Allows(workspaceScope, operation)
		}
		return access.effective.Allows(workspaceScope, operation) ||
			access.effective.Allows(organizationScope, operation)
	}
	for i, ref := range sandbox.Spec.Skills {
		if allowsRead(ref.Scope, authorization.OperationListSkills) {
			continue
		}
		fields = append(fields, gatewayapi.FieldError{
			Field:   fmt.Sprintf("skills[%d]", i),
			Message: "effective Skill read permission is required in the referenced scope",
		})
	}
	for i, ref := range sandbox.Spec.MCPConnectionRefs {
		if allowsRead(ref.Scope, authorization.OperationGetMCPConnection) {
			continue
		}
		fields = append(fields, gatewayapi.FieldError{
			Field:   fmt.Sprintf("mcp_connection_refs[%d]", i),
			Message: "effective MCP Connection read permission is required in the referenced scope",
		})
	}
	for i, ref := range sandbox.Spec.Inference.Models {
		ns, err := scoperesolver.Namespace(ctx, s.k8sClient, access.namespace, ref.Scope)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d].scope", i),
				Message: "scope is not available from the selected Sandbox scope",
			})
			continue
		}
		if ref.Provider == agentzv1alpha1.InferencePoolProvider {
			poolScope := organizationScope
			if ref.Scope == agentzv1alpha1.ResourceScopeWorkspace {
				poolScope = workspaceScope
			}
			if !access.effective.Allows(poolScope, authorization.OperationGetInferencePool) {
				fields = append(fields, gatewayapi.FieldError{
					Field:   fmt.Sprintf("inference.models[%d]", i),
					Message: "effective Inference Pool read permission is required in the referenced scope",
				})
				continue
			}
			pool := &agentzv1alpha1.InferencePool{}
			err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: ns, Name: ref.Model}, pool)
			if apierrors.IsNotFound(err) {
				fields = append(fields, gatewayapi.FieldError{
					Field:   fmt.Sprintf("inference.models[%d].model", i),
					Message: fmt.Sprintf("inference pool %q was not found", ref.Model),
				})
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("get inference pool %q: %w", ref.Model, err)
			}
			if !pool.DeletionTimestamp.IsZero() {
				fields = append(fields, gatewayapi.FieldError{
					Field:   fmt.Sprintf("inference.models[%d].model", i),
					Message: fmt.Sprintf("inference pool %q is being deleted", ref.Model),
				})
			}
			continue
		}
		ns, err = scoperesolver.SelectedNamespace(ctx, s.k8sClient, access.namespace, scoperesolver.Selection{
			Scope: ref.Scope,
			Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
			Name:  ref.Provider,
		})
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d].scope", i),
				Message: "inference provider is not selected in the referenced scope",
			})
			continue
		}
		if !allowsRead(ref.Scope, authorization.OperationGetInferenceProvider) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d]", i),
				Message: "effective Inference Provider read permission is required in the referenced scope",
			})
			continue
		}
		provider := &agentzv1alpha1.InferenceProvider{}
		err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: ns, Name: ref.Provider}, provider)
		if apierrors.IsNotFound(err) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d].provider", i),
				Message: fmt.Sprintf("inference provider %q was not found", ref.Provider),
			})
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("get inference provider %q: %w", ref.Provider, err)
		}
		if !provider.DeletionTimestamp.IsZero() {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d].provider", i),
				Message: fmt.Sprintf("inference provider %q is being deleted", ref.Provider),
			})
			continue
		}
		modelFound := false
		for _, model := range provider.Spec.Models {
			if model.ID == ref.Model {
				modelFound = true
				break
			}
		}
		if !modelFound {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("inference.models[%d].model", i),
				Message: fmt.Sprintf("model %q is not enabled by inference provider %q", ref.Model, ref.Provider),
			})
		}
	}
	return fields, nil
}

func writeAllowedHostsError(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"request validation failed",
		errBadRequest,
		gatewayapi.FieldError{
			Field:   "allowed_hosts",
			Message: err.Error(),
		},
	))
}
