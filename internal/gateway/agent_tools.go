package gateway

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation/field"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/tool"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ListAgentTools reads live definitions and rollout state instead of cached agent summaries.
func (s *Service) ListAgentTools(w http.ResponseWriter, r *http.Request, agentName string) {
	s.agentTools(w, r, agentName, "", "")
}

// GetAgentTool reads an uploaded definition for users who can use its agent.
func (s *Service) GetAgentTool(w http.ResponseWriter, r *http.Request, agentName, toolName string) {
	s.agentTools(w, r, agentName, toolName, "")
}

// CreateAgentTool adds a trusted script without granting broader agent modification rights.
func (s *Service) CreateAgentTool(w http.ResponseWriter, r *http.Request, agentName string) {
	s.agentTools(w, r, agentName, "", "")
}

// UpdateAgentTool replaces source or metadata using the caller's resource version.
func (s *Service) UpdateAgentTool(w http.ResponseWriter, r *http.Request, agentName, toolName string) {
	s.agentTools(w, r, agentName, toolName, "")
}

// DeleteAgentTool removes only the definition the caller reviewed.
func (s *Service) DeleteAgentTool(w http.ResponseWriter, r *http.Request, agentName, toolName string, params gatewayapi.DeleteAgentToolParams) {
	s.agentTools(w, r, agentName, toolName, params.ResourceVersion)
}

func (s *Service) agentTools(w http.ResponseWriter, r *http.Request, name, toolName, version string) {
	ctx := r.Context()
	// Agent API keys and system actors can invoke tools, but only human claims
	// authorize uploading executable source. Reuse the same use grant as chat.
	if _, apiErr := externalWorkspaceClaims(ctx); apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	access, apiErr := s.resolveAgentAccess(ctx, name, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	agents := s.resolver.client.AgentzV1alpha1().Agents(access.namespace)
	agt, err := agents.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get agent", err))
		return
	}
	if !agt.DeletionTimestamp.IsZero() {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "conflict", "agent is being deleted", nil))
		return
	}
	idx := slices.IndexFunc(agt.Spec.Tools, func(t agentzv1alpha1.AgentTool) bool { return t.Name == toolName })
	if r.Method != http.MethodPost && toolName != "" && idx < 0 {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusNotFound, "not_found", "tool not found", nil))
		return
	}
	if r.Method == http.MethodGet {
		if toolName != "" {
			apiutil.WriteJSON(w, http.StatusOK, agt.Spec.Tools[idx])
			return
		}
		apiutil.WriteJSON(w, http.StatusOK, agentToolsResponse(agt))
		return
	}

	before := agt.DeepCopy()
	action := "agent.tool.delete"
	if r.Method != http.MethodDelete {
		var req gatewayapi.WriteAgentToolRequest
		if !decodeJSONBody(w, r, &req, false) {
			return
		}
		version = req.ResourceVersion
		if r.Method == http.MethodPost {
			toolName = req.Tool.Name
			duplicate := slices.ContainsFunc(agt.Spec.Tools, func(t agentzv1alpha1.AgentTool) bool { return t.Name == toolName })
			if duplicate {
				apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "conflict", "tool name is already in use", nil))
				return
			}
			agt.Spec.Tools = append(agt.Spec.Tools, req.Tool)
			action = "agent.tool.create"
		} else {
			if req.Tool.Name != toolName {
				apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "tool names cannot be changed", nil))
				return
			}
			agt.Spec.Tools[idx] = req.Tool
			action = "agent.tool.replace"
		}
		validation := tool.Validate(agt.Spec.Tools, field.NewPath("tools"))
		if len(validation) > 0 {
			fields := make([]gatewayapi.FieldError, 0, len(validation))
			for _, e := range validation {
				fields = append(fields, gatewayapi.FieldError{Field: e.Field, Message: e.Detail})
			}
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "tool validation failed", nil, fields...))
			return
		}
	} else {
		agt.Spec.Tools = slices.Delete(agt.Spec.Tools, idx, idx+1)
	}
	if version == "" || version != agt.ResourceVersion {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "conflict", "agent changed; refresh the tools before saving again", nil))
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("begin tool update: %w", err))
		return
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	agt.Spec.LastModifiedByUserID = access.claims.UserID
	updated, err := agents.Update(ctx, agt, metav1.UpdateOptions{})
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("update tool", err))
		return
	}
	_, err = q.GatewayTouchAgent(ctx, gatewaydb.GatewayTouchAgentParams{
		TenantNamespace: access.namespace, AgentName: name, UpdatedAt: time.Now().UTC(),
	})
	if err == nil {
		err = createAgentEventTrail(ctx, q, agentEvent{
			access: access, name: name, action: action,
			before: []gatewayapi.EventTrailField{
				{Field: gatewayapi.EventTrailFieldName, Value: toolName},
				{Field: gatewayapi.EventTrailFieldState, Value: before.ResourceVersion},
			},
			after: []gatewayapi.EventTrailField{
				{Field: gatewayapi.EventTrailFieldName, Value: toolName},
				{Field: gatewayapi.EventTrailFieldState, Value: updated.ResourceVersion},
			},
		})
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		// Roll back only our version. A concurrent edit or controller status
		// write must never be overwritten to compensate for an audit failure.
		before.ResourceVersion = updated.ResourceVersion
		_, rollbackErr := agents.Update(ctx, before, metav1.UpdateOptions{})
		if rollbackErr != nil {
			slog.ErrorContext(ctx, "tool update rollback failed", "agent", name, "error", rollbackErr)
		}
		apiutil.WriteInternalError(w, r, errors.Join(err, rollbackErr))
		return
	}
	status := http.StatusOK
	if r.Method == http.MethodPost {
		status = http.StatusCreated
	}
	apiutil.WriteJSON(w, status, agentToolsResponse(updated))
}

func agentToolsResponse(agt *agentzv1alpha1.Agent) gatewayapi.AgentTools {
	view := statusFromAgent(agt)
	applied := agt.Status.ObservedGeneration == agt.Generation
	status := statusFromView(view)
	if !applied && status != gatewayapi.DEGRADED {
		status = gatewayapi.PROGRESSING
	}
	tools := agt.Spec.Tools
	if tools == nil {
		tools = []agentzv1alpha1.AgentTool{}
	}
	return gatewayapi.AgentTools{
		Tools: tools, ResourceVersion: agt.ResourceVersion,
		Applied: applied && status == gatewayapi.IDLE, Status: status, Message: view.Message,
	}
}
