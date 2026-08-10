package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime/multipart"
	"net/http"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/scoperesolver"
	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) resolveSkillAccess(ctx context.Context, workspaceID, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	req := resourceAccessRequest{
		resource:    "Skill",
		workspaceID: workspaceID,
		operation:   operation,
	}
	if name != "" && (operation == authorization.OperationUpdateSkill || operation == authorization.OperationDeleteSkill) {
		req.creatorFallback = authorization.OperationCreateSkill
		req.isCreator = func(ctx context.Context, namespace, userID string) (bool, error) {
			item := &agentzv1alpha1.Skill{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name, Namespace: namespace}, item)
			return item.Spec.CreatorUserID == userID, err
		}
	}
	return s.resolveResourceAccess(ctx, req)
}

func (s *Service) createSkillAudit(ctx context.Context, r *http.Request, access resourceAccess, name string, result gatewaydb.AuditResult) error {
	action := "unmapped"
	switch access.operation {
	case authorization.OperationCreateSkill:
		action = "create"
	case authorization.OperationUpdateSkill:
		action = "modify"
	case authorization.OperationDeleteSkill:
		action = "delete"
	}
	return s.createResourceAudit(
		ctx, r, access, gatewaydb.AuditTargetSkill, name, "skill", action, result,
	)
}

// ListSkills handles GET /api/skill.
func (s *Service) ListSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSkillsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	var err error

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
		items = append(items, skillFromCRD(item, refsBySkill[item.Name], access))
	}
	if workspaceID != "" {
		organizationItems, err := s.listInheritedSkills(r.Context(), access, effective)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		items = append(items, organizationItems...)
	}
	slices.SortFunc(items, func(a, b gatewayapi.Skill) int {
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

	writeJSON(w, http.StatusOK, gatewayapi.ListSkillsResponse{
		Skills:        page,
		NextPageToken: next,
	})
}

func (s *Service) listInheritedSkills(ctx context.Context, access resourceAccess, effective map[string]struct{}) ([]gatewayapi.Skill, error) {
	selected, err := s.selectedOrganizationResourceNames(
		ctx,
		access.workspaceID,
		access.claims.OrganizationID,
		agentzv1alpha1.OrganizationResourceKindSkill,
	)
	if err != nil {
		return nil, err
	}
	if len(selected) == 0 {
		return []gatewayapi.Skill{}, nil
	}
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		access.claims.OrganizationID,
	)
	skills := &agentzv1alpha1.SkillList{}
	if err := s.k8sClient.List(ctx, skills, ctrlclient.InNamespace(organizationNamespace)); err != nil {
		return nil, fmt.Errorf("list inherited Organisation Skills: %w", err)
	}
	items := make([]gatewayapi.Skill, 0, len(skills.Items))
	organizationAccess := access
	organizationAccess.workspaceID = ""
	for _, item := range skills.Items {
		if _, ok := selected[item.Name]; !ok {
			continue
		}
		if effective != nil {
			if _, ok := effective[item.Name]; !ok {
				continue
			}
		}
		skill := skillFromCRD(item, gatewayapi.SkillReferences{}, organizationAccess)
		skill.CanModify = false
		skill.CanDelete = false
		items = append(items, skill)
	}
	return items, nil
}

// CreateSkill handles POST /api/skill.
func (s *Service) CreateSkill(w http.ResponseWriter, r *http.Request, params gatewayapi.CreateSkillParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	var req gatewayapi.CreateSkillRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationCreateSkill)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSkillAudit(r.Context(), r, access, req.Name, access.failureResult())
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

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
			Name:            req.Name,
			Namespace:       ns,
			OwnerReferences: []metav1.OwnerReference{access.owner},
		},
		Spec: agentzv1alpha1.SkillSpec{
			CreatorUserID: access.claims.UserID,
			Description:   req.Description,
			Version:       req.Version,
			StoragePath:   req.StoragePath,
		},
	}
	if err := s.k8sClient.Create(r.Context(), skill); err != nil {
		auditErr := s.createSkillAudit(r.Context(), r, access, req.Name, gatewaydb.AuditResultFailed)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("create skill", err))
		return
	}
	if err := s.createSkillAudit(r.Context(), r, access, req.Name, gatewaydb.AuditResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := refsBySkill[skill.Name]
	writeJSON(w, http.StatusCreated, skillFromCRD(*skill, refs, access))
}

