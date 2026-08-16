package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"

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
			return item.Spec.CreatedByUserID == userID, err
		}
	}
	return s.resolveResourceAccess(ctx, req)
}

func (s *Service) createSkillEventTrail(ctx context.Context, access resourceAccess, name string, result gatewaydb.EventTrailResult) error {
	action := "unmapped"
	switch access.operation {
	case authorization.OperationCreateSkill:
		action = "create"
	case authorization.OperationUpdateSkill:
		action = "modify"
	case authorization.OperationDeleteSkill:
		action = "delete"
	}
	return s.createResourceEventTrail(
		ctx, access, gatewaydb.EventTrailTargetSkill, name, "skill", action, result,
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

	var effective map[agentzv1alpha1.ResourceReference]struct{}
	if params.AgentName != nil {
		name, ok := validAgentName(w, r, *params.AgentName, "agent_name")
		if !ok {
			return
		}
		resolved, err := s.effectiveAgentSkills(r.Context(), ns, name)
		if err != nil {
			writeError(w, r, mapKubeHTTPError("get agent skills", err))
			return
		}
		effective = resolved
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
	userIDs := make([]string, 0, len(skillList.Items)*2)
	for _, item := range skillList.Items {
		userIDs = append(userIDs, item.Spec.CreatedByUserID, item.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(r.Context(), userIDs...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	localScope := agentzv1alpha1.ResourceScope(resourceScope(access.workspaceID))
	for _, item := range skillList.Items {
		if params.AgentName != nil {
			ref := agentzv1alpha1.ResourceReference{Scope: localScope, Name: item.Name}
			if _, ok := effective[ref]; !ok {
				continue
			}
		}
		ref := agentzv1alpha1.ResourceReference{Scope: localScope, Name: item.Name}
		items = append(items, skillFromCRD(item, refsBySkill[ref], access, actors))
	}
	if workspaceID != "" {
		organizationItems, err := s.listInheritedSkills(
			r.Context(), access, effective, refsBySkill,
		)
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

func (s *Service) listInheritedSkills(ctx context.Context, access resourceAccess, effective map[agentzv1alpha1.ResourceReference]struct{}, refs map[agentzv1alpha1.ResourceReference]gatewayapi.SkillReferences) ([]gatewayapi.Skill, error) {
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
	userIDs := make([]string, 0, len(skills.Items)*2)
	for _, item := range skills.Items {
		if _, ok := selected[item.Name]; !ok {
			continue
		}
		userIDs = append(userIDs, item.Spec.CreatedByUserID, item.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(ctx, userIDs...)
	if err != nil {
		return nil, err
	}
	for _, item := range skills.Items {
		if _, ok := selected[item.Name]; !ok {
			continue
		}
		ref := agentzv1alpha1.ResourceReference{
			Scope: agentzv1alpha1.ResourceScopeOrganisation,
			Name:  item.Name,
		}
		if effective != nil {
			if _, ok := effective[ref]; !ok {
				continue
			}
		}
		skill := skillFromCRD(item, refs[ref], organizationAccess, actors)
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
			err := s.createSkillEventTrail(r.Context(), access, req.Name, access.failureResult())
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
			ResourceAudit: agentzv1alpha1.ResourceAudit{
				CreatedByUserID:      access.claims.UserID,
				LastModifiedByUserID: access.claims.UserID,
			},
			Description: req.Description,
			Version:     req.Version,
			StoragePath: req.StoragePath,
		},
	}
	if err := s.k8sClient.Create(r.Context(), skill); err != nil {
		eventTrailErr := s.createSkillEventTrail(r.Context(), access, req.Name, gatewaydb.EventTrailResultFailed)
		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("create skill", err))
		return
	}
	if err := s.createSkillEventTrail(r.Context(), access, req.Name, gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	ref := agentzv1alpha1.ResourceReference{
		Scope: agentzv1alpha1.ResourceScope(resourceScope(access.workspaceID)),
		Name:  skill.Name,
	}
	refs := refsBySkill[ref]
	actors, err := s.resourceActors(
		r.Context(), skill.Spec.CreatedByUserID, skill.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, skillFromCRD(*skill, refs, access, actors))
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
			err := s.createSkillEventTrail(r.Context(), access, skillName, access.failureResult())
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
		current.Spec.LastModifiedByUserID = access.claims.UserID
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
		eventTrailErr := s.createSkillEventTrail(r.Context(), access, skillName, gatewaydb.EventTrailResultFailed)
		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("update skill", err))
		return
	}
	if err := s.createSkillEventTrail(r.Context(), access, skillName, gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	refsBySkill, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	ref := agentzv1alpha1.ResourceReference{
		Scope: agentzv1alpha1.ResourceScope(resourceScope(access.workspaceID)),
		Name:  updated.Name,
	}
	refs := refsBySkill[ref]
	actors, err := s.resourceActors(
		r.Context(), updated.Spec.CreatedByUserID, updated.Spec.LastModifiedByUserID,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, skillFromCRD(*updated, refs, access, actors))
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
			err := s.createSkillEventTrail(r.Context(), access, skillName, access.failureResult())
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
		eventTrailErr := s.createSkillEventTrail(r.Context(), access, skillName, gatewaydb.EventTrailResultFailed)
		if err != nil || eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, conflict)
		return
	}

	skill := &agentzv1alpha1.Skill{}
	skill.Name = skillName
	skill.Namespace = ns
	if err := s.k8sClient.Delete(r.Context(), skill); err != nil {
		eventTrailErr := s.createSkillEventTrail(r.Context(), access, skillName, gatewaydb.EventTrailResultFailed)
		if eventTrailErr != nil {
			writeInternalError(w, r, errors.Join(err, eventTrailErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete skill", err))
		return
	}
	if err := s.createSkillEventTrail(r.Context(), access, skillName, gatewaydb.EventTrailResultSucceeded); err != nil {
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
	ref := agentzv1alpha1.ResourceReference{
		Scope: agentzv1alpha1.ResourceScope(resourceScope(access.workspaceID)),
		Name:  skill.Name,
	}
	refs := skillReferencesOrEmpty(refsBySkill[ref])
	writeJSON(w, http.StatusOK, refs)
}

func skillFromCRD(skill agentzv1alpha1.Skill, refs gatewayapi.SkillReferences, access resourceAccess, actors map[string]gatewayapi.ResourceActor) gatewayapi.Skill {
	refs = skillReferencesOrEmpty(refs)
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	creator := skill.Spec.CreatedByUserID == access.claims.UserID &&
		access.effective.Allows(scope, authorization.OperationCreateSkill)
	return gatewayapi.Skill{
		Scope:          resourceScope(access.workspaceID),
		Name:           skill.Name,
		CreatedBy:      actors[skill.Spec.CreatedByUserID],
		LastModifiedBy: actors[skill.Spec.LastModifiedByUserID],
		CanModify:      access.effective.Allows(scope, authorization.OperationUpdateSkill) || creator,
		CanDelete:      access.effective.Allows(scope, authorization.OperationDeleteSkill) || creator,
		Description:    skill.Spec.Description,
		Version:        skill.Spec.Version,
		StoragePath:    skill.Spec.StoragePath,
		Agents:         refs.Agents,
		Sandboxes:      refs.Sandboxes,
		CreatedAt:      skill.CreationTimestamp.Time,
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

func (s *Service) listSkillReferences(ctx context.Context, namespace string) (map[agentzv1alpha1.ResourceReference]gatewayapi.SkillReferences, error) {
	agents := &agentzv1alpha1.AgentList{}
	if err := s.k8sClient.List(ctx, agents, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := s.k8sClient.List(ctx, sandboxes, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list sandboxes: %w", err)
	}

	sandboxSkills := make(map[string][]agentzv1alpha1.ResourceReference, len(sandboxes.Items))
	agentRefs := map[agentzv1alpha1.ResourceReference]map[string]struct{}{}
	sandboxRefs := map[agentzv1alpha1.ResourceReference]map[string]struct{}{}
	for _, sandbox := range sandboxes.Items {
		sandboxSkills[sandbox.Name] = sandbox.Spec.Skills
		for _, ref := range sandbox.Spec.Skills {
			if sandboxRefs[ref] == nil {
				sandboxRefs[ref] = map[string]struct{}{}
			}
			sandboxRefs[ref][sandbox.Name] = struct{}{}
		}
	}

	for _, agt := range agents.Items {
		refs := append([]agentzv1alpha1.ResourceReference{}, agt.Spec.Skills...)
		refs = append(refs, sandboxSkills[agt.Spec.SandboxRef.Name]...)
		for _, ref := range refs {
			if agentRefs[ref] == nil {
				agentRefs[ref] = map[string]struct{}{}
			}
			agentRefs[ref][agt.Name] = struct{}{}
		}
	}

	refs := make(map[agentzv1alpha1.ResourceReference]gatewayapi.SkillReferences, len(agentRefs)+len(sandboxRefs))
	for ref, items := range agentRefs {
		names := make([]gatewayapi.AgentName, 0, len(items))
		for item := range items {
			names = append(names, item)
		}
		slices.Sort(names)
		refs[ref] = gatewayapi.SkillReferences{
			Agents: names, Sandboxes: []gatewayapi.SandboxName{},
		}
	}
	for resource, items := range sandboxRefs {
		names := make([]gatewayapi.SandboxName, 0, len(items))
		for item := range items {
			names = append(names, item)
		}
		slices.Sort(names)
		ref := refs[resource]
		ref.Sandboxes = names
		refs[resource] = ref
	}
	return refs, nil
}

func (s *Service) effectiveAgentSkills(ctx context.Context, namespace string, agentName string) (map[agentzv1alpha1.ResourceReference]struct{}, error) {
	agt := &agentzv1alpha1.Agent{}
	key := types.NamespacedName{Name: agentName, Namespace: namespace}
	if err := s.k8sClient.Get(ctx, key, agt); err != nil {
		return nil, err
	}
	out := make(map[agentzv1alpha1.ResourceReference]struct{}, len(agt.Spec.Skills))
	for _, ref := range agt.Spec.Skills {
		out[ref] = struct{}{}
	}
	sandbox := &agentzv1alpha1.Sandbox{}
	key = types.NamespacedName{Name: agt.Spec.SandboxRef.Name, Namespace: namespace}
	if err := s.k8sClient.Get(ctx, key, sandbox); err != nil {
		if apierrors.IsNotFound(err) {
			return out, nil
		}
		return nil, err
	}
	for _, ref := range sandbox.Spec.Skills {
		out[ref] = struct{}{}
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

// PreviewMutableSkillImport handles POST /api/agent/skill/import/preview.
func (s *Service) PreviewMutableSkillImport(w http.ResponseWriter, r *http.Request, _ gatewayapi.PreviewMutableSkillImportParams) {
	bundle, ok := readSkillUpload(w, r)
	if !ok {
		return
	}
	names, ok := readSkillImportAgentNames(w, r, true)
	if !ok {
		return
	}
	agents, apiErr := s.resolveSkillImportAgents(r.Context(), names)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	conflicts := make(map[string][]gatewayapi.AgentName, len(bundle.Skills))
	for _, agent := range agents {
		mutable, err := s.mutableSkillNames(r.Context(), agent)
		if err != nil {
			writeError(w, r, newAPIError(
				http.StatusBadGateway,
				"filesystem_unavailable",
				"agent filesystem is unavailable",
				err,
			))
			return
		}
		for _, tree := range bundle.Skills {
			if _, exists := mutable[tree.Name]; exists {
				conflicts[tree.Name] = append(conflicts[tree.Name], agent.Agent.Name)
			}
		}
	}

	items := make([]gatewayapi.MutableSkillImportPreviewItem, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		agents := conflicts[tree.Name]
		if agents == nil {
			agents = []gatewayapi.AgentName{}
		}
		items = append(items, gatewayapi.MutableSkillImportPreviewItem{
			Name: tree.Name, ConflictAgents: agents,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.MutableSkillImportPreviewResponse{
		Skills: items,
	})
}

// ImportMutableSkills handles POST /api/agent/skill/import.
func (s *Service) ImportMutableSkills(w http.ResponseWriter, r *http.Request, _ gatewayapi.ImportMutableSkillsParams) {
	bundle, ok := readSkillUpload(w, r)
	if !ok {
		return
	}
	names, ok := readSkillImportAgentNames(w, r, true)
	if !ok {
		return
	}
	bundle, decisions, ok := readSkillImportDecisions(w, r, bundle)
	if !ok {
		return
	}
	agents, apiErr := s.resolveSkillImportAgents(r.Context(), names)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	var archive bytes.Buffer
	if err := bundle.WriteZIP(&archive); err != nil {
		writeInternalError(w, r, fmt.Errorf("create canonical skill archive: %w", err))
		return
	}
	actions := make(map[string]skill.DecisionAction, len(decisions))
	for _, decision := range decisions {
		destination := decision.Name
		if decision.Action == skill.DecisionRename {
			destination = decision.Rename
		}
		actions[destination] = decision.Action
	}
	decisionHeaders := make([][]byte, len(agents))
	for i, agent := range agents {
		existing, err := s.mutableSkillNames(r.Context(), agent)
		if err != nil {
			writeError(w, r, newAPIError(
				http.StatusBadGateway,
				"filesystem_unavailable",
				"agent filesystem is unavailable",
				err,
			))
			return
		}
		plan := make([]skill.Decision, 0, len(bundle.Skills))
		for _, tree := range bundle.Skills {
			action := skill.DecisionCreate
			if actions[tree.Name] == skill.DecisionOverwrite {
				if _, ok := existing[tree.Name]; ok {
					action = skill.DecisionOverwrite
				}
			}
			plan = append(plan, skill.Decision{Action: action, Name: tree.Name})
		}
		decisionHeaders[i], err = json.Marshal(plan)
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("encode skill decisions: %w", err))
			return
		}
	}

	results := make([]gatewayapi.SkillImportAgentResult, len(agents))
	var wg sync.WaitGroup
	for i, agent := range agents {
		wg.Go(func() {
			select {
			case s.skillImports <- struct{}{}:
			case <-r.Context().Done():
				message := r.Context().Err().Error()
				results[i] = gatewayapi.SkillImportAgentResult{
					Agent:  agent.Agent.Name,
					Status: gatewayapi.SkillImportAgentResultStatusFailed,
					Error:  &message,
				}
				return
			}
			defer func() { <-s.skillImports }()
			results[i] = s.importMutableSkillArchive(
				r.Context(), agent, archive.Bytes(), decisionHeaders[i],
			)
		})
	}
	wg.Wait()

	imported := make([]gatewayapi.SkillName, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		imported = append(imported, tree.Name)
	}
	writeJSON(w, http.StatusOK, gatewayapi.SkillImportResponse{
		Skills: imported, Agents: results,
	})
}

// PreviewImmutableSkillImport handles POST /api/skill/import/preview.
func (s *Service) PreviewImmutableSkillImport(w http.ResponseWriter, r *http.Request, params gatewayapi.PreviewImmutableSkillImportParams) {
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
	items := make([]gatewayapi.ImmutableSkillImportPreviewItem, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		_, conflict := immutableNames[tree.Name]
		items = append(items, gatewayapi.ImmutableSkillImportPreviewItem{
			Name: tree.Name, Conflict: conflict,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.ImmutableSkillImportPreviewResponse{
		Skills: items,
	})
}

// ImportImmutableSkills handles POST /api/skill/import.
func (s *Service) ImportImmutableSkills(w http.ResponseWriter, r *http.Request, params gatewayapi.ImportImmutableSkillsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveSkillAccess(r.Context(), workspaceID, "", authorization.OperationCreateSkill)
	if apiErr != nil {
		if access.claims.OrganizationID != "" {
			err := s.createSkillEventTrail(r.Context(), access, "import", access.failureResult())
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	eventRecorded := false
	defer func() {
		if eventRecorded {
			return
		}
		err := s.createSkillEventTrail(
			context.WithoutCancel(r.Context()),
			access,
			"import",
			gatewaydb.EventTrailResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "event trail failed Skill import", slog.Any("err", err))
		}
	}()
	bundle, ok := readSkillUpload(w, r)
	if !ok {
		return
	}
	bundle, decisions, ok := readSkillImportDecisions(w, r, bundle)
	if !ok {
		return
	}
	agentNames, ok := readSkillImportAgentNames(w, r, false)
	if !ok {
		return
	}
	if len(agentNames) > 0 && workspaceID == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"Organisation skill imports cannot target Agents",
			errBadRequest,
		))
		return
	}
	agents, agentErr := s.resolveSkillImportAgents(r.Context(), agentNames)
	if agentErr != nil {
		writeError(w, r, agentErr)
		return
	}
	names := make([]gatewayapi.SkillName, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		names = append(names, tree.Name)
	}
	importErr := s.importImmutableSkills(r.Context(), bundle, decisions, access)
	if importErr != nil {
		writeError(w, r, importErr)
		return
	}
	eventRecorded = true
	if err := s.createSkillEventTrail(r.Context(), access, "import", gatewaydb.EventTrailResultSucceeded); err != nil {
		writeInternalError(w, r, err)
		return
	}
	refs := make([]agentzv1alpha1.ResourceReference, 0, len(bundle.Skills))
	for _, tree := range bundle.Skills {
		refs = append(refs, agentzv1alpha1.ResourceReference{
			Scope: agentzv1alpha1.ResourceScopeWorkspace,
			Name:  tree.Name,
		})
	}
	results := make([]gatewayapi.SkillImportAgentResult, len(agents))
	for i, agent := range agents {
		result := gatewayapi.SkillImportAgentResult{
			Agent:  agent.Agent.Name,
			Status: gatewayapi.SkillImportAgentResultStatusFailed,
		}
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			current, err := s.resolver.client.AgentzV1alpha1().Agents(access.namespace).Get(
				r.Context(), agent.Agent.Name, metav1.GetOptions{},
			)
			if err != nil {
				return err
			}
			current.Spec.Skills = append(current.Spec.Skills, refs...)
			slices.SortFunc(current.Spec.Skills, func(a, b agentzv1alpha1.ResourceReference) int {
				if a.Scope != b.Scope {
					return strings.Compare(string(a.Scope), string(b.Scope))
				}
				return strings.Compare(a.Name, b.Name)
			})
			current.Spec.Skills = slices.Compact(current.Spec.Skills)
			_, err = s.resolver.client.AgentzV1alpha1().Agents(access.namespace).Update(
				r.Context(), current, metav1.UpdateOptions{},
			)
			return err
		})
		if err != nil {
			message := err.Error()
			result.Error = &message
			results[i] = result
			continue
		}
		result.Status = gatewayapi.SkillImportAgentResultStatusSucceeded
		results[i] = result
	}
	writeJSON(w, http.StatusOK, gatewayapi.SkillImportResponse{
		Skills: names, Agents: results,
	})
}

func (s *Service) importImmutableSkills(ctx context.Context, bundle skill.Bundle, decisions []skill.Decision, access resourceAccess) *apiError {
	namespace := access.namespace
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	canModify := access.effective.Allows(scope, authorization.OperationUpdateSkill)
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
		if action == skill.DecisionOverwrite && !canModify && current.Spec.CreatedByUserID != access.claims.UserID {
			eventTrailAccess := access
			eventTrailAccess.operation = authorization.OperationUpdateSkill
			if err := s.createSkillEventTrail(ctx, eventTrailAccess, tree.Name, gatewaydb.EventTrailResultDenied); err != nil {
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
					ResourceAudit: agentzv1alpha1.ResourceAudit{
						CreatedByUserID:      access.claims.UserID,
						LastModifiedByUserID: access.claims.UserID,
					},
					Description: plan.tree.Description,
					Version:     plan.version,
					StoragePath: storagePath,
				},
			}
			if err := s.k8sClient.Create(ctx, item); err != nil {
				eventTrailErr := s.createSkillEventTrail(ctx, access, plan.tree.Name, gatewaydb.EventTrailResultFailed)
				applied := plans[:i+1]
				if apierrors.IsAlreadyExists(err) {
					applied = plans[:i]
				}
				cleanupErr := s.rollbackImmutableImport(ctx, namespace, applied, plans)
				return mapKubeHTTPError(
					"create immutable skill",
					errors.Join(err, cleanupErr, eventTrailErr),
				)
			}
			if err := s.createSkillEventTrail(ctx, access, plan.tree.Name, gatewaydb.EventTrailResultSucceeded); err != nil {
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
			item.Spec.LastModifiedByUserID = access.claims.UserID
			return s.k8sClient.Update(ctx, item)
		})
		if err != nil {
			eventTrailAccess := access
			eventTrailAccess.operation = authorization.OperationUpdateSkill
			eventTrailErr := s.createSkillEventTrail(ctx, eventTrailAccess, plan.tree.Name, gatewaydb.EventTrailResultFailed)
			applied := plans[:i+1]
			if apierrors.IsConflict(err) {
				applied = plans[:i]
			}
			cleanupErr := s.rollbackImmutableImport(ctx, namespace, applied, plans)
			return mapKubeHTTPError(
				"update immutable skill",
				errors.Join(err, cleanupErr, eventTrailErr),
			)
		}
		eventTrailAccess := access
		eventTrailAccess.operation = authorization.OperationUpdateSkill
		if err := s.createSkillEventTrail(ctx, eventTrailAccess, plan.tree.Name, gatewaydb.EventTrailResultSucceeded); err != nil {
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

func readSkillImportAgentNames(w http.ResponseWriter, r *http.Request, required bool) ([]gatewayapi.AgentName, bool) {
	values := r.MultipartForm.Value["agents"]
	if (required && len(values) == 0) || len(values) > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"skill import Agents are invalid",
			errBadRequest,
		))
		return nil, false
	}
	names := make([]gatewayapi.AgentName, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		name, ok := validAgentName(w, r, value, "agents")
		if !ok {
			return nil, false
		}
		if _, ok := seen[name]; ok {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"skill import Agents must be unique",
				errBadRequest,
			))
			return nil, false
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	slices.Sort(names)
	return names, true
}

func readSkillImportDecisions(w http.ResponseWriter, r *http.Request, bundle skill.Bundle) (skill.Bundle, []skill.Decision, bool) {
	values := r.MultipartForm.Value["decisions"]
	if len(values) != 1 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"skill import decisions are invalid",
			errBadRequest,
		))
		return skill.Bundle{}, nil, false
	}
	var decisions []skill.Decision
	if err := json.Unmarshal([]byte(values[0]), &decisions); err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"skill import decisions are invalid",
			err,
		))
		return skill.Bundle{}, nil, false
	}
	decided, err := bundle.Decide(decisions)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"decision_conflict",
			"skill import decisions conflict",
			err,
		))
		return skill.Bundle{}, nil, false
	}
	return decided, decisions, true
}

func (s *Service) resolveSkillImportAgents(ctx context.Context, names []gatewayapi.AgentName) ([]*resolvedAgent, *apiError) {
	agents := make([]*resolvedAgent, 0, len(names))
	for _, name := range names {
		access, apiErr := s.resolveAgentAccess(
			ctx, name, authorization.OperationUseSharedAgent,
		)
		if apiErr != nil {
			return nil, apiErr
		}
		agent, err := s.resolver.resolveAgent(ctx, access.namespace, name)
		if err != nil {
			return nil, mapKubeHTTPError("get Agent", err)
		}
		if statusFromAgent(agent.Agent).Phase != agentPhaseReady {
			return nil, newAPIError(
				http.StatusConflict,
				"agent_not_ready",
				"Agent is not ready",
				errBadRequest,
			)
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

func (s *Service) mutableSkillNames(ctx context.Context, agent *resolvedAgent) (map[string]struct{}, error) {
	target, err := s.filesystemTarget(agent)
	if err != nil {
		return nil, err
	}
	names := map[string]struct{}{}
	var token string
	for {
		endpoint := *target
		endpoint.Path = "/skill"
		query := url.Values{"limit": []string{"200"}}
		if token != "" {
			query.Set("page_token", token)
		}
		endpoint.RawQuery = query.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("create mutable skill list request: %w", err)
		}
		resp, err := s.outboundHTTP.Do(req)
		if err != nil {
			return nil, fmt.Errorf("list mutable skills: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			closeErr := resp.Body.Close()
			return nil, errors.Join(
				fmt.Errorf("list mutable skills returned %s", resp.Status),
				closeErr,
			)
		}
		var page gatewayapi.ListMutableSkillsResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&page)
		if err := errors.Join(decodeErr, resp.Body.Close()); err != nil {
			return nil, fmt.Errorf("decode mutable skill list: %w", err)
		}
		for _, item := range page.Skills {
			names[item.Name] = struct{}{}
		}
		token = page.NextPageToken
		if token == "" {
			return names, nil
		}
	}
}

func (s *Service) importMutableSkillArchive(ctx context.Context, agent *resolvedAgent, archive, decisions []byte) (result gatewayapi.SkillImportAgentResult) {
	result = gatewayapi.SkillImportAgentResult{
		Agent:  agent.Agent.Name,
		Status: gatewayapi.SkillImportAgentResultStatusFailed,
	}
	var err error
	defer func() {
		if err != nil {
			message := err.Error()
			result.Error = &message
			return
		}
		result.Status = gatewayapi.SkillImportAgentResultStatusSucceeded
	}()

	target, err := s.filesystemTarget(agent)
	if err != nil {
		return result
	}
	target.Path = "/skill/import"
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, target.String(), bytes.NewReader(archive),
	)
	if err != nil {
		return result
	}
	req.Header.Set("Content-Type", "application/zip")
	req.Header.Set("X-Agentz-Skill-Decisions", string(decisions))
	resp, err := s.outboundHTTP.Do(req)
	if err != nil {
		return result
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	err = errors.Join(readErr, resp.Body.Close())
	if err != nil {
		return result
	}
	if resp.StatusCode != http.StatusNoContent {
		err = fmt.Errorf(
			"mutable skill import returned %s: %s",
			resp.Status,
			body,
		)
	}
	return result
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
				err := s.createSkillEventTrail(r.Context(), access, name, access.failureResult())
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
			eventTrailErr := s.createSkillEventTrail(
				r.Context(), access, name, gatewaydb.EventTrailResultFailed)

			if err != nil || eventTrailErr != nil {
				writeInternalError(w, r, errors.Join(err, eventTrailErr))
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
			eventTrailErr := s.createSkillEventTrail(r.Context(), accesses[i], item.Name, gatewaydb.EventTrailResultFailed)
			if eventTrailErr != nil {
				writeInternalError(w, r, errors.Join(err, eventTrailErr))
				return
			}
			writeError(w, r, mapKubeHTTPError("delete immutable skill", err))
			return
		}
		if err := s.createSkillEventTrail(r.Context(), accesses[i], item.Name, gatewaydb.EventTrailResultSucceeded); err != nil {
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
	var effective map[agentzv1alpha1.ResourceReference]struct{}
	if params.AgentName != nil {
		name, ok := validAgentName(w, r, *params.AgentName, "agent_name")
		if !ok {
			return
		}
		resolved, err := s.effectiveAgentSkills(r.Context(), ns, name)
		if err != nil {
			writeError(w, r, mapKubeHTTPError("get agent skills", err))
			return
		}
		effective = resolved
	}
	local := &agentzv1alpha1.SkillList{}
	if err := s.k8sClient.List(r.Context(), local, ctrlclient.InNamespace(ns)); err != nil {
		writeInternalError(w, r, fmt.Errorf("list immutable skills: %w", err))
		return
	}
	refs, err := s.listSkillReferences(r.Context(), ns)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	userIDs := make([]string, 0, len(local.Items)*2)
	for _, item := range local.Items {
		userIDs = append(userIDs, item.Spec.CreatedByUserID, item.Spec.LastModifiedByUserID)
	}
	actors, err := s.resourceActors(r.Context(), userIDs...)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	items := make([]gatewayapi.ImmutableSkillSummary, 0, len(local.Items))
	authorizationScope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	localScope := agentzv1alpha1.ResourceScope(resourceScope(access.workspaceID))
	for _, item := range local.Items {
		if !item.DeletionTimestamp.IsZero() {
			continue
		}
		ref := agentzv1alpha1.ResourceReference{Scope: localScope, Name: item.Name}
		if effective != nil {
			if _, ok := effective[ref]; !ok {
				continue
			}
		}
		summary, err := s.skillStore.VersionSummary(
			r.Context(), ns, item.Name, item.Spec.Version,
		)
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("summarize immutable skill: %w", err))
			return
		}
		references := skillReferencesOrEmpty(refs[ref])
		creator := item.Spec.CreatedByUserID == access.claims.UserID &&
			access.effective.Allows(authorizationScope, authorization.OperationCreateSkill)
		items = append(items, gatewayapi.ImmutableSkillSummary{
			Name:           item.Name,
			Scope:          gatewayapi.ResourceScope(localScope),
			CreatedBy:      actors[item.Spec.CreatedByUserID],
			LastModifiedBy: actors[item.Spec.LastModifiedByUserID],
			CanModify:      access.effective.Allows(authorizationScope, authorization.OperationUpdateSkill) || creator,
			CanDelete:      access.effective.Allows(authorizationScope, authorization.OperationDeleteSkill) || creator,
			Description:    item.Spec.Description,
			Version:        item.Spec.Version,
			Agents:         references.Agents,
			Sandboxes:      references.Sandboxes,
			FileCount:      summary.FileCount,
			SizeBytes:      summary.SizeBytes,
			ModifiedAt:     summary.Modified,
		})
	}
	if access.workspaceID != "" {
		selected, err := s.selectedOrganizationResourceNames(
			r.Context(),
			access.workspaceID,
			access.claims.OrganizationID,
			agentzv1alpha1.OrganizationResourceKindSkill,
		)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		organizationNamespace := agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			access.claims.OrganizationID,
		)
		inherited := &agentzv1alpha1.SkillList{}
		if err := s.k8sClient.List(
			r.Context(), inherited, ctrlclient.InNamespace(organizationNamespace),
		); err != nil {
			writeInternalError(w, r, fmt.Errorf("list inherited Organisation Skills: %w", err))
			return
		}
		userIDs = make([]string, 0, len(inherited.Items)*2)
		for _, item := range inherited.Items {
			if _, ok := selected[item.Name]; !ok {
				continue
			}
			userIDs = append(userIDs, item.Spec.CreatedByUserID, item.Spec.LastModifiedByUserID)
		}
		actors, err = s.resourceActors(r.Context(), userIDs...)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		for _, item := range inherited.Items {
			if !item.DeletionTimestamp.IsZero() {
				continue
			}
			if _, ok := selected[item.Name]; !ok {
				continue
			}
			ref := agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeOrganisation,
				Name:  item.Name,
			}
			if effective != nil {
				if _, ok := effective[ref]; !ok {
					continue
				}
			}
			summary, err := s.skillStore.VersionSummary(
				r.Context(), organizationNamespace, item.Name, item.Spec.Version,
			)
			if err != nil {
				writeInternalError(w, r, fmt.Errorf("summarize inherited immutable skill: %w", err))
				return
			}
			references := skillReferencesOrEmpty(refs[ref])
			items = append(items, gatewayapi.ImmutableSkillSummary{
				Name:           item.Name,
				Scope:          gatewayapi.ResourceScopeOrganisation,
				CreatedBy:      actors[item.Spec.CreatedByUserID],
				LastModifiedBy: actors[item.Spec.LastModifiedByUserID],
				CanModify:      false,
				CanDelete:      false,
				Description:    item.Spec.Description,
				Version:        item.Spec.Version,
				Agents:         references.Agents,
				Sandboxes:      references.Sandboxes,
				FileCount:      summary.FileCount,
				SizeBytes:      summary.SizeBytes,
				ModifiedAt:     summary.Modified,
			})
		}
	}
	slices.SortFunc(items, func(a, b gatewayapi.ImmutableSkillSummary) int {
		if a.Name != b.Name {
			return strings.Compare(a.Name, b.Name)
		}
		return strings.Compare(string(a.Scope), string(b.Scope))
	})
	start := min(offset, len(items))
	end := min(start+limit, len(items))
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListImmutableSkillSummariesResponse{
		Skills: items[start:end], NextPageToken: next,
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
	var req gatewayapi.ExportImmutableSkillsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	selections := make([]skill.VersionSelection, 0, len(req.Skills))
	names := make(map[string]struct{}, len(req.Skills))
	for _, ref := range req.Skills {
		name := ref.Name
		if fields := validateSkillName("skills.name", name); len(fields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest, "invalid_request",
				"request validation failed", errBadRequest, fields...,
			))
			return
		}
		if _, exists := names[name]; exists {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"an export cannot contain duplicate skill names across scopes",
				errBadRequest,
			))
			return
		}
		names[name] = struct{}{}
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
			Namespace: ns,
			Name:      name,
			Version:   item.Spec.Version,
		})
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="skills.zip"`)
	if err := s.skillStore.WriteVersionsZIP(r.Context(), w, selections); err != nil {
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
