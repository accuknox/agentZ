package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListAgents handles GET /api/agent.
func (s *Service) ListAgents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListAgentsParams) {
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

	agentNames := []string{}
	if params.AgentName != nil {
		agentNames = make([]string, 0, len(*params.AgentName))
		for _, name := range *params.AgentName {
			agentName, ok := validAgentName(w, r, name, "agent_name")
			if !ok {
				return
			}
			agentNames = append(agentNames, agentName)
		}
	}

	items, next, err := s.listAgentItems(r.Context(), agentNames, limit, offset)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListAgentsResponse{
		Agents:        items,
		NextPageToken: next,
	})
}

// CreateAgent handles POST /api/agent.
//
//nolint:gocyclo
func (s *Service) CreateAgent(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.CreateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, fields := validateCreateAgentRequest(req)
	envFields, serr := s.validateAgentSandboxName(r.Context(), ns, req.SandboxName)
	fields = append(fields, envFields...)
	if serr != nil {
		writeInternalError(w, r, serr)
		return
	}
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

	row, err := s.queries.GatewayCreateAgent(r.Context(), gatewaydb.GatewayCreateAgentParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create agent", err))
		return
	}

	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agt := s.agentFromCreateRequest(req, ns, tenant, name)
	_, err = s.resolver.client.AgentzV1alpha1().Agents(ns).Create(
		r.Context(),
		agt,
		metav1.CreateOptions{},
	)
	if err != nil {
		if _, deleteErr := s.queries.GatewayDeleteAgent(r.Context(), gatewaydb.GatewayDeleteAgentParams{
			TenantNamespace: ns,
			AgentName:       name,
		}); deleteErr != nil {
			err = fmt.Errorf("create agent: %w; rollback record: %v", err, deleteErr)
		}
		writeError(w, r, mapKubeHTTPError("create agent", err))
		return
	}

	writeJSON(w, http.StatusCreated, gatewayapi.Agent{
		Name:         row.AgentName,
		SandboxName:  req.SandboxName,
		Skills:       skills,
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       gatewayapi.PROGRESSING,
	})
}

// UpdateAgent handles POST /api/agent/update/{agentName}.
func (s *Service) UpdateAgent(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateAgentRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	name, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	if fields := validateUpdateAgentRequest(req); len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}
	if req.SandboxName != nil {
		envFields, err := s.validateAgentSandboxName(r.Context(), ns, *req.SandboxName)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if len(envFields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				envFields...,
			))
			return
		}
	}
	if req.Skills != nil {
		var skillFields []gatewayapi.FieldError
		_, skillFields, err := s.validateSkillRefs(r.Context(), ns, *req.Skills)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if len(skillFields) > 0 {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				skillFields...,
			))
			return
		}
	}
	if !updateAgentRequestHasChanges(req) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{
				Field:   "body",
				Message: "must include at least one mutable field",
			},
		))
		return
	}

	row, err := s.queries.GatewayGetAgent(r.Context(), gatewaydb.GatewayGetAgentParams{
		TenantNamespace: ns,
		AgentName:       name,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get agent", err))
		return
	}

	var updated *agentzv1alpha1.Agent
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt, getErr := s.resolver.client.AgentzV1alpha1().Agents(ns).Get(
			r.Context(),
			row.AgentName,
			metav1.GetOptions{},
		)
		if getErr != nil {
			return getErr
		}
		applyUpdateAgentRequest(agt, req)
		updated, getErr = s.resolver.client.AgentzV1alpha1().Agents(ns).Update(
			r.Context(),
			agt,
			metav1.UpdateOptions{},
		)
		return getErr
	})
	if err != nil {
		writeError(w, r, mapKubeHTTPError("update agent", err))
		return
	}

	status := gatewayapi.PROGRESSING
	if view := statusFromAgent(updated); view != nil {
		status = statusFromView(view)
	}
	writeJSON(w, http.StatusOK, gatewayapi.Agent{
		Name:         row.AgentName,
		SandboxName:  updated.Spec.SandboxRef.Name,
		CreatedAt:    row.CreatedAt,
		ModifiedAt:   row.UpdatedAt,
		LastActivity: row.UpdatedAt,
		Status:       status,
		Skills:       append([]gatewayapi.SkillName{}, updated.Spec.Skills...),
	})
}

