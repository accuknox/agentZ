package gateway

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	skillpkg "github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListSkills handles GET /api/skill.
func (s *Service) ListSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSkillsParams) {
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

	effective := map[string]struct{}{}
	if params.AgentName != nil {
		name, ok := validAgentName(w, r, *params.AgentName, "agent_name")
		if !ok {
			return
		}
		effective, err = s.effectiveAgentSkills(r.Context(), ns, name)
		if err != nil {
			writeError(w, r, mapKubeHTTPError("get agent skills", err))
			return
		}
	}

	skillList := &agentzv1alpha1.SkillList{}
	if err := s.k8sClient.List(r.Context(), skillList, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list skills: %w", err))
		return
	}
	slices.SortFunc(skillList.Items, func(a, b agentzv1alpha1.Skill) int {
		return strings.Compare(a.Name, b.Name)
	})
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.Skill, 0, len(skillList.Items))
	for _, item := range skillList.Items {
		if params.AgentName != nil {
			if _, ok := effective[item.Name]; !ok {
				continue
			}
		}
		refs, ok := refsBySkill[item.Name]
		if !ok {
			refs = gatewayapi.SkillReferences{
				Agents:    []gatewayapi.AgentName{},
				Sandboxes: []gatewayapi.SandboxName{},
			}
		}
		items = append(items, skillFromCRD(item, refs))
	}

	start := min(offset, len(items))
	end := min(start+limit, len(items))
	page := items[start:end]
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListSkillsResponse{
		Skills:        page,
		NextPageToken: next,
	})
}

// CreateSkill handles POST /api/skill.
func (s *Service) CreateSkill(w http.ResponseWriter, r *http.Request) {
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

	var req gatewayapi.CreateSkillRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := validateSkillName("name", req.Name)
	fields = append(fields, validateSkillSpec(
		ns, req.Name, req.Description, req.Version, req.StoragePath,
	)...)
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

	skill := &agentzv1alpha1.Skill{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Skill",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: ns,
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					tenant,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
				),
			},
		},
		Spec: agentzv1alpha1.SkillSpec{
			Description: req.Description,
			Version:     req.Version,
			StoragePath: req.StoragePath,
		},
	}
	if err := s.k8sClient.Create(r.Context(), skill); err != nil {
		writeError(w, r, mapKubeHTTPError("create skill", err))
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := refsBySkill[skill.Name]
	if refs.Agents == nil {
		refs.Agents = []gatewayapi.AgentName{}
	}
	if refs.Sandboxes == nil {
		refs.Sandboxes = []gatewayapi.SandboxName{}
	}
	writeJSON(w, http.StatusCreated, skillFromCRD(*skill, refs))
}

// UpdateSkill handles PUT /api/skill/{skillName}.
func (s *Service) UpdateSkill(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateSkillRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := validateSkillName("skillName", skillName)
	if req.Version < 1 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "version", Message: "must be at least 1",
		})
	}
	if req.Description != nil {
		fields = append(fields, validateSkillDescription(*req.Description)...)
	}
	fields = append(fields, validateSkillStoragePath(
		"storage_path", ns, skillName, req.Version, req.StoragePath,
	)...)
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

	var updated *agentzv1alpha1.Skill
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Name: skillName, Namespace: ns}
		if err := s.k8sClient.Get(r.Context(), key, current); err != nil {
			return err
		}
		current.Spec.Version = req.Version
		current.Spec.StoragePath = req.StoragePath
		if req.Description != nil {
			current.Spec.Description = *req.Description
		}
		if err := s.k8sClient.Update(r.Context(), current); err != nil {
			return err
		}
		updated = current
		return nil
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update skill", err))
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := refsBySkill[updated.Name]
	if refs.Agents == nil {
		refs.Agents = []gatewayapi.AgentName{}
	}
	if refs.Sandboxes == nil {
		refs.Sandboxes = []gatewayapi.SandboxName{}
	}
	writeJSON(w, http.StatusOK, skillFromCRD(*updated, refs))
}

