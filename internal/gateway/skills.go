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
	"github.com/accuknox/agentz/internal/skill"
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

	items := make([]gatewayapi.Skill, 0, len(skillList.Items))
	for _, skill := range skillList.Items {
		if params.AgentName != nil {
			if _, ok := effective[skill.Name]; !ok {
				continue
			}
		}
		refs, err := s.skillReferences(r.Context(), ns, skill.Name)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		items = append(items, skillFromCRD(skill, refs))
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

	var rawAgents []gatewayapi.AgentName
	if req.Agents != nil {
		rawAgents = *req.Agents
	}
	agents, fields, err := s.validateSkillAgentRefs(r.Context(), ns, rawAgents)
	fields = append(fields, validateSkillName("name", req.Name)...)
	fields = append(fields, validateSkillSpec(req.Description, req.Version, req.StoragePath)...)
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
	if len(agents) > 0 {
		if err := s.setSkillAgentRefs(r.Context(), ns, req.Name, agents); err != nil {
			_ = s.k8sClient.Delete(r.Context(), skill)
			writeError(w, r, mapKubeHTTPError("attach skill", err))
			return
		}
	}

	refs, err := s.skillReferences(r.Context(), ns, skill.Name)
	if err != nil {
		writeInternalError(w, r, err)
		return
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
	fields = append(fields, validateUpdateSkillRequest(req)...)
	var agents []gatewayapi.AgentName
	if req.Agents != nil {
		var agentFields []gatewayapi.FieldError
		agents, agentFields, err = s.validateSkillAgentRefs(r.Context(), ns, *req.Agents)
		fields = append(fields, agentFields...)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
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

	var updated *agentzv1alpha1.Skill
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Name: skillName, Namespace: ns}
		if err := s.k8sClient.Get(r.Context(), key, current); err != nil {
			return err
		}
		if req.Version != nil {
			current.Spec.Version = *req.Version
			current.Spec.StoragePath = *req.StoragePath
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
	if req.Agents != nil {
		if err := s.setSkillAgentRefs(r.Context(), ns, skillName, agents); err != nil {
			writeError(w, r, mapKubeHTTPError("attach skill", err))
			return
		}
	}

	refs, err := s.skillReferences(r.Context(), ns, updated.Name)
	if err != nil {
		writeInternalError(w, r, err)
		return
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
	refs, err := s.skillReferences(r.Context(), ns, skill.Name)
	if err != nil {
		writeInternalError(w, r, err)
		return
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
		ModifiedAt:  skill.GetObjectMeta().GetCreationTimestamp().Time,
	}
}

func (s *Service) skillReferences(ctx context.Context, namespace string, skillName string) (gatewayapi.SkillReferences, error) {
	agents := &agentzv1alpha1.AgentList{}
	if err := s.k8sClient.List(ctx, agents, ctrlclient.InNamespace(namespace)); err != nil {
		return gatewayapi.SkillReferences{}, fmt.Errorf("list agents: %w", err)
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := s.k8sClient.List(ctx, sandboxes, ctrlclient.InNamespace(namespace)); err != nil {
		return gatewayapi.SkillReferences{}, fmt.Errorf("list sandboxes: %w", err)
	}

	sandboxRefs := map[string]struct{}{}
	sandboxNames := make([]gatewayapi.SandboxName, 0)
	for _, sandbox := range sandboxes.Items {
		if !slices.Contains(sandbox.Spec.Skills, skillName) {
			continue
		}
		sandboxRefs[sandbox.Name] = struct{}{}
		sandboxNames = append(sandboxNames, sandbox.Name)
	}

	agentNames := make([]gatewayapi.AgentName, 0)
	for _, agt := range agents.Items {
		referenced := slices.Contains(agt.Spec.Skills, skillName)
		if !referenced && agt.Spec.SandboxRef != nil {
			_, referenced = sandboxRefs[agt.Spec.SandboxRef.Name]
		}
		if referenced {
			agentNames = append(agentNames, agt.Name)
		}
	}
	slices.Sort(agentNames)
	slices.Sort(sandboxNames)
	return gatewayapi.SkillReferences{Agents: agentNames, Sandboxes: sandboxNames}, nil
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

func validateSkillSpec(description string, version int64, storagePath string) []gatewayapi.FieldError {
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
	if version < 1 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "version", Message: "must be at least 1",
		})
	}
	fields = append(fields, validateSkillStoragePath("storage_path", storagePath)...)
	return fields
}

func validateSkillStoragePath(field string, storagePath string) []gatewayapi.FieldError {
	if strings.TrimSpace(storagePath) == "" {
		return []gatewayapi.FieldError{{Field: field, Message: "required"}}
	}
	if _, _, err := skill.ParseStoragePath(storagePath); err != nil {
		return []gatewayapi.FieldError{{Field: field, Message: err.Error()}}
	}
	return nil
}

func validateUpdateSkillRequest(req gatewayapi.UpdateSkillRequest) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	if req.Version == nil && req.StoragePath != nil {
		fields = append(fields, gatewayapi.FieldError{
			Field: "version", Message: "required when storage_path is set",
		})
	}
	if req.Version != nil {
		if *req.Version < 1 {
			fields = append(fields, gatewayapi.FieldError{
				Field: "version", Message: "must be at least 1",
			})
		}
		if req.StoragePath == nil {
			fields = append(fields, gatewayapi.FieldError{
				Field: "storage_path", Message: "required when version is set",
			})
		} else {
			fields = append(fields, validateSkillStoragePath("storage_path", *req.StoragePath)...)
		}
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
		out = append(out, name)
	}
	return out, fields, nil
}

func (s *Service) validateSkillAgentRefs(ctx context.Context, namespace string, names []gatewayapi.AgentName) ([]gatewayapi.AgentName, []gatewayapi.FieldError, error) {
	out := make([]gatewayapi.AgentName, 0, len(names))
	fields := []gatewayapi.FieldError{}
	seen := map[string]int{}
	for i, name := range names {
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field: fmt.Sprintf("agents[%d]", i), Message: "required",
			})
			continue
		}
		if first, ok := seen[name]; ok {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("agents[%d]", i),
				Message: fmt.Sprintf("duplicate value %q first seen at index %d", name, first),
			})
			continue
		}
		seen[name] = i
		if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
			fields = append(fields, gatewayapi.FieldError{
				Field: "agents", Message: "must contain valid agent names",
			})
			continue
		}
		agt := &agentzv1alpha1.Agent{}
		key := types.NamespacedName{Name: name, Namespace: namespace}
		if err := s.k8sClient.Get(ctx, key, agt); err != nil {
			if apierrors.IsNotFound(err) {
				fields = append(fields, gatewayapi.FieldError{
					Field: fmt.Sprintf("agents[%d]", i), Message: "agent not found",
				})
				continue
			}
			return nil, nil, fmt.Errorf("get agent %q: %w", name, err)
		}
		out = append(out, name)
	}
	return out, fields, nil
}

