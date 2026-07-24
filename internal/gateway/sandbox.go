package gateway

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListSandboxes handles GET /api/sandbox.
func (s *Service) ListSandboxes(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSandboxesParams) {
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

	var sandboxList agentzv1alpha1.SandboxList
	if err := s.k8sClient.List(r.Context(), &sandboxList, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list sandboxes: %w", err))
		return
	}
	refs, err := sandboxutil.ReferencedNames(
		r.Context(),
		s.k8sClient,
		ns,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list sandbox references: %w", err))
		return
	}

	items := make([]gatewayapi.Sandbox, 0, len(sandboxList.Items))
	for _, sb := range sandboxList.Items {
		items = append(items, sandboxFromCRD(sb, refs[sb.Name]))
	}

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

// CreateSandbox handles POST /api/sandbox.
func (s *Service) CreateSandbox(w http.ResponseWriter, r *http.Request) {
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

	var req gatewayapi.CreateSandboxRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, fields := validateCreateSandboxRequest(req)
	var rawSkills []gatewayapi.SkillName
	if req.Skills != nil {
		rawSkills = *req.Skills
	}
	skills, skillFields, err := s.validateSkillRefs(r.Context(), ns, rawSkills)
	fields = append(fields, skillFields...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
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
		host, err := sandboxutil.ParseHost(entry)
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
		tools := make([]agentzv1alpha1.SandboxMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := strings.TrimSpace(rawTool.Name)
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.SandboxMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		mcpConnectionRefs = append(mcpConnectionRefs, agentzv1alpha1.MCPConnectionRef{
			Name:  name,
			Tools: tools,
		})
	}
	fields = s.validateSandboxMCPConnections(r.Context(), mcpConnectionRefs)
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

	sandbox := &agentzv1alpha1.Sandbox{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Sandbox",
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
		Spec: agentzv1alpha1.SandboxSpec{
			Packages:          packages,
			AllowedHosts:      allowedHosts,
			MCPConnectionRefs: mcpConnectionRefs,
			Skills:            slices.Clone(skills),
			Inference:         sandboxInferenceFromAPI(req.Inference),
		},
	}

	if err := s.k8sClient.Create(r.Context(), sandbox); err != nil {
		writeError(w, r, mapKubeHTTPError("create sandbox", err))
		return
	}

	writeJSON(w, http.StatusCreated, sandboxFromCRD(*sandbox, false))
}

// DeleteSandbox handles DELETE /api/sandbox/{sandboxName}.
func (s *Service) DeleteSandbox(w http.ResponseWriter, r *http.Request, sandboxName gatewayapi.SandboxName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

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

	sandbox := &agentzv1alpha1.Sandbox{}
	sandbox.Name = name
	sandbox.Namespace = ns
	agentNames, err := sandboxutil.ReferencingAgentNames(
		r.Context(),
		s.usageReader,
		ns,
		name,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("check sandbox references: %w", err))
		return
	}
	if len(agentNames) > 0 {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"sandbox_referenced",
			"sandbox is referenced by agent "+agentNames[0],
			errBadRequest,
		))
		return
	}

	if err := s.k8sClient.Delete(r.Context(), sandbox); err != nil {
		writeError(w, r, mapKubeHTTPError("delete sandbox", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateSandbox handles PUT /api/sandbox/{sandboxName}.
func (s *Service) UpdateSandbox(w http.ResponseWriter, r *http.Request, sandboxName gatewayapi.SandboxName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateSandboxRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := validateUpdateSandboxRequest(req)
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

	name := strings.TrimSpace(sandboxName)
	allowedHosts := make([]string, 0, len(req.AllowedHosts))
	seenHosts := make(map[string]struct{}, len(req.AllowedHosts))
	for i, entry := range req.AllowedHosts {
		host, err := sandboxutil.ParseHost(entry)
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
		tools := make([]agentzv1alpha1.SandboxMCPTool, 0, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := strings.TrimSpace(rawTool.Name)
			if toolName == "" {
				continue
			}
			tools = append(tools, agentzv1alpha1.SandboxMCPTool{
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
	skills, skillFields, err := s.validateSkillRefs(r.Context(), ns, req.Skills)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	fields = append(fields, skillFields...)
	fields = append(fields, s.validateSandboxMCPConnections(r.Context(), mcpConnectionRefs)...)
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

	var updated *agentzv1alpha1.Sandbox
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		sandbox := &agentzv1alpha1.Sandbox{}
		if getErr := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{
			Name:      name,
			Namespace: ns,
		}, sandbox); getErr != nil {
			return getErr
		}

		sandbox.Spec.Packages = packages
		sandbox.Spec.AllowedHosts = allowedHosts
		sandbox.Spec.MCPConnectionRefs = mcpConnectionRefs
		sandbox.Spec.Skills = slices.Clone(skills)
		sandbox.Spec.Inference = sandboxInferenceFromAPI(req.Inference)

		if updateErr := s.k8sClient.Update(r.Context(), sandbox); updateErr != nil {
			return updateErr
		}
		updated = sandbox
		return nil
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update sandbox", err))
		return
	}

	agentNames, err := sandboxutil.ReferencingAgentNames(
		r.Context(),
		s.usageReader,
		ns,
		updated.Name,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("check sandbox references: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, sandboxFromCRD(*updated, len(agentNames) > 0))
}

func sandboxFromCRD(sb agentzv1alpha1.Sandbox, referenced bool) gatewayapi.Sandbox {
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
				Name:  ref.Name,
				Tools: tools,
			})
		}
	}
	out := gatewayapi.Sandbox{
		Name:              sb.Name,
		Packages:          packages,
		AllowedHosts:      allowedHosts,
		McpConnectionRefs: mcpConnectionRefs,
		Skills:            append([]gatewayapi.SkillName{}, sb.Spec.Skills...),
		CreatedAt:         sb.CreationTimestamp.Time,
		Inference:         sandboxInferenceToAPI(sb.Spec.Inference),
	}
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
			Provider: model.Provider,
			Model:    model.Model,
		})
	}
	out := agentzv1alpha1.SandboxInference{
		Models: models,
		DefaultModel: agentzv1alpha1.InferenceModelRef{
			Provider: value.DefaultModel.Provider,
			Model:    value.DefaultModel.Model,
		},
	}
	if value.SmallModel != nil {
		out.SmallModel = &agentzv1alpha1.InferenceModelRef{
			Provider: value.SmallModel.Provider,
			Model:    value.SmallModel.Model,
		}
	}
	return out
}