// UpdateSkill handles PUT /api/skill/{skillName}.
func (s *Service) UpdateSkill(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath, params gatewayapi.UpdateSkillParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, skillName, authorization.OperationUpdateSkill)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSkillAudit(r.Context(), r, access, skillName, access.failureResult())
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace

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
	_, err := s.skillStore.VersionSummary(r.Context(), ns, skillName, req.Version)
	if errors.Is(err, fs.ErrNotExist) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "immutable skill version not found", err))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("inspect immutable skill version: %w", err))
		return
	}
	storagePath := s.cfg.SkillStore.StoragePath(ns, skillName, req.Version)

	var updated *agentzv1alpha1.Skill
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Name: skillName, Namespace: ns}
		if err := s.k8sClient.Get(r.Context(), key, current); err != nil {
			return err
		}
		current.Spec.Version = req.Version
		current.Spec.StoragePath = storagePath
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
		auditErr := s.createSkillAudit(r.Context(), r, access, skillName, gatewaydb.AuditResultFailed)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("update skill", err))
		return
	}
	if err := s.createSkillAudit(r.Context(), r, access, skillName, gatewaydb.AuditResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := refsBySkill[updated.Name]
	writeJSON(w, http.StatusOK, skillFromCRD(*updated, refs, access))
}