// DeleteAgent handles DELETE /api/agent/{agentName}.
func (s *Service) DeleteAgent(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetAgent(r.Context(), gatewaydb.GatewayGetAgentParams{
		TenantNamespace: ns,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get agent", err))
		return
	}
	err = s.resolver.client.AgentzV1alpha1().Agents(ns).Delete(
		r.Context(),
		row.AgentName,
		metav1.DeleteOptions{
			PropagationPolicy: new(metav1.DeletePropagationBackground),
		},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		writeError(w, r, mapKubeHTTPError("delete agent", err))
		return
	}

	if err := s.deleteAgentSecretResources(r.Context(), ns, agentName); err != nil {
		writeError(w, r, mapKubeHTTPError("delete agent secrets", err))
		return
	}

	rows, err := s.queries.GatewayDeleteAgent(r.Context(), gatewaydb.GatewayDeleteAgentParams{
		TenantNamespace: ns,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("delete agent", err))
		return
	}
	if rows == 0 {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
			errAgentNotFound,
		))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// WatchAgents handles POST /api/agent/watch.
//
//nolint:gocyclo
func (s *Service) WatchAgents(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.WatchAgentsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}

	agentNames := []string{}
	agentFilter := map[string]struct{}{}
	if req.AgentNames != nil {
		agentNames = make([]string, 0, len(*req.AgentNames))
		for _, name := range *req.AgentNames {
			agentName, ok := validAgentName(w, r, name, "agent_names")
			if !ok {
				return
			}
			agentNames = append(agentNames, agentName)
			agentFilter[agentName] = struct{}{}
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"streaming is unavailable",
			nil,
		))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := make(map[string]gatewayapi.Agent)
	send := func(event string, items []gatewayapi.Agent) bool {
		if len(items) == 0 {
			return true
		}
		raw, err := json.Marshal(gatewayapi.WatchAgentsEvent{Agents: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if event != "" {
			if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	events, cancel := s.resolver.watchAgents()
	defer cancel()

	writeChanges := func() bool {
		items, _, err := s.listAgentItems(r.Context(), agentNames, 200, 0)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		changed := make([]gatewayapi.Agent, 0, len(items))
		for _, item := range items {
			prevItem, ok := prev[item.Name]
			unchanged := ok &&
				prevItem.Name == item.Name &&
				prevItem.SandboxName == item.SandboxName &&
				prevItem.LastActivity.Equal(item.LastActivity) &&
				prevItem.CreatedAt.Equal(item.CreatedAt) &&
				prevItem.ModifiedAt.Equal(item.ModifiedAt) &&
				prevItem.Status == item.Status &&
				slices.Equal(prevItem.Skills, item.Skills)
			if unchanged {
				continue
			}
			prev[item.Name] = item
			changed = append(changed, item)
		}
		return send("", changed)
	}

	if !writeChanges() {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == agentWatchEventDeleted {
				if evt.Agent == nil || evt.Agent.Namespace != ns {
					continue
				}
				if len(agentFilter) > 0 {
					if _, ok := agentFilter[evt.Agent.Name]; !ok {
						continue
					}
				}

				item, ok := prev[evt.Agent.Name]
				delete(prev, evt.Agent.Name)
				if ok {
					item.Status = gatewayapi.DELETED
				}
				if ok && !send("DELETE", []gatewayapi.Agent{item}) {
					return
				}
				continue
			}
			if !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) listAgentItems(ctx context.Context, agentNames []string, limit int, offset int) ([]gatewayapi.Agent, string, error) {
	ns, err := tenantNamespace(ctx)
	if err != nil {
		return nil, "", err
	}

	var rows []gatewaydb.Agent
	if len(agentNames) > 0 {
		rows, err = s.queries.GatewayListAgentsByName(ctx, gatewaydb.GatewayListAgentsByNameParams{
			TenantNamespace: ns,
			Column2:         agentNames,
			Limit:           int32(limit + 1),
			Offset:          int32(offset),
		})
	}
	if len(agentNames) == 0 {
		rows, err = s.queries.GatewayListAgents(ctx, gatewaydb.GatewayListAgentsParams{
			TenantNamespace: ns,
			Limit:           int32(limit + 1),
			Offset:          int32(offset),
		})
	}
	if err != nil {
		return nil, "", err
	}

	items := make([]gatewayapi.Agent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodeOffsetToken(offset + limit)
			continue
		}

		status := gatewayapi.UNSPECIFIED
		sandboxName := gatewayapi.SandboxName("")
		resolved, resolveErr := s.resolver.resolveAgent(ctx, ns, row.AgentName)
		if resolveErr != nil && !errors.Is(resolveErr, errAgentNotFound) {
			return nil, "", resolveErr
		}
		if resolved != nil && resolved.Agent != nil {
			status = statusFromView(statusFromAgent(resolved.Agent))
			sandboxName = resolved.Agent.Spec.SandboxRef.Name
			skills := append([]gatewayapi.SkillName{}, resolved.Agent.Spec.Skills...)
			items = append(items, gatewayapi.Agent{
				Name:         row.AgentName,
				SandboxName:  sandboxName,
				LastActivity: row.UpdatedAt,
				CreatedAt:    row.CreatedAt,
				ModifiedAt:   row.UpdatedAt,
				Status:       status,
				Skills:       skills,
			})
			continue
		}

		items = append(items, gatewayapi.Agent{
			Name:         row.AgentName,
			SandboxName:  sandboxName,
			LastActivity: row.UpdatedAt,
			CreatedAt:    row.CreatedAt,
			ModifiedAt:   row.UpdatedAt,
			Status:       status,
			Skills:       []gatewayapi.SkillName{},
		})
	}
	return items, next, nil
}

//nolint:gocyclo
func validateCreateAgentRequest(req gatewayapi.CreateAgentRequest) (string, []gatewayapi.FieldError) {
	fields := []gatewayapi.FieldError{}

	name := strings.TrimSpace(req.Name)
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
	if name == agentzv1alpha1.AgentNameMCPConnection {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "name",
			Message: "reserved agent name",
		})
	}

	fields = append(fields, validateOpenCodeRequest(req.Opencode)...)

	return name, fields
}

func validateAgentSandboxNameField(fields []gatewayapi.FieldError, name string) []gatewayapi.FieldError {
	name = strings.TrimSpace(name)
	if name == "" {
		return append(fields, gatewayapi.FieldError{
			Field: "sandboxName", Message: "required",
		})
	}
	if len(name) > 32 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "sandboxName", Message: "must be at most 32 characters",
		})
	}
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field: "sandboxName", Message: "must be a valid DNS label",
		})
	}
	return fields
}