func sandboxInferenceToAPI(value agentzv1alpha1.SandboxInference) gatewayapi.SandboxInference {
	models := make([]gatewayapi.SandboxInferenceModelRef, 0, len(value.Models))
	for _, model := range value.Models {
		models = append(models, gatewayapi.SandboxInferenceModelRef{
			Provider: model.Provider,
			Model:    model.Model,
		})
	}
	out := gatewayapi.SandboxInference{
		Models: models,
		DefaultModel: gatewayapi.SandboxInferenceModelRef{
			Provider: value.DefaultModel.Provider,
			Model:    value.DefaultModel.Model,
		},
	}
	if value.SmallModel != nil {
		out.SmallModel = &gatewayapi.SandboxInferenceModelRef{
			Provider: value.SmallModel.Provider,
			Model:    value.SmallModel.Model,
		}
	}
	return out
}

func validateCreateSandboxRequest(req gatewayapi.CreateSandboxRequest) (string, []gatewayapi.FieldError) {
	name := strings.TrimSpace(req.Name)
	fields := validateSandboxName(name)
	if req.Packages != nil {
		fields = append(fields, validatePackageList(*req.Packages)...)
	}
	if req.McpConnectionRefs != nil {
		fields = append(fields, validateMCPConnectionRefList(*req.McpConnectionRefs)...)
	}
	return name, fields
}

func validateUpdateSandboxRequest(req gatewayapi.UpdateSandboxRequest) []gatewayapi.FieldError {
	fields := validatePackageList(req.Packages)
	fields = append(fields, validateMCPConnectionRefList(req.McpConnectionRefs)...)
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

func (s *Service) validateSandboxMCPConnections(ctx context.Context, refs []agentzv1alpha1.MCPConnectionRef) []gatewayapi.FieldError {
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