// DeleteSkill handles DELETE /api/skill/{skillName}.
func (s *Service) DeleteSkill(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath, params gatewayapi.DeleteSkillParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, skillName, authorization.OperationDeleteSkill)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSkillAudit(r.Context(), r, access, skillName, access.failureResult())
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
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
	conflict, err := s.selectedOrganizationResourceConflict(
		r.Context(), access, agentzv1alpha1.OrganizationResourceKindSkill, skillName,
	)
	if err != nil || conflict != nil {
		auditErr := s.createSkillAudit(r.Context(), r, access, skillName, gatewaydb.AuditResultFailed)
		if err != nil || auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, conflict)
		return
	}

	skill := &agentzv1alpha1.Skill{}
	skill.Name = skillName
	skill.Namespace = ns
	if err := s.k8sClient.Delete(r.Context(), skill); err != nil {
		auditErr := s.createSkillAudit(r.Context(), r, access, skillName, gatewaydb.AuditResultFailed)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete skill", err))
		return
	}
	if err := s.createSkillAudit(r.Context(), r, access, skillName, gatewaydb.AuditResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetSkillReferences handles GET /api/skill/{skillName}/references.
func (s *Service) GetSkillReferences(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath, params gatewayapi.GetSkillReferencesParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
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
	refs := skillReferencesOrEmpty(refsBySkill[skill.Name])
	writeJSON(w, http.StatusOK, refs)
}

func skillFromCRD(skill agentzv1alpha1.Skill, refs gatewayapi.SkillReferences, access resourceAccess) gatewayapi.Skill {
	refs = skillReferencesOrEmpty(refs)
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	creator := skill.Spec.CreatorUserID == access.claims.UserID &&
		access.effective.Allows(scope, authorization.OperationCreateSkill)
	return gatewayapi.Skill{
		Scope:       resourceScope(access.workspaceID),
		Name:        skill.Name,
		CanModify:   access.effective.Allows(scope, authorization.OperationUpdateSkill) || creator,
		CanDelete:   access.effective.Allows(scope, authorization.OperationDeleteSkill) || creator,
		Description: skill.Spec.Description,
		Version:     skill.Spec.Version,
		StoragePath: skill.Spec.StoragePath,
		Agents:      refs.Agents,
		Sandboxes:   refs.Sandboxes,
		CreatedAt:   skill.CreationTimestamp.Time,
	}
}

func skillReferencesOrEmpty(refs gatewayapi.SkillReferences) gatewayapi.SkillReferences {
	if refs.Agents == nil {
		refs.Agents = []gatewayapi.AgentName{}
	}
	if refs.Sandboxes == nil {
		refs.Sandboxes = []gatewayapi.SandboxName{}
	}
	return refs
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

	sandboxSkills := make(map[string][]agentzv1alpha1.ResourceReference, len(sandboxes.Items))
	agentRefs := map[string]map[string]struct{}{}
	sandboxRefs := map[string]map[string]struct{}{}
	for _, sandbox := range sandboxes.Items {
		sandboxSkills[sandbox.Name] = sandbox.Spec.Skills
		for _, ref := range sandbox.Spec.Skills {
			if sandboxRefs[ref.Name] == nil {
				sandboxRefs[ref.Name] = map[string]struct{}{}
			}
			sandboxRefs[ref.Name][sandbox.Name] = struct{}{}
		}
	}

	for _, agt := range agents.Items {
		refs := append([]agentzv1alpha1.ResourceReference{}, agt.Spec.Skills...)
		refs = append(refs, sandboxSkills[agt.Spec.SandboxRef.Name]...)
		for _, ref := range refs {
			if agentRefs[ref.Name] == nil {
				agentRefs[ref.Name] = map[string]struct{}{}
			}
			agentRefs[ref.Name][agt.Name] = struct{}{}
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
	for _, ref := range agt.Spec.Skills {
		out[ref.Name] = struct{}{}
	}
	sandbox := &agentzv1alpha1.Sandbox{}
	key = types.NamespacedName{Name: agt.Spec.SandboxRef.Name, Namespace: namespace}
	if err := s.k8sClient.Get(ctx, key, sandbox); err != nil {
		return nil, err
	}
	for _, ref := range sandbox.Spec.Skills {
		out[ref.Name] = struct{}{}
	}
	return out, nil
}

func validateSkillName(field string, name string) []gatewayapi.FieldError {
	if err := skill.ValidateName(name); err != nil {
		return []gatewayapi.FieldError{{Field: field, Message: err.Error()}}
	}
	return []gatewayapi.FieldError{}
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
	bucket, _, err := skill.ParseStoragePath(storagePath)
	if err != nil {
		return []gatewayapi.FieldError{{Field: field, Message: err.Error()}}
	}
	expected := (skill.Config{Bucket: bucket}).StoragePath(namespace, name, version)
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

func (s *Service) validateSkillRefs(ctx context.Context, namespace string, refs []gatewayapi.ResourceReference) ([]gatewayapi.ResourceReference, []gatewayapi.FieldError, error) {
	out := make([]gatewayapi.ResourceReference, 0, len(refs))
	fields := []gatewayapi.FieldError{}
	seen := map[gatewayapi.ResourceReference]int{}
	for i, ref := range refs {
		name := ref.Name
		field := fmt.Sprintf("skills[%d].name", i)
		if name == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field: field, Message: "required",
			})
			continue
		}
		if first, ok := seen[ref]; ok {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("skills[%d]", i),
				Message: fmt.Sprintf("duplicate value %q first seen at index %d", name, first),
			})
			continue
		}
		seen[ref] = i
		itemFields := validateSkillName(field, name)
		fields = append(fields, itemFields...)
		if len(itemFields) > 0 {
			continue
		}
		ns, err := scoperesolver.SelectedNamespace(
			ctx,
			s.k8sClient,
			namespace,
			agentzv1alpha1.ResourceScope(ref.Scope),
			agentzv1alpha1.OrganizationResourceKindSkill,
			name,
		)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("skills[%d].scope", i),
				Message: "scope is not available from the selected Sandbox scope",
			})
			continue
		}
		skill := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Name: name, Namespace: ns}
		if err := s.k8sClient.Get(ctx, key, skill); err != nil {
			if apierrors.IsNotFound(err) {
				fields = append(fields, gatewayapi.FieldError{
					Field: field, Message: "skill not found",
				})
				continue
			}
			return nil, nil, fmt.Errorf("get skill %q: %w", name, err)
		}
		if !skill.DeletionTimestamp.IsZero() {
			fields = append(fields, gatewayapi.FieldError{
				Field: field, Message: "skill is being deleted",
			})
			continue
		}
		out = append(out, ref)
	}
	return out, fields, nil
}

const maxSkillUploadBytes = 10 << 20

type immutableImportPlan struct {
	tree    skill.Tree
	version int64
	current *agentzv1alpha1.Skill
}