func (s *Service) setSkillAgentRefs(ctx context.Context, namespace string, skillName string, names []gatewayapi.AgentName) error {
	targets := make(map[string]struct{}, len(names))
	for _, name := range names {
		targets[name] = struct{}{}
	}

	agents := &agentzv1alpha1.AgentList{}
	if err := s.k8sClient.List(ctx, agents, ctrlclient.InNamespace(namespace)); err != nil {
		return fmt.Errorf("list agents: %w", err)
	}
	for _, item := range agents.Items {
		_, wants := targets[item.Name]
		has := slices.Contains(item.Spec.Skills, skillName)
		if wants == has {
			continue
		}
		key := types.NamespacedName{Name: item.Name, Namespace: item.Namespace}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			agt := &agentzv1alpha1.Agent{}
			if err := s.k8sClient.Get(ctx, key, agt); err != nil {
				return err
			}
			if wants {
				if !slices.Contains(agt.Spec.Skills, skillName) {
					agt.Spec.Skills = append(agt.Spec.Skills, skillName)
					slices.Sort(agt.Spec.Skills)
				}
			}
			if !wants {
				agt.Spec.Skills = slices.DeleteFunc(append([]string{}, agt.Spec.Skills...), func(name string) bool {
					return name == skillName
				})
			}
			return s.k8sClient.Update(ctx, agt)
		})
		if err != nil {
			return fmt.Errorf("update agent %q skill refs: %w", item.Name, err)
		}
	}
	return nil
}

func skillsFromCRD(names []string) []gatewayapi.SkillName {
	out := make([]gatewayapi.SkillName, 0, len(names))
	out = append(out, names...)
	return out
}

func stringsFromSkillNames(names []gatewayapi.SkillName) []string {
	out := make([]string, 0, len(names))
	out = append(out, names...)
	return out
}