func (s *Service) validateAgentSandboxName(ctx context.Context, namespace string, name gatewayapi.SandboxName) ([]gatewayapi.FieldError, error) {
	fields := validateAgentSandboxNameField(nil, name)
	if len(fields) > 0 {
		return fields, nil
	}

	var sandbox agentzv1alpha1.Sandbox
	key := types.NamespacedName{Namespace: namespace, Name: name}
	if err := s.k8sClient.Get(ctx, key, &sandbox); err != nil {
		if apierrors.IsNotFound(err) {
			return []gatewayapi.FieldError{{
				Field:   "sandboxName",
				Message: "sandbox not found",
			}}, nil
		}
		return nil, fmt.Errorf("get sandbox %q: %w", name, err)
	}
	return nil, nil
}

func (s *Service) agentFromCreateRequest(req gatewayapi.CreateAgentRequest, namespace string, tenant *agentzv1alpha1.Tenant, name string) *agentzv1alpha1.Agent {
	sandbox := []corev1.EnvVar{}
	if req.Env != nil {
		sandbox = envVarsFromMap(*req.Env)
	}
	agt := &agentzv1alpha1.Agent{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Agent",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				labelManagedBy: "agentz-agent-gateway",
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(
					tenant,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
				),
			},
		},
		Spec: agentzv1alpha1.AgentSpec{
			Image: s.cfg.AgentImage,
			Env:   sandbox,
			Telemetry: agentzv1alpha1.TelemetryConfig{
				Enabled:       true,
				TraceEndpoint: s.cfg.AgentTraceEndpoint,
			},
			SandboxRef: &corev1.LocalObjectReference{
				Name: req.SandboxName,
			},
		},
	}
	if req.Skills != nil {
		agt.Spec.Skills = slices.Clone(*req.Skills)
	}
	applyOpencodeRequest(&agt.Spec, req.Opencode)
	return agt
}

func updateAgentRequestHasChanges(req gatewayapi.UpdateAgentRequest) bool {
	if req.Env != nil {
		return true
	}
	if req.SandboxName != nil {
		return true
	}
	if req.Opencode != nil {
		return true
	}
	if req.Skills != nil {
		return true
	}
	return false
}

func validateUpdateAgentRequest(req gatewayapi.UpdateAgentRequest) []gatewayapi.FieldError {
	return validateOpenCodeRequest(req.Opencode)
}