// PreviewSkillImport handles POST /api/skill/import/preview.
func (s *Service) PreviewSkillImport(w http.ResponseWriter, r *http.Request, params gatewayapi.PreviewSkillImportParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	bundle, ok := readSkillUpload(w, r)
	if !ok {
		return
	}
	ns := access.namespace

	immutable := &agentzv1alpha1.SkillList{}
	if err := s.k8sClient.List(r.Context(), immutable, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list immutable skills: %w", err))
		return
	}
	immutableNames := make(map[string]struct{}, len(immutable.Items))
	for _, item := range immutable.Items {
		immutableNames[item.Name] = struct{}{}
	}
	items := make([]gatewayapi.SkillImportPreviewItem, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		_, immutableConflict := immutableNames[tree.Name]
		items = append(items, gatewayapi.SkillImportPreviewItem{
			Name: tree.Name, ImmutableConflict: immutableConflict,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.SkillImportPreviewResponse{Skills: items})
}

// ImportSkills handles POST /api/skill/import.
func (s *Service) ImportSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.ImportSkillsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationCreateSkill)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSkillAudit(r.Context(), r, access, "import", access.failureResult())
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	audited := false
	defer func() {
		if audited {
			return
		}
		err := s.createSkillAudit(
			context.WithoutCancel(r.Context()),
			r,
			access,
			"import",
			gatewaydb.AuditResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "audit failed Skill import", slog.Any("err", err))
		}
	}()
	bundle, ok := readSkillUpload(w, r)
	if !ok {
		return
	}
	values := r.MultipartForm.Value["decisions"]
	if len(values) == 0 || len(values) > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "skill decisions are required", errBadRequest,
		))
		return
	}
	decisions := make([]skill.Decision, 0, len(values))
	for _, raw := range values {
		var decision gatewayapi.SkillImportDecision
		if err := json.Unmarshal([]byte(raw), &decision); err != nil {
			writeError(w, r, newAPIError(
				http.StatusBadRequest, "invalid_request", "skill decisions are invalid", err,
			))
			return
		}
		action, err := decision.Discriminator()
		if err != nil {
			writeError(w, r, newAPIError(
				http.StatusBadRequest, "invalid_request", "skill decision action is invalid", err,
			))
			return
		}
		switch action {
		case string(skill.DecisionCreate):
			value, err := decision.AsCreateSkillImportDecision()
			if err != nil {
				writeError(w, r, newAPIError(
					http.StatusBadRequest, "invalid_request", "create decision is invalid", err,
				))
				return
			}
			decisions = append(decisions, skill.Decision{
				Action: skill.DecisionCreate, Name: value.Name,
			})
		case string(skill.DecisionOverwrite):
			value, err := decision.AsOverwriteSkillImportDecision()
			if err != nil {
				writeError(w, r, newAPIError(
					http.StatusBadRequest, "invalid_request", "overwrite decision is invalid", err,
				))
				return
			}
			decisions = append(decisions, skill.Decision{
				Action: skill.DecisionOverwrite, Name: value.Name,
			})
		case string(skill.DecisionRename):
			value, err := decision.AsRenameSkillImportDecision()
			if err != nil {
				writeError(w, r, newAPIError(
					http.StatusBadRequest, "invalid_request", "rename decision is invalid", err,
				))
				return
			}
			decisions = append(decisions, skill.Decision{
				Action: skill.DecisionRename, Name: value.Name, Rename: value.Rename,
			})
		default:
			writeError(w, r, newAPIError(
				http.StatusBadRequest, "invalid_request", "skill decision action is invalid", errBadRequest,
			))
			return
		}
	}
	decided, err := bundle.Decide(decisions)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "decision_conflict", "skill decisions conflict", err,
		))
		return
	}
	bundle = decided
	ns := access.namespace
	names := make([]gatewayapi.SkillName, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		names = append(names, tree.Name)
	}
	capabilities, err := s.resolveResourceCapabilities(r.Context(), access.claims, workspaceID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	importErr := s.importImmutableSkills(r, ns, bundle, decisions, access, capabilities.skill.Modify)
	if importErr != nil {
		writeError(w, r, importErr)
		return
	}
	audited = true
	if err := s.createSkillAudit(r.Context(), r, access, "import", gatewaydb.AuditResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.ImportSkillsResponse{Skills: names})
}

