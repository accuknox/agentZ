package gateway

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/envutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListEnvironments handles GET /api/environment.
func (s *Service) ListEnvironments(w http.ResponseWriter, r *http.Request, params gatewayapi.ListEnvironmentsParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
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

	var envList agentzv1alpha1.EnvironmentList
	if err := s.k8sClient.List(r.Context(), &envList, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list environments: %w", err))
		return
	}
	refs, err := envutil.ReferencedNames(
		r.Context(),
		s.k8sClient,
		ns,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list environment references: %w", err))
		return
	}

	items := make([]gatewayapi.Environment, 0, len(envList.Items))
	for _, env := range envList.Items {
		items = append(items, environmentFromCRD(env, refs[env.Name]))
	}

	start := min(offset, len(items))
	end := min(start+limit, len(items))

	page := items[start:end]
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListEnvironmentsResponse{
		Environments:  page,
		NextPageToken: next,
	})
}

// CreateEnvironment handles POST /api/environment.
func (s *Service) CreateEnvironment(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.CreateEnvironmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, fields := validateCreateEnvironmentRequest(req)
	if len(fields) > 0 {
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
		host, err := envutil.ParseHost(entry)
		if err != nil {
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
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			continue
		}
		tools := make([]agentzv1alpha1.EnvironmentMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := strings.TrimSpace(rawTool.Name)
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.EnvironmentMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		mcpConnectionRefs = append(mcpConnectionRefs, agentzv1alpha1.MCPConnectionRef{
			Name:  name,
			Tools: tools,
		})
	}
	fields = s.validateEnvironmentMCPConnections(r.Context(), mcpConnectionRefs)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	env := &agentzv1alpha1.Environment{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Environment",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					tenant,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
				),
			},
		},
		Spec: agentzv1alpha1.EnvironmentSpec{
			Packages:          packages,
			AllowedHosts:      allowedHosts,
			MCPConnectionRefs: mcpConnectionRefs,
		},
	}

	if err := s.k8sClient.Create(r.Context(), env); err != nil {
		writeError(w, r, mapKubeHTTPError("create environment", err))
		return
	}

	writeJSON(w, http.StatusCreated, environmentFromCRD(*env, false))
}