// DeleteSkill handles DELETE /api/skill/{skillName}.
func (s *Service) DeleteSkill(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if fields := validateSkillName("skillName", skillName); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	skill := &agentzv1alpha1.Skill{}
	skill.Name = skillName
	skill.Namespace = ns
	if err := s.k8sClient.Delete(r.Context(), skill); err != nil {
		writeError(w, r, mapKubeHTTPError("delete skill", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetSkillReferences handles GET /api/skill/{skillName}/references.
func (s *Service) GetSkillReferences(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if fields := validateSkillName("skillName", skillName); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	skill := &agentzv1alpha1.Skill{}
	key := types.NamespacedName{Name: skillName, Namespace: ns}
	if err := s.k8sClient.Get(r.Context(), key, skill); err != nil {
		writeError(w, r, mapKubeHTTPError("get skill", err))
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := refsBySkill[skill.Name]
	if refs.Agents == nil {
		refs.Agents = []gatewayapi.AgentName{}
	}
	if refs.Sandboxes == nil {
		refs.Sandboxes = []gatewayapi.SandboxName{}
	}
	writeJSON(w, http.StatusOK, refs)
}

func skillFromCRD(skill agentzv1alpha1.Skill, refs gatewayapi.SkillReferences) gatewayapi.Skill {
	return gatewayapi.Skill{
		Name:        skill.Name,
		Description: skill.Spec.Description,
		Version:     skill.Spec.Version,
		StoragePath: skill.Spec.StoragePath,
		Agents:      refs.Agents,
		Sandboxes:   refs.Sandboxes,
		CreatedAt:   skill.CreationTimestamp.Time,
	}
}

func (s *Service) listSkillReferences(ctx context.Context, namespace string) (map[string]gatewayapi.SkillReferences, error) {
	agents := &agentzv1alpha1.AgentList{}
	if err := s.k8sClient.List(ctx, agents, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := s.k8sClient.List(ctx, sandboxes, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list sandboxes: %w", err)
	}

	sandboxSkills := make(map[string][]string, len(sandboxes.Items))
	agentRefs := map[string]map[string]struct{}{}
	sandboxRefs := map[string]map[string]struct{}{}
	for _, sandbox := range sandboxes.Items {
		sandboxSkills[sandbox.Name] = sandbox.Spec.Skills
		for _, name := range sandbox.Spec.Skills {
			if sandboxRefs[name] == nil {
				sandboxRefs[name] = map[string]struct{}{}
			}
			sandboxRefs[name][sandbox.Name] = struct{}{}
		}
	}

	for _, agt := range agents.Items {
		names := append([]string{}, agt.Spec.Skills...)
		if agt.Spec.SandboxRef != nil {
			names = append(names, sandboxSkills[agt.Spec.SandboxRef.Name]...)
		}
		for _, name := range names {
			if agentRefs[name] == nil {
				agentRefs[name] = map[string]struct{}{}
			}
			agentRefs[name][agt.Name] = struct{}{}
		}
	}

	refs := make(map[string]gatewayapi.SkillReferences, len(agentRefs)+len(sandboxRefs))
	for name, items := range agentRefs {
		names := make([]gatewayapi.AgentName, 0, len(items))
		for item := range items {
			names = append(names, item)
		}
		slices.Sort(names)
		refs[name] = gatewayapi.SkillReferences{
			Agents: names, Sandboxes: []gatewayapi.SandboxName{},
		}
	}
	for name, items := range sandboxRefs {
		names := make([]gatewayapi.SandboxName, 0, len(items))
		for item := range items {
			names = append(names, item)
		}
		slices.Sort(names)
		ref := refs[name]
		if ref.Agents == nil {
			ref.Agents = []gatewayapi.AgentName{}
		}
		ref.Sandboxes = names
		refs[name] = ref
	}
	return refs, nil
}

func (s *Service) effectiveAgentSkills(ctx context.Context, namespace string, agentName string) (map[string]struct{}, error) {
	agt := &agentzv1alpha1.Agent{}
	key := types.NamespacedName{Name: agentName, Namespace: namespace}
	if err := s.k8sClient.Get(ctx, key, agt); err != nil {
		return nil, err
	}
	out := make(map[string]struct{}, len(agt.Spec.Skills))
	for _, name := range agt.Spec.Skills {
		out[name] = struct{}{}
	}
	if agt.Spec.SandboxRef == nil {
		return out, nil
	}
	sandbox := &agentzv1alpha1.Sandbox{}
	key = types.NamespacedName{Name: agt.Spec.SandboxRef.Name, Namespace: namespace}
	if err := s.k8sClient.Get(ctx, key, sandbox); err != nil {
		return nil, err
	}
	for _, name := range sandbox.Spec.Skills {
		out[name] = struct{}{}
	}
	return out, nil
}

func validateSkillName(field string, name string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if name == "" {
		fields = append(fields, gatewayapi.FieldError{Field: field, Message: "required"})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: field, Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); name != "" && len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: field, Message: "must be a valid DNS label",
		})
	}
	return fields
}

func validateSkillSpec(namespace, name, description string, version int64, storagePath string) []gatewayapi.FieldError {
	fields := validateSkillDescription(description)
	if version < 1 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "version", Message: "must be at least 1",
		})
	}
	fields = append(fields, validateSkillStoragePath(
		"storage_path", namespace, name, version, storagePath,
	)...)
	return fields
}