func (s *Service) importImmutableSkills(r *http.Request, namespace string, bundle skill.Bundle, decisions []skill.Decision, access resourceAccess, canModify bool) *apiError {
	ctx := r.Context()
	actions := make(map[string]skill.DecisionAction, len(decisions))
	for _, decision := range decisions {
		name := decision.Name
		if decision.Action == skill.DecisionRename {
			name = decision.Rename
		}
		actions[name] = decision.Action
	}
	plans := make([]immutableImportPlan, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		current := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Namespace: namespace, Name: tree.Name}
		err := s.k8sClient.Get(ctx, key, current)
		exists := err == nil
		if err != nil && !apierrors.IsNotFound(err) {
			return mapKubeHTTPError("get immutable skill", err)
		}
		action := actions[tree.Name]
		if action == skill.DecisionOverwrite && !exists {
			return newAPIError(
				http.StatusConflict,
				"decision_conflict",
				"overwrite destination does not exist",
				errBadRequest,
			)
		}
		if action == skill.DecisionOverwrite && !canModify && current.Spec.CreatorUserID != access.claims.UserID {
			auditAccess := access
			auditAccess.operation = authorization.OperationUpdateSkill
			if err := s.createSkillAudit(ctx, r, auditAccess, tree.Name, gatewaydb.AuditResultDenied); err != nil {
				return newAPIError(http.StatusInternalServerError, "internal_error", "unexpected server error", err)
			}
			return resourceForbidden(errors.New("skill creator privilege is missing"))
		}
		if action != skill.DecisionOverwrite && exists {
			return newAPIError(
				http.StatusConflict,
				"decision_conflict",
				"create destination already exists",
				errBadRequest,
			)
		}
		versions, err := s.skillStore.Versions(ctx, namespace, tree.Name)
		if err != nil {
			return newAPIError(
				http.StatusInternalServerError,
				"storage_unavailable",
				"immutable skill storage is unavailable",
				err,
			)
		}
		version := int64(1)
		if len(versions) > 0 {
			version = versions[len(versions)-1] + 1
		}
		if exists && current.Spec.Version >= version {
			version = current.Spec.Version + 1
		}
		if !exists {
			current = nil
		}
		plans = append(plans, immutableImportPlan{
			tree: tree, version: version, current: current,
		})
	}

	for i, plan := range plans {
		err := s.skillStore.UploadVersion(ctx, namespace, plan.tree, plan.version)
		if err != nil {
			cleanupErr := s.rollbackImmutableImport(ctx, namespace, nil, plans[:i])
			if !errors.Is(err, skill.ErrVersionExists) {
				return newAPIError(
					http.StatusInternalServerError,
					"storage_unavailable",
					"immutable skill storage is unavailable",
					errors.Join(err, cleanupErr),
				)
			}
			return newAPIError(
				http.StatusConflict,
				"version_conflict",
				"immutable skill version already exists",
				errors.Join(err, cleanupErr),
			)
		}
	}

	for i, plan := range plans {
		storagePath := s.cfg.SkillStore.StoragePath(namespace, plan.tree.Name, plan.version)
		if plan.current == nil {
			item := &agentzv1alpha1.Skill{
				TypeMeta: metav1.TypeMeta{
					APIVersion: agentzv1alpha1.SchemeGroupVersion.String(), Kind: "Skill",
				},
				ObjectMeta: metav1.ObjectMeta{
					Name: plan.tree.Name, Namespace: namespace,
					OwnerReferences: []metav1.OwnerReference{access.owner},
				},
				Spec: agentzv1alpha1.SkillSpec{
					CreatorUserID: access.claims.UserID,
					Description:   plan.tree.Description,
					Version:       plan.version,
					StoragePath:   storagePath,
				},
			}
			if err := s.k8sClient.Create(ctx, item); err != nil {
				auditErr := s.createSkillAudit(ctx, r, access, plan.tree.Name, gatewaydb.AuditResultFailed)
				applied := plans[:i+1]
				if apierrors.IsAlreadyExists(err) {
					applied = plans[:i]
				}
				cleanupErr := s.rollbackImmutableImport(ctx, namespace, applied, plans)
				return mapKubeHTTPError(
					"create immutable skill",
					errors.Join(err, cleanupErr, auditErr),
				)
			}
			if err := s.createSkillAudit(ctx, r, access, plan.tree.Name, gatewaydb.AuditResultSucceeded); err != nil {
				return newAPIError(http.StatusInternalServerError, "internal_error", "unexpected server error", err)
			}
			continue
		}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			item := &agentzv1alpha1.Skill{}
			key := types.NamespacedName{Namespace: namespace, Name: plan.tree.Name}
			if err := s.k8sClient.Get(ctx, key, item); err != nil {
				return err
			}
			item.Spec.Description = plan.tree.Description
			item.Spec.Version = plan.version
			item.Spec.StoragePath = storagePath
			return s.k8sClient.Update(ctx, item)
		})
		if err != nil {
			auditAccess := access
			auditAccess.operation = authorization.OperationUpdateSkill
			auditErr := s.createSkillAudit(ctx, r, auditAccess, plan.tree.Name, gatewaydb.AuditResultFailed)
			applied := plans[:i+1]
			if apierrors.IsConflict(err) {
				applied = plans[:i]
			}
			cleanupErr := s.rollbackImmutableImport(ctx, namespace, applied, plans)
			return mapKubeHTTPError(
				"update immutable skill",
				errors.Join(err, cleanupErr, auditErr),
			)
		}
		auditAccess := access
		auditAccess.operation = authorization.OperationUpdateSkill
		if err := s.createSkillAudit(ctx, r, auditAccess, plan.tree.Name, gatewaydb.AuditResultSucceeded); err != nil {
			return newAPIError(http.StatusInternalServerError, "internal_error", "unexpected server error", err)
		}
	}

	return nil
}