// DeleteEnvironment handles DELETE /api/environment/{environmentName}.
func (s *Service) DeleteEnvironment(w http.ResponseWriter, r *http.Request, environmentName gatewayapi.EnvironmentName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	name := strings.TrimSpace(environmentName)
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

	env := &agentzv1alpha1.Environment{}
	env.Name = name
	env.Namespace = ns
	agentName, err := envutil.ReferencingAgentName(
		r.Context(),
		s.k8sClient,
		ns,
		name,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("check environment references: %w", err))
		return
	}
	if agentName != "" {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"environment_referenced",
			"environment is referenced by agent "+agentName,
			errBadRequest,
		))
		return
	}

	if err := s.k8sClient.Delete(r.Context(), env); err != nil {
		writeError(w, r, mapKubeHTTPError("delete environment", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateEnvironment handles PUT /api/environment/{environmentName}.
func (s *Service) UpdateEnvironment(w http.ResponseWriter, r *http.Request, environmentName gatewayapi.EnvironmentName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateEnvironmentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := validateUpdateEnvironmentRequest(req)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	envName := strings.TrimSpace(environmentName)
	allowedHosts := make([]string, 0, len(req.AllowedHosts))
	seenHosts := make(map[string]struct{}, len(req.AllowedHosts))
	for i, entry := range req.AllowedHosts {
		host, err := envutil.ParseHost(entry)
		if err != nil {
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
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			continue
		}
		tools := make([]agentzv1alpha1.EnvironmentMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := strings.TrimSpace(rawTool.Name)
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.EnvironmentMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		mcpConnectionRefs = append(mcpConnectionRefs, agentzv1alpha1.MCPConnectionRef{
			Name:  name,
			Tools: tools,
		})
	}
	packages := req.Packages
	fields = s.validateEnvironmentMCPConnections(r.Context(), mcpConnectionRefs)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	var updated *agentzv1alpha1.Environment
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		env := &agentzv1alpha1.Environment{}
		if getErr := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{
			Name:      envName,
			Namespace: ns,
		}, env); getErr != nil {
			return getErr
		}

		env.Spec.Packages = packages
		env.Spec.AllowedHosts = allowedHosts
		env.Spec.MCPConnectionRefs = mcpConnectionRefs

		if updateErr := s.k8sClient.Update(r.Context(), env); updateErr != nil {
			return updateErr
		}
		updated = env
		return nil
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update environment", err))
		return
	}

	agentName, err := envutil.ReferencingAgentName(
		r.Context(),
		s.k8sClient,
		ns,
		updated.Name,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("check environment references: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, environmentFromCRD(*updated, agentName != ""))
}

func environmentFromCRD(env agentzv1alpha1.Environment, referenced bool) gatewayapi.Environment {
	packages := []string{}
	if env.Spec.Packages != nil {
		packages = env.Spec.Packages
	}
	allowedHosts := []string{}
	if env.Spec.AllowedHosts != nil {
		allowedHosts = env.Spec.AllowedHosts
	}
	mcpConnectionRefs := []gatewayapi.MCPConnectionRef{}
	if env.Spec.MCPConnectionRefs != nil {
		mcpConnectionRefs = make([]gatewayapi.MCPConnectionRef, 0, len(env.Spec.MCPConnectionRefs))
		for _, ref := range env.Spec.MCPConnectionRefs {
			tools := make([]gatewayapi.MCPConnectionToolRef, 0, len(ref.Tools))
			for _, tool := range ref.Tools {
				tools = append(tools, gatewayapi.MCPConnectionToolRef{
					Name:           tool.Name,
					RequireConsent: tool.RequireConsent,
				})
			}
			mcpConnectionRefs = append(mcpConnectionRefs, gatewayapi.MCPConnectionRef{
				Name:  ref.Name,
				Tools: tools,
			})
		}
	}
	out := gatewayapi.Environment{
		Name:              env.Name,
		Packages:          packages,
		AllowedHosts:      allowedHosts,
		McpConnectionRefs: mcpConnectionRefs,
		CreatedAt:         env.CreationTimestamp.Time,
	}
	out.Metadata.PackageCount = int32(len(packages))
	out.Metadata.AllowedHostCount = int32(len(allowedHosts))
	out.Metadata.ReferencedByAgent = referenced
	return out
}

func validateCreateEnvironmentRequest(req gatewayapi.CreateEnvironmentRequest) (string, []gatewayapi.FieldError) {
	name := strings.TrimSpace(req.Name)
	fields := validateEnvironmentName(name)
	if req.Packages != nil {
		fields = append(fields, validatePackageList(*req.Packages)...)
	}
	if req.McpConnectionRefs != nil {
		fields = append(fields, validateMCPConnectionRefList(*req.McpConnectionRefs)...)
	}
	return name, fields
}

func validateUpdateEnvironmentRequest(req gatewayapi.UpdateEnvironmentRequest) []gatewayapi.FieldError {
	fields := validatePackageList(req.Packages)
	fields = append(fields, validateMCPConnectionRefList(req.McpConnectionRefs)...)
	return fields
}

func validateEnvironmentName(name string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: "name", Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "name", Message: "must be at most 32 characters",
		})
	}
	if name != "" {
		if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field: "name", Message: "must be a valid DNS label",
			})
		}
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

func validateMCPConnectionRefList(refs []gatewayapi.MCPConnectionRef) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	seen := map[string]int{}
	for i, ref := range refs {
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: "must not be empty",
			})
			continue
		}
		if first, ok := seen[name]; ok {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].name", i),
				Message: fmt.Sprintf("duplicate value %q first seen at index %d", name, first),
			})
			continue
		}
		seen[name] = i

		if len(ref.Tools) == 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("mcp_connection_refs[%d].tools", i),
				Message: "must contain at least one tool",
			})
			continue
		}

		seenTools := map[string]int{}
		for toolIndex, tool := range ref.Tools {
			toolName := strings.TrimSpace(tool.Name)
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

func (s *Service) validateEnvironmentMCPConnections(ctx context.Context, refs []agentzv1alpha1.MCPConnectionRef) []gatewayapi.FieldError {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return []gatewayapi.FieldError{{
			Field:   "mcp_connection_refs",
			Message: "tenant context is missing",
		}}
	}

	fields := []gatewayapi.FieldError{}
	for i, ref := range refs {
		conn := &agentzv1alpha1.MCPConnection{}
		key := ctrlclient.ObjectKey{
			Namespace: ns,
			Name:      ref.Name,
		}
		err := s.k8sClient.Get(ctx, key, conn)
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