func validateSkillStoragePath(field, namespace, name string, version int64, storagePath string) []gatewayapi.FieldError {
	bucket, _, err := skillpkg.ParseStoragePath(storagePath)
	if err != nil {
		return []gatewayapi.FieldError{{Field: field, Message: err.Error()}}
	}
	expected := (skillpkg.Config{Bucket: bucket}).StoragePath(namespace, name, version)
	if storagePath != expected {
		return []gatewayapi.FieldError{{
			Field: field, Message: "must match the skill namespace, name, and version",
		}}
	}
	return nil
}

func validateSkillDescription(description string) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if strings.TrimSpace(description) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field: "description", Message: "required",
		})
	}
	if len(description) > 1024 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "description", Message: "must be at most 1024 characters",
		})
	}
	return fields
}

func (s *Service) validateSkillRefs(ctx context.Context, namespace string, names []gatewayapi.SkillName) ([]gatewayapi.SkillName, []gatewayapi.FieldError, error) {
	out := make([]gatewayapi.SkillName, 0, len(names))
	fields := []gatewayapi.FieldError{}
	seen := map[string]int{}
	for i, name := range names {
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field: fmt.Sprintf("skills[%d]", i), Message: "required",
			})
			continue
		}
		if first, ok := seen[name]; ok {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("skills[%d]", i),
				Message: fmt.Sprintf("duplicate value %q first seen at index %d", name, first),
			})
			continue
		}
		seen[name] = i
		itemFields := validateSkillName(fmt.Sprintf("skills[%d]", i), name)
		fields = append(fields, itemFields...)
		if len(itemFields) > 0 {
			continue
		}
		skill := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Name: name, Namespace: namespace}
		if err := s.k8sClient.Get(ctx, key, skill); err != nil {
			if apierrors.IsNotFound(err) {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf("skills[%d]", i), Message: "skill not found",
				})
				continue
			}
			return nil, nil, fmt.Errorf("get skill %q: %w", name, err)
		}
		if !skill.DeletionTimestamp.IsZero() {
			fields = append(fields, gatewayapi.FieldError{
				Field: fmt.Sprintf("skills[%d]", i), Message: "skill is being deleted",
			})
			continue
		}
		out = append(out, name)
	}
	return out, fields, nil
}