func (s *Service) rollbackImmutableImport(ctx context.Context, namespace string, applied, uploaded []immutableImportPlan) error {
	ctx = context.WithoutCancel(ctx)

	var rollbackErr error
	activeVersions := make(map[string]struct{}, len(applied))
	for _, plan := range slices.Backward(applied) {
		if plan.current == nil {
			item := &agentzv1alpha1.Skill{}
			key := types.NamespacedName{Namespace: namespace, Name: plan.tree.Name}
			err := s.k8sClient.Get(ctx, key, item)
			if apierrors.IsNotFound(err) {
				continue
			}
			if err != nil {
				activeVersions[plan.tree.Name] = struct{}{}
				rollbackErr = errors.Join(rollbackErr, err)
				continue
			}
			expectedPath := s.cfg.SkillStore.StoragePath(namespace, plan.tree.Name, plan.version)
			if item.Spec.Version != plan.version || item.Spec.StoragePath != expectedPath {
				err = errors.New("created immutable skill changed before rollback")
				activeVersions[plan.tree.Name] = struct{}{}
				rollbackErr = errors.Join(rollbackErr, err)
				continue
			}
			uid := item.UID
			resourceVersion := item.ResourceVersion
			err = s.k8sClient.Delete(ctx, item, ctrlclient.Preconditions{
				UID: &uid, ResourceVersion: &resourceVersion,
			})
			if apierrors.IsNotFound(err) {
				err = nil
			}
			if err != nil {
				activeVersions[plan.tree.Name] = struct{}{}
			}
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			item := &agentzv1alpha1.Skill{}
			key := types.NamespacedName{Namespace: namespace, Name: plan.tree.Name}
			if err := s.k8sClient.Get(ctx, key, item); err != nil {
				return err
			}
			expectedPath := s.cfg.SkillStore.StoragePath(namespace, plan.tree.Name, plan.version)
			if item.Spec.Version != plan.version || item.Spec.StoragePath != expectedPath {
				return errors.New("updated immutable skill changed before rollback")
			}
			item.Spec = plan.current.Spec
			return s.k8sClient.Update(ctx, item)
		})
		if err != nil {
			activeVersions[plan.tree.Name] = struct{}{}
		}
		rollbackErr = errors.Join(rollbackErr, err)
	}
	for _, plan := range uploaded {
		if _, active := activeVersions[plan.tree.Name]; active {
			continue
		}
		rollbackErr = errors.Join(rollbackErr, s.skillStore.DeleteVersion(
			ctx, namespace, plan.tree.Name, plan.version,
		))
	}
	return rollbackErr
}