func applyUpdateAgentRequest(agt *agentzv1alpha1.Agent, req gatewayapi.UpdateAgentRequest) {
	if req.Env != nil {
		agt.Spec.Env = envVarsFromMap(*req.Env)
	}
	if req.SandboxName != nil {
		agt.Spec.SandboxRef = &corev1.LocalObjectReference{
			Name: *req.SandboxName,
		}
	}
	if req.Skills != nil {
		agt.Spec.Skills = slices.Clone(*req.Skills)
	}
	applyOpencodeRequest(&agt.Spec, req.Opencode)
}

func envVarsFromMap(items map[string]string) []corev1.EnvVar {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	sandbox := make([]corev1.EnvVar, 0, len(keys))
	for _, key := range keys {
		sandbox = append(sandbox, corev1.EnvVar{Name: key, Value: items[key]})
	}
	return sandbox
}

func validateOpenCodeRequest(cfg *gatewayapi.AgentOpencodeConfig) []gatewayapi.FieldError {
	if cfg == nil {
		return nil
	}

	fields := []gatewayapi.FieldError{}
	if cfg.Model != nil && !isValidModelRef(*cfg.Model) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.model",
			Message: "must be in provider/model form",
		})
	}
	if cfg.SmallModel != nil && !isValidModelRef(*cfg.SmallModel) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.smallModel",
			Message: "must be in provider/model form",
		})
	}
	if cfg.Instruction != nil && strings.TrimSpace(*cfg.Instruction) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.instruction",
			Message: "instruction must not be empty",
		})
	}
	if cfg.Instruction != nil && len(*cfg.Instruction) > 4096 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "opencode.instruction",
			Message: "instruction must be at most 4096 characters",
		})
	}
	if cfg.Providers == nil {
		return fields
	}

	for name, provider := range *cfg.Providers {
		if strings.TrimSpace(name) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "opencode.providers",
				Message: "provider name must not be empty",
			})
		}
		if provider.Env != nil {
			for i, sandboxName := range *provider.Env {
				if strings.TrimSpace(sandboxName) == "" {
					fields = append(fields, gatewayapi.FieldError{
						Field:   fmt.Sprintf("opencode.providers.%s.sandbox.%d", name, i),
						Message: "sandbox var name must not be empty",
					})
					continue
				}
				if errs := validation.IsEnvVarName(sandboxName); len(errs) > 0 {
					fields = append(fields, gatewayapi.FieldError{
						Field:   fmt.Sprintf("opencode.providers.%s.sandbox.%d", name, i),
						Message: strings.Join(errs, ", "),
					})
				}
			}
		}
		if provider.BaseURL == nil || strings.TrimSpace(*provider.BaseURL) == "" {
			continue
		}
		parsed, err := url.Parse(*provider.BaseURL)
		if err != nil {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("opencode.providers.%s.baseURL", name),
				Message: fmt.Sprintf("parse url: %v", err),
			})
			continue
		}
		if !parsed.IsAbs() {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fmt.Sprintf("opencode.providers.%s.baseURL", name),
				Message: "must be an absolute url",
			})
		}
	}

	return fields
}

func applyOpencodeRequest(spec *agentzv1alpha1.AgentSpec, cfg *gatewayapi.AgentOpencodeConfig) {
	if cfg == nil {
		return
	}

	if cfg.Model != nil {
		spec.Model = *cfg.Model
	}
	if cfg.SmallModel != nil {
		spec.SmallModel = *cfg.SmallModel
	}
	if cfg.Instruction != nil {
		spec.Instruction = *cfg.Instruction
	}
	if cfg.Providers == nil {
		return
	}

	spec.Providers = make(
		map[string]agentzv1alpha1.OpencodeProviderConfig,
		len(*cfg.Providers),
	)
	for name, provider := range *cfg.Providers {
		item := agentzv1alpha1.OpencodeProviderConfig{}
		if provider.Env != nil && len(*provider.Env) > 0 {
			item.Env = append([]string{}, (*provider.Env)...)
		}
		if provider.BaseURL != nil {
			item.BaseURL = *provider.BaseURL
		}
		spec.Providers[name] = item
	}
}

func isValidModelRef(v string) bool {
	provider, model, ok := strings.Cut(v, "/")
	if !ok {
		return false
	}
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" {
		return false
	}
	return true
}

func statusFromView(view *agentStatusView) gatewayapi.AgentStatus {
	switch view.Phase {
	case agentPhaseReady:
		return gatewayapi.IDLE
	case agentPhaseProgressing:
		return gatewayapi.PROGRESSING
	case agentPhaseDegraded:
		return gatewayapi.DEGRADED
	case agentPhaseNotFound:
		return gatewayapi.UNSPECIFIED
	default:
		return gatewayapi.UNSPECIFIED
	}
}