func readSkillUpload(w http.ResponseWriter, r *http.Request) (skill.Bundle, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSkillUploadBytes+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "skill upload must be multipart", err,
		))
		return skill.Bundle{}, false
	}
	values := make(map[string][]string)
	var bundle skill.Bundle
	var hasFile bool
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			status := http.StatusBadRequest
			code := "invalid_request"
			if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
				status = http.StatusRequestEntityTooLarge
				code = "upload_too_large"
			}
			writeError(w, r, newAPIError(status, code, "skill upload is invalid", err))
			return skill.Bundle{}, false
		}
		switch {
		case part.FormName() == "file" && hasFile:
			err = errors.New("skill upload contains multiple files")
		case part.FormName() == "file":
			bundle, err = skill.Parse(part.FileName(), part)
			hasFile = true
		default:
			var value []byte
			value, err = io.ReadAll(io.LimitReader(part, (64<<10)+1))
			if err == nil && len(value) > 64<<10 {
				err = errors.New("skill import field is too large")
			}
			if err == nil {
				name := part.FormName()
				values[name] = append(values[name], string(value))
			}
		}
		err = errors.Join(err, part.Close())
		if err == nil {
			continue
		}
		status := http.StatusBadRequest
		code := "invalid_archive"
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			status = http.StatusRequestEntityTooLarge
			code = "upload_too_large"
		}
		switch {
		case errors.Is(err, skill.ErrLimitExceeded):
			status = http.StatusRequestEntityTooLarge
			code = "upload_too_large"
		case errors.Is(err, skill.ErrInvalidTree):
			code = "invalid_skill_tree"
		case errors.Is(err, skill.ErrMalformedMetadata):
			code = "malformed_skill_metadata"
		}
		writeError(w, r, newAPIError(status, code, "skill upload is invalid", err))
		return skill.Bundle{}, false
	}
	if !hasFile {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "skill file is required", errBadRequest,
		))
		return skill.Bundle{}, false
	}
	r.MultipartForm = &multipart.Form{Value: values}
	return bundle, true
}

// DeleteImmutableSkills handles DELETE /api/skill.
func (s *Service) DeleteImmutableSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.DeleteImmutableSkillsParams) {
	var req gatewayapi.DeleteSkillsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	names, ok := validateRequestedSkillNames(w, r, req.SkillNames)
	if !ok {
		return
	}
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	items := make([]*agentzv1alpha1.Skill, 0, len(names))
	accesses := make([]resourceAccess, 0, len(names))
	for _, name := range names {
		access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, name, authorization.OperationDeleteSkill)
		if apiErr != nil {
			if access.claims.OrganizationID != "" {
				err := s.createSkillAudit(r.Context(), r, access, name, access.failureResult())
				if err != nil {
					writeInternalError(w, r, err)
					return
				}
			}
			writeError(w, r, apiErr)
			return
		}
		conflict, err := s.selectedOrganizationResourceConflict(
			r.Context(), access, agentzv1alpha1.OrganizationResourceKindSkill, name,
		)
		if err != nil || conflict != nil {
			auditErr := s.createSkillAudit(
				r.Context(), r, access, name, gatewaydb.AuditResultFailed,
			)
			if err != nil || auditErr != nil {
				writeInternalError(w, r, errors.Join(err, auditErr))
				return
			}
			writeError(w, r, conflict)
			return
		}
		item := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Namespace: access.namespace, Name: name}
		if err := s.k8sClient.Get(r.Context(), key, item); err != nil {
			writeError(w, r, mapKubeHTTPError("get immutable skill", err))
			return
		}
		items = append(items, item)
		accesses = append(accesses, access)
	}
	for i, item := range items {
		if err := s.k8sClient.Delete(r.Context(), item); err != nil {
			auditErr := s.createSkillAudit(r.Context(), r, accesses[i], item.Name, gatewaydb.AuditResultFailed)
			if auditErr != nil {
				writeInternalError(w, r, errors.Join(err, auditErr))
				return
			}
			writeError(w, r, mapKubeHTTPError("delete immutable skill", err))
			return
		}
		if err := s.createSkillAudit(r.Context(), r, accesses[i], item.Name, gatewaydb.AuditResultSucceeded); err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListImmutableSkillVersions handles GET /api/skill/{skillName}/version.
func (s *Service) ListImmutableSkillVersions(w http.ResponseWriter, r *http.Request, skillName gatewayapi.SkillNamePath, params gatewayapi.ListImmutableSkillVersionsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	if fields := validateSkillName("skillName", skillName); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "skill name is invalid", errBadRequest, fields...,
		))
		return
	}
	item := &agentzv1alpha1.Skill{}
	key := types.NamespacedName{Namespace: ns, Name: skillName}
	if err := s.k8sClient.Get(r.Context(), key, item); err != nil {
		writeError(w, r, mapKubeHTTPError("get immutable skill", err))
		return
	}
	versions, err := s.skillStore.Versions(r.Context(), ns, skillName)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

// ListImmutableSkillSummaries handles GET /api/skill/summary.
func (s *Service) ListImmutableSkillSummaries(w http.ResponseWriter, r *http.Request, params gatewayapi.ListImmutableSkillSummariesParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	var err error
	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "limit must be between 1 and 200", errBadRequest,
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
	list := &agentzv1alpha1.SkillList{}
	if err := s.k8sClient.List(r.Context(), list, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list immutable skills: %w", err))
		return
	}
	slices.SortFunc(list.Items, func(a, b agentzv1alpha1.Skill) int {
		return strings.Compare(a.Name, b.Name)
	})
	filtered := make([]agentzv1alpha1.Skill, 0, len(list.Items))
	for _, item := range list.Items {
		if !item.DeletionTimestamp.IsZero() {
			continue
		}
		if params.AgentName != nil {
			if _, ok := effective[item.Name]; !ok {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	start := min(offset, len(filtered))
	end := min(start+limit, len(filtered))
	refs, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	items := make([]gatewayapi.ImmutableSkillSummary, 0, end-start)
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	for _, item := range filtered[start:end] {
		summary, err := s.skillStore.VersionSummary(
			r.Context(), ns, item.Name, item.Spec.Version,
		)
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("summarize immutable skill: %w", err))
			return
		}
		ref := skillReferencesOrEmpty(refs[item.Name])
		creator := item.Spec.CreatorUserID == access.claims.UserID &&
			access.effective.Allows(scope, authorization.OperationCreateSkill)
		items = append(items, gatewayapi.ImmutableSkillSummary{
			Name:        item.Name,
			CanModify:   access.effective.Allows(scope, authorization.OperationUpdateSkill) || creator,
			CanDelete:   access.effective.Allows(scope, authorization.OperationDeleteSkill) || creator,
			Description: item.Spec.Description,
			Version:     item.Spec.Version,
			Agents:      ref.Agents,
			Sandboxes:   ref.Sandboxes,
			FileCount:   summary.FileCount,
			SizeBytes:   summary.SizeBytes,
			ModifiedAt:  summary.Modified,
		})
	}
	var next string
	if end < len(filtered) {
		next = encodeOffsetToken(end)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListImmutableSkillSummariesResponse{
		Skills: items, NextPageToken: next,
	})
}

// ExportImmutableSkills handles POST /api/skill/export.
func (s *Service) ExportImmutableSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.ExportImmutableSkillsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationListSkills)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	var req gatewayapi.ExportSkillsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	selections := make([]skill.VersionSelection, 0, len(req.Skills))
	for _, ref := range req.Skills {
		name := ref.Name
		if fields := validateSkillName("skills.name", name); len(fields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest, "invalid_request",
				"request validation failed", errBadRequest, fields...,
			))
			return
		}
		ns, err := scoperesolver.SelectedNamespace(
			r.Context(), s.k8sClient, access.namespace,
			agentzv1alpha1.ResourceScope(ref.Scope),
			agentzv1alpha1.OrganizationResourceKindSkill,
			name,
		)
		if err != nil {
			writeError(w, r, resourceForbidden(err))
			return
		}
		item := &agentzv1alpha1.Skill{}
		key := types.NamespacedName{Namespace: ns, Name: name}
		if err := s.k8sClient.Get(r.Context(), key, item); err != nil {
			writeError(w, r, mapKubeHTTPError("get immutable skill", err))
			return
		}
		_, err = s.skillStore.VersionSummary(r.Context(), ns, name, item.Spec.Version)
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("inspect immutable skill export: %w", err))
			return
		}
		selections = append(selections, skill.VersionSelection{
			Name:    name,
			Version: item.Spec.Version,
		})
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="skills.zip"`)
	if err := s.skillStore.WriteVersionsZIP(r.Context(), w, ns, selections); err != nil {
		slog.ErrorContext(r.Context(), "stream immutable skill export", slog.Any("err", err))
	}
}

func validateRequestedSkillNames(w http.ResponseWriter, r *http.Request, raw []gatewayapi.SkillName) ([]string, bool) {
	if err := skill.ValidateNames(raw); err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_request", "skill_names is invalid", err,
		))
		return nil, false
	}
	slices.Sort(raw)
	return raw, true
}
