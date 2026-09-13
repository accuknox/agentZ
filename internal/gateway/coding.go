package gateway

import (
	"bytes"
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"strings"
	"text/template"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/gateway/filesystem"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

//go:embed prompts/*.tmpl
var codingPromptFiles embed.FS

var codingPrompts = template.Must(template.ParseFS(codingPromptFiles, "prompts/*.tmpl"))

type codingPromptData struct {
	Text   string
	Branch string
	Files  string
	Patch  string
}

// codingWorktree exposes the agent path and keeps deleting checkouts unavailable.
func codingWorktree(tree gatewaydb.CodingWorktree) gatewayapi.CodingWorktree {
	return gatewayapi.CodingWorktree{
		Id:        tree.ID,
		ProjectId: tree.ProjectID,
		AgentName: tree.AgentName,
		Directory: "/home/agentz/" + tree.Directory,
		Branch:    tree.Branch,
		Ready:     tree.Ready && !tree.Deleting,
		Shared:    tree.Shared,
	}
}

// codingAccess requires a human in a Coding workspace. Administrator privileges
// never replace the owner predicate on the project queries below.
func (s *Service) codingAccess(ctx context.Context, agentName string) (resourceAccess, *apiError) {
	if _, apiErr := externalWorkspaceClaims(ctx); apiErr != nil {
		return resourceAccess{}, apiErr
	}
	operation := authorization.OperationListAgents
	if agentName != "" {
		operation = authorization.OperationUseSharedAgent
	}
	access, apiErr := s.resolveAgentAccess(ctx, agentName, operation)
	if apiErr != nil {
		return access, apiErr
	}
	workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{ID: access.workspaceID, OrganizationID: access.claims.OrganizationID})
	if err != nil {
		return access, mapGatewayStoreError("get workspace", err)
	}
	if workspace.Type != gatewaydb.WorkspaceTypeCoding {
		return access, newAPIError(http.StatusNotFound, "not_found", "Coding workspace required", nil)
	}

	return access, nil
}

// ListCodingProjects lists only projects owned by the caller in this workspace.
func (s *Service) ListCodingProjects(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	rows, err := s.queries.GatewayListCodingProjects(r.Context(), gatewaydb.GatewayListCodingProjectsParams{WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	projects := make([]gatewayapi.CodingProject, 0, len(rows))
	for _, row := range rows {
		projects = append(projects, gatewayapi.CodingProject{
			Id:            row.ID,
			Name:          row.Name,
			Repository:    row.Repository,
			RepositoryId:  row.RepositoryID,
			DefaultBranch: row.DefaultBranch,
			CreatedAt:     row.CreatedAt.Time,
		})
	}
	writeJSON(w, http.StatusOK, projects)
}

// CreateCodingProject records a personal repository without provisioning a checkout.
func (s *Service) CreateCodingProject(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(usableAgentNames(nil, capabilities)) == 0 {
		writeError(w, r, resourceForbidden(errors.New("a usable agent is required")))
		return
	}
	var req gatewayapi.CreateCodingProjectRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	project, err := s.queries.GatewayCreateCodingProject(r.Context(), gatewaydb.GatewayCreateCodingProjectParams{ID: uuid.NewString(), WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID, Name: req.Name, RepositoryID: req.RepositoryId, Repository: req.Repository, DefaultBranch: req.DefaultBranch})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("create project", err))
		return
	}
	writeJSON(w, http.StatusCreated, gatewayapi.CodingProject{
		Id:            project.ID,
		Name:          project.Name,
		Repository:    project.Repository,
		RepositoryId:  project.RepositoryID,
		DefaultBranch: project.DefaultBranch,
		CreatedAt:     project.CreatedAt.Time,
	})
}

// GetCodingProject includes threads only on agents the caller can use.
func (s *Service) GetCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(r.Context(), gatewaydb.GatewayGetCodingProjectParams{ID: projectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	trees, err := s.queries.GatewayListCodingWorktrees(r.Context(), gatewaydb.GatewayListCodingWorktreesParams{ProjectID: projectId, WorkspaceID: access.workspaceID})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	threads, err := s.queries.GatewayListCodingThreads(r.Context(), gatewaydb.GatewayListCodingThreadsParams{ProjectID: projectId, WorkspaceID: access.workspaceID})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	result := gatewayapi.CodingProjectDetail{
		Project: gatewayapi.CodingProject{
			Id:            project.ID,
			Name:          project.Name,
			Repository:    project.Repository,
			RepositoryId:  project.RepositoryID,
			DefaultBranch: project.DefaultBranch,
			CreatedAt:     project.CreatedAt.Time,
		},
		Worktrees: []gatewayapi.CodingWorktree{},
		Threads:   []gatewayapi.CodingThread{},
	}
	for _, tree := range trees {
		if capabilities[tree.AgentName].Use {
			result.Worktrees = append(result.Worktrees, codingWorktree(tree))
		}
	}
	for _, thread := range threads {
		if capabilities[thread.CodingThread.AgentName].Use {
			result.Threads = append(result.Threads, gatewayapi.CodingThread{
				Id:           thread.CodingThread.ID,
				SessionId:    thread.CodingThread.SessionID.String,
				Worktree:     codingWorktree(thread.CodingWorktree),
				Repository:   thread.CodingProject.Repository,
				RepositoryId: thread.CodingProject.RepositoryID,
			})
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// RenameCodingProject renames a project owned by the caller.
func (s *Service) RenameCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	var req gatewayapi.RenameCodingProjectJSONBody
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	count, err := s.queries.GatewayRenameCodingProject(r.Context(), gatewaydb.GatewayRenameCodingProjectParams{ID: projectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID, Name: req.Name})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if count == 0 {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "project not found", nil))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteCodingProject removes an owned project after its checkouts are removed.
func (s *Service) DeleteCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	_, err := s.queries.GatewayGetCodingProject(r.Context(), gatewaydb.GatewayGetCodingProjectParams{ID: projectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	q, release, err := s.lockCodingProject(r.Context(), projectId)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	defer release()
	count, err := q.GatewayDeleteCodingProject(r.Context(), gatewaydb.GatewayDeleteCodingProjectParams{ID: projectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if count == 0 {
		writeError(w, r, newAPIError(http.StatusConflict, "cleanup_required", "Clean up every project checkout before deleting this project", nil))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CreateCodingThread prepares a checkout and binds an agent session to it.
func (s *Service) CreateCodingThread(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateCodingThreadRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), req.AgentName)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(r.Context(), gatewaydb.GatewayGetCodingProjectParams{ID: req.ProjectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	q, release, err := s.lockCodingProject(r.Context(), project.ID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	defer release()
	// Read the owner predicate again after the lock, since deletion may have won.
	project, err = q.GatewayGetCodingProject(r.Context(), gatewaydb.GatewayGetCodingProjectParams{ID: req.ProjectId, WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	existing, err := q.GatewayGetCodingThread(r.Context(), gatewaydb.GatewayGetCodingThreadParams{WorkspaceID: access.workspaceID, AgentName: req.AgentName, ID: req.Id})
	var thread gatewaydb.CodingThread
	var tree gatewaydb.CodingWorktree
	if err == nil {
		if existing.CodingProject.ID != project.ID {
			writeError(w, r, newAPIError(http.StatusConflict, "conflict", "Thread belongs to another project", nil))
			return
		}
		thread, tree = existing.CodingThread, existing.CodingWorktree
	} else if errors.Is(err, pgx.ErrNoRows) {
		if req.WorktreeId != nil {
			existingTree, err := q.GatewayGetCodingWorktree(r.Context(), gatewaydb.GatewayGetCodingWorktreeParams{ID: *req.WorktreeId, WorkspaceID: access.workspaceID})
			if err != nil {
				writeError(w, r, mapGatewayStoreError("get worktree", err))
				return
			}
			tree = existingTree.CodingWorktree
			if tree.AgentName != req.AgentName || tree.ProjectID != project.ID || !tree.Ready || tree.Deleting {
				writeError(w, r, newAPIError(http.StatusConflict, "conflict", "Worktree is unavailable for this project and agent", nil))
				return
			}
			if err := q.GatewayShareCodingWorktree(r.Context(), tree.ID); err != nil {
				writeInternalError(w, r, err)
				return
			}
			tree.Shared = true
		} else {
			id := req.Id
			root := path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID)
			directory, branch := root+"/worktrees/"+id, "chore/"+id
			if req.MainCheckout != nil && *req.MainCheckout {
				directory, branch = root+"/repo", project.DefaultBranch
			}
			tree, err = q.GatewayCreateCodingWorktree(r.Context(), gatewaydb.GatewayCreateCodingWorktreeParams{ID: id, WorkspaceID: access.workspaceID, ProjectID: project.ID, AgentName: req.AgentName, Directory: directory, Branch: branch})
			if err != nil {
				writeError(w, r, mapGatewayStoreError("create worktree", err))
				return
			}
		}
		thread, err = q.GatewayCreateCodingThread(r.Context(), gatewaydb.GatewayCreateCodingThreadParams{ID: req.Id, WorkspaceID: access.workspaceID, AgentName: req.AgentName, WorktreeID: tree.ID})
		if err != nil {
			writeError(w, r, mapGatewayStoreError("create thread", err))
			return
		}
	} else {
		writeInternalError(w, r, err)
		return
	}
	if tree.Deleting {
		writeError(w, r, newAPIError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil))
		return
	}
	if thread.SessionID.Valid {
		writeJSON(w, http.StatusCreated, gatewayapi.CodingThread{
			Id:           thread.ID,
			SessionId:    thread.SessionID.String,
			Worktree:     codingWorktree(tree),
			Repository:   project.Repository,
			RepositoryId: project.RepositoryID,
		})
		return
	}
	base := project.DefaultBranch
	if req.BaseBranch != nil {
		base = *req.BaseBranch
	}
	if !tree.Ready {
		result, err := s.codingFilesystem(r.Context(), access.namespace, tree, project, true, base, gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus, Bundle: req.Bundle})
		if err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "checkout_failed", err.Error(), err))
			return
		}
		tree.Branch = result.Branch
	}
	err = q.GatewayRecordCodingMainCheckout(r.Context(), gatewaydb.GatewayRecordCodingMainCheckoutParams{
		ID: uuid.NewString(), WorkspaceID: access.workspaceID, ProjectID: project.ID, AgentName: tree.AgentName,
		Directory: path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID, "repo"), Branch: base,
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !tree.Ready {
		// A ready checkout must have its actual branch and main checkout recorded
		// so retries can skip preparation without losing either binding.
		err = q.GatewayReadyCodingWorktree(r.Context(), gatewaydb.GatewayReadyCodingWorktreeParams{ID: tree.ID, Branch: tree.Branch})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		tree.Ready = true
	}
	session, err := s.createCodingSession(r.Context(), access.namespace, tree, thread.ID)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "session_failed", "Failed to prepare agent session; retry to resume", err))
		return
	}
	// Persist the catalog first so a retry can repair it before the binding makes
	// thread creation return early. Both writes are idempotent.
	err = s.storeOpenCodeSession(r.Context(), access.workspaceID, req.AgentName, gatewaydb.ChatSessionKindChat, session)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	err = q.GatewaySetCodingThreadSession(r.Context(), gatewaydb.GatewaySetCodingThreadSessionParams{ID: thread.ID, SessionID: pgtype.Text{String: session.Id, Valid: true}})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	thread.SessionID = pgtype.Text{String: session.Id, Valid: true}
	writeJSON(w, http.StatusCreated, gatewayapi.CodingThread{
		Id:           thread.ID,
		SessionId:    thread.SessionID.String,
		Worktree:     codingWorktree(tree),
		Repository:   project.Repository,
		RepositoryId: project.RepositoryID,
	})
}

// codingClient routes the generated gateway client directly to the agent while
// retaining the caller's transport and request timeout.
func (s *Service) codingClient(ctx context.Context, namespace, agentName string, httpClient *http.Client) (*gatewayapi.ClientWithResponses, error) {
	resolved, err := s.resolver.resolveAgent(ctx, namespace, agentName)
	if err != nil {
		return nil, err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return nil, err
	}
	return gatewayapi.NewClientWithResponses(target.String(),
		gatewayapi.WithHTTPClient(httpClient),
		gatewayapi.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/opencode/"+agentName)
			return nil
		}),
	)
}

func (s *Service) createCodingSession(ctx context.Context, namespace string, tree gatewaydb.CodingWorktree, threadID string) (gatewayapi.OpencodeSession, error) {
	client, err := s.codingClient(ctx, namespace, tree.AgentName, s.outboundHTTP)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	directory := "/home/agentz/" + tree.Directory
	sessions, err := client.SessionListWithResponse(ctx, tree.AgentName, &gatewayapi.SessionListParams{Directory: &directory})
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	if sessions.JSON200 == nil {
		return gatewayapi.OpencodeSession{}, errors.New("could not inspect existing sessions")
	}
	for _, session := range *sessions.JSON200 {
		if session.Metadata != nil && (*session.Metadata)["agentz.codingThread"] == threadID {
			return session, nil
		}
	}
	metadata := map[string]any{"agentz.codingThread": threadID}
	// OpenCode generates a title after the first prompt only for untitled sessions.
	session, err := client.SessionCreateWithResponse(ctx, tree.AgentName,
		&gatewayapi.SessionCreateParams{Directory: &directory},
		gatewayapi.SessionCreateJSONRequestBody{Metadata: &metadata},
	)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	if session.JSON200 == nil {
		return gatewayapi.OpencodeSession{}, fmt.Errorf("create session returned %d", session.StatusCode())
	}
	return *session.JSON200, nil
}

// GetCodingThread returns a binding for a session on an accessible agent.
func (s *Service) GetCodingThread(w http.ResponseWriter, r *http.Request, agentName, sessionId string) {
	access, apiErr := s.codingAccess(r.Context(), agentName)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	thread, err := s.queries.GatewayGetCodingThread(r.Context(), gatewaydb.GatewayGetCodingThreadParams{WorkspaceID: access.workspaceID, AgentName: agentName, SessionID: pgtype.Text{String: sessionId, Valid: true}})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get thread", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.CodingThread{
		Id:           thread.CodingThread.ID,
		SessionId:    thread.CodingThread.SessionID.String,
		Worktree:     codingWorktree(thread.CodingWorktree),
		Repository:   thread.CodingProject.Repository,
		RepositoryId: thread.CodingProject.RepositoryID,
	})
}

// SuggestCodingText drafts source-control text without tools or chat history.
func (s *Service) SuggestCodingText(w http.ResponseWriter, r *http.Request, agentName, sessionId string) {
	var input gatewayapi.CodingTextRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), agentName)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	row, err := s.queries.GatewayGetCodingThread(r.Context(), gatewaydb.GatewayGetCodingThreadParams{WorkspaceID: access.workspaceID, AgentName: agentName, SessionID: pgtype.Text{String: sessionId, Valid: true}})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get thread", err))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	var name string
	var data codingPromptData
	switch input.Purpose {
	case gatewayapi.CodingTextBranch:
		if input.Text == nil || strings.TrimSpace(*input.Text) == "" {
			writeError(w, r, newAPIError(http.StatusBadRequest, "missing_prompt", "A task is required to name the branch", nil))
			return
		}
		name = "branch.tmpl"
		data.Text = *input.Text
	case gatewayapi.CodingTextPR:
		if input.Text == nil || strings.TrimSpace(*input.Text) == "" {
			writeError(w, r, newAPIError(http.StatusBadRequest, "missing_diff", "A branch diff is required", nil))
			return
		}
		name = "pr.tmpl"
		data.Text = *input.Text
	case gatewayapi.CodingTextCommit:
		status, err := s.codingFilesystem(ctx, access.namespace, row.CodingWorktree, row.CodingProject, false, row.CodingProject.DefaultBranch, gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Comparison: new(gatewayapi.CodingGitStaged)})
		if err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "git_conflict", err.Error(), err))
			return
		}
		if input.ExpectedTree == nil || status.Tree == nil || *input.ExpectedTree != *status.Tree {
			writeError(w, r, newAPIError(http.StatusConflict, "stale_diff", "Staged changes changed; refresh before generating a message", nil))
			return
		}
		var files strings.Builder
		for _, file := range status.Files {
			if file.Index != " " && file.Index != "?" {
				fmt.Fprintf(&files, "%s %s\n", file.Index, file.Path)
			}
		}
		if files.Len() == 0 {
			writeError(w, r, newAPIError(http.StatusBadRequest, "nothing_staged", "Stage changes before generating a commit message", nil))
			return
		}
		var patch strings.Builder
		if status.Patches != nil {
			for _, file := range *status.Patches {
				patch.WriteString(file.Patch[:min(len(file.Patch), 40000-patch.Len())])
				if patch.Len() == 40000 {
					break
				}
			}
		}
		name = "commit.tmpl"
		data.Branch = status.Branch
		data.Files = files.String()[:min(files.Len(), 6000)]
		data.Patch = patch.String()
	default:
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_purpose", "Unknown suggestion purpose", nil))
		return
	}
	var prompt strings.Builder
	if err := codingPrompts.ExecuteTemplate(&prompt, name, data); err != nil {
		writeInternalError(w, r, fmt.Errorf("render coding prompt: %w", err))
		return
	}
	// Model generation uses the request's deadline instead of the short
	// timeout used for ordinary gateway lookups. Keep the shared transport.
	httpClient := *s.outboundHTTP
	httpClient.Timeout = 0
	client, err := s.codingClient(ctx, access.namespace, agentName, &httpClient)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	directory := "/home/agentz/" + row.CodingWorktree.Directory
	body := gatewayapi.SessionCreateJSONRequestBody{
		ParentID: &sessionId, Title: new("Source control suggestion"),
		Permission: &gatewayapi.OpencodePermissionRuleset{{Permission: "*", Pattern: "*", Action: gatewayapi.Deny}},
	}
	if input.Model == nil {
		parent, err := client.SessionGetWithResponse(ctx, agentName, sessionId, &gatewayapi.SessionGetParams{Directory: &directory})
		if err != nil || parent.JSON200 == nil {
			writeError(w, r, newAPIError(http.StatusBadGateway, "generation_failed", "Could not load the thread's model", err))
			return
		}
		body.Model = parent.JSON200.Model
	}
	session, err := client.SessionCreateWithResponse(ctx, agentName, &gatewayapi.SessionCreateParams{Directory: &directory}, body)
	if err != nil || session.JSON200 == nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "generation_failed", "Could not start source-control generation", err))
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		// Closing the HTTP request does not stop OpenCode's generation loop.
		// Stop it before deleting the session it may still be writing to.
		stopped, err := client.SessionAbortWithResponse(cleanup, agentName, session.JSON200.Id, &gatewayapi.SessionAbortParams{Directory: &directory})
		if err != nil || stopped.StatusCode() != http.StatusOK {
			slog.WarnContext(cleanup, "stop source-control generation", "session", session.JSON200.Id, "error", err)
			return
		}
		deleted, err := client.SessionDeleteWithResponse(cleanup, agentName, session.JSON200.Id, &gatewayapi.SessionDeleteParams{Directory: &directory})
		if err != nil || deleted.StatusCode() != http.StatusOK {
			slog.WarnContext(cleanup, "remove source-control generation session", "session", session.JSON200.Id, "error", err)
		}
	}()
	var part gatewayapi.OpencodePromptPartInput
	err = part.FromOpencodeTextPartInput(gatewayapi.OpencodeTextPartInput{
		Type: gatewayapi.OpencodeTextPartInputTypeText,
		Text: prompt.String(),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	reply, err := client.SessionPromptWithResponse(ctx, agentName, session.JSON200.Id, &gatewayapi.SessionPromptParams{Directory: &directory}, gatewayapi.SessionPromptJSONRequestBody{Model: input.Model, Parts: []gatewayapi.OpencodePromptPartInput{part}})
	if err != nil || reply.JSON200 == nil || reply.JSON200.Info.Error != nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "generation_failed", "Could not generate source-control text", err))
		return
	}
	var text strings.Builder
	for _, part := range reply.JSON200.Parts {
		kind, err := part.Discriminator()
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if kind != string(gatewayapi.OpencodeTextPartTypeText) {
			continue
		}
		value, err := part.AsOpencodeTextPart()
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		text.WriteString(value.Text)
	}
	suggestion := strings.TrimSpace(text.String())
	valid := len(suggestion) > 0 && len(suggestion) <= 20000
	if input.Purpose == gatewayapi.CodingTextBranch {
		valid, _ = regexp.MatchString(`^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)/[a-z0-9]+(-[a-z0-9]+)*$`, suggestion)
		valid = valid && len(suggestion) <= 60
	}
	if !valid {
		writeError(w, r, newAPIError(http.StatusBadGateway, "invalid_suggestion", "The model returned an invalid suggestion; try again", nil))
		return
	}
	result := gatewayapi.CodingTextSuggestion{Text: suggestion}
	if input.Purpose == gatewayapi.CodingTextPR {
		var pr gatewayapi.CodingPullRequestText
		err := json.Unmarshal([]byte(suggestion), &pr)
		if err != nil || strings.TrimSpace(pr.Title) == "" || len(pr.Title) > 256 || strings.TrimSpace(pr.Body) == "" || len(pr.Body) > 20000 {
			writeError(w, r, newAPIError(http.StatusBadGateway, "invalid_suggestion", "The model returned invalid PR content; try again", err))
			return
		}
		result.PullRequest = &pr
	}
	writeJSON(w, http.StatusOK, result)
}

// RunCodingGit runs checkout operations under the project lock.
func (s *Service) RunCodingGit(w http.ResponseWriter, r *http.Request, worktreeId string) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	row, err := s.queries.GatewayGetCodingWorktree(r.Context(), gatewaydb.GatewayGetCodingWorktreeParams{ID: worktreeId, WorkspaceID: claims.WorkspaceID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get worktree", err))
		return
	}
	access, apiErr := s.codingAccess(r.Context(), row.CodingWorktree.AgentName)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	var req gatewayapi.CodingGitRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if req.Operation == gatewayapi.CodingGitRemove && row.CodingProject.OwnerID != claims.UserID {
		writeError(w, r, resourceForbidden(errors.New("only the project creator can remove checkouts")))
		return
	}
	if req.Operation == gatewayapi.CodingGitStatus || req.Operation == gatewayapi.CodingGitDiff || req.Operation == gatewayapi.CodingGitStashes {
		if row.CodingWorktree.Deleting {
			writeError(w, r, newAPIError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil))
			return
		}
		result, err := s.codingFilesystem(r.Context(), access.namespace, row.CodingWorktree, row.CodingProject, false, row.CodingProject.DefaultBranch, req)
		if err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "git_conflict", err.Error(), err))
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	q, release, err := s.lockCodingProject(r.Context(), row.CodingProject.ID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	defer release()
	row, err = q.GatewayGetCodingWorktree(r.Context(), gatewaydb.GatewayGetCodingWorktreeParams{ID: worktreeId, WorkspaceID: claims.WorkspaceID})
	if err != nil {
		writeError(w, r, mapGatewayStoreError("get worktree", err))
		return
	}
	if row.CodingWorktree.Deleting && req.Operation != gatewayapi.CodingGitRemove {
		writeError(w, r, newAPIError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil))
		return
	}
	if req.Operation == gatewayapi.CodingGitRename && (row.CodingWorktree.Shared || row.CodingWorktree.Branch != "chore/"+row.CodingWorktree.ID || req.ExpectedHead == nil) {
		writeError(w, r, newAPIError(http.StatusConflict, "branch_changed", "Only a new private worktree can be named automatically", nil))
		return
	}
	if req.Operation == gatewayapi.CodingGitRemove {
		if err := s.checkCodingAgentIdle(r.Context(), access, row.CodingWorktree); err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "cleanup_blocked", err.Error(), err))
			return
		}
		err = q.GatewayDeletingCodingWorktree(r.Context(), gatewaydb.GatewayDeletingCodingWorktreeParams{ID: worktreeId, Deleting: true})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	result, err := s.codingFilesystem(r.Context(), access.namespace, row.CodingWorktree, row.CodingProject, false, row.CodingProject.DefaultBranch, req)
	if err != nil {
		if req.Operation == gatewayapi.CodingGitRemove {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			if resetErr := q.GatewayDeletingCodingWorktree(ctx, gatewaydb.GatewayDeletingCodingWorktreeParams{ID: worktreeId, Deleting: false}); resetErr != nil {
				writeInternalError(w, r, resetErr)
				return
			}
		}
		writeError(w, r, newAPIError(http.StatusConflict, "git_conflict", err.Error(), err))
		return
	}
	if req.Operation == gatewayapi.CodingGitRemove {
		err = s.deleteCodingConversations(r.Context(), access, row.CodingWorktree, row.CodingProject)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := q.GatewayDeleteCodingWorktree(r.Context(), worktreeId); err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	if req.Operation != gatewayapi.CodingGitRemove && result.Branch != row.CodingWorktree.Branch {
		err = q.GatewayUpdateCodingBranch(r.Context(), gatewaydb.GatewayUpdateCodingBranchParams{ID: worktreeId, Branch: result.Branch})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) codingFilesystem(ctx context.Context, namespace string, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject, prepare bool, baseBranch string, git gatewayapi.CodingGitRequest) (gatewayapi.CodingGitResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result := gatewayapi.CodingGitResult{}
	resolved, err := s.resolver.resolveAgent(ctx, namespace, tree.AgentName)
	if err != nil {
		return result, err
	}
	target, err := s.filesystemTarget(resolved)
	if err != nil {
		return result, err
	}
	root := path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID)
	body, err := json.Marshal(filesystem.GitRequest{Root: root, Directory: tree.Directory, Branch: tree.Branch, BaseBranch: baseBranch, Prepare: prepare, Git: git})
	if err != nil {
		return result, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.JoinPath("git").String(), bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/json")
	// Match the filesystem operation deadline, including bundle transfer time.
	httpClient := *s.outboundHTTP
	httpClient.Timeout = 0
	response, err := httpClient.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var failure gatewayapi.Error
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&failure); err != nil {
			return result, fmt.Errorf("filesystem Git returned %d", response.StatusCode)
		}
		return result, errors.New(failure.Message)
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 90<<20)).Decode(&result)
	return result, err
}

// enforceCodingSession prevents the generic engine routes from bypassing
// project-bound creation, directory routing, and shared-worktree revert rules.
func (s *Service) enforceCodingSession(r *http.Request, access resourceAccess, route *opencodeRouteMatch, agentName string) (func(), *apiError) {
	auth, _ := requestAuthState(r.Context())
	organizationID := auth.organizationID
	if auth.actorType == requestActorUser {
		organizationID = access.claims.OrganizationID
	}
	workspace, err := s.queries.GatewayGetWorkspace(r.Context(), gatewaydb.GatewayGetWorkspaceParams{ID: access.workspaceID, OrganizationID: organizationID})
	if err != nil {
		return nil, mapGatewayStoreError("get workspace", err)
	}
	if workspace.Type != gatewaydb.WorkspaceTypeCoding {
		return nil, nil
	}
	if r.Method == http.MethodPost && (route.Path == opencodeSessionCreatePath || route.Path == "/api/opencode/{agentName}/api/session" || strings.HasSuffix(route.Path, "/fork")) {
		return nil, newAPIError(http.StatusBadRequest, "project_required", "Start Coding threads from a project", nil)
	}
	if strings.Contains(route.Path, "/experimental/worktree") || strings.Contains(route.Path, "/experimental/workspace") || strings.HasSuffix(route.Path, "/move-session") {
		return nil, newAPIError(http.StatusConflict, "managed_checkout", "Manage Coding checkouts from the project", nil)
	}
	sessionID := route.Params["sessionID"]
	var tree gatewaydb.CodingWorktree
	if sessionID != "" {
		thread, err := s.queries.GatewayGetCodingThread(r.Context(), gatewaydb.GatewayGetCodingThreadParams{WorkspaceID: access.workspaceID, AgentName: agentName, SessionID: pgtype.Text{String: sessionID, Valid: true}})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // Workflow sessions remain supported.
		}
		if err != nil {
			return nil, mapGatewayStoreError("get coding thread", err)
		}
		tree = thread.CodingWorktree
	} else if strings.Contains(route.Path, "/pty") && r.Method == http.MethodPost {
		directory := strings.TrimPrefix(r.URL.Query().Get("directory"), "/home/agentz/")
		tree, err = s.queries.GatewayCodingDirectory(r.Context(), gatewaydb.GatewayCodingDirectoryParams{WorkspaceID: access.workspaceID, AgentName: agentName, Directory: directory})
		if err != nil {
			return nil, mapGatewayStoreError("get terminal checkout", err)
		}
	} else {
		return nil, nil
	}
	// A synchronous prompt holds the project lock until generation finishes.
	// Its cancellation and input responses must be able to reach the agent.
	response := false
	switch route.Path {
	case "/api/opencode/{agentName}/session/{sessionID}/abort",
		"/api/opencode/{agentName}/session/{sessionID}/permissions/{permissionID}",
		"/api/opencode/{agentName}/api/session/{sessionID}/interrupt",
		"/api/opencode/{agentName}/api/session/{sessionID}/permission/{requestID}/reply",
		"/api/opencode/{agentName}/api/session/{sessionID}/question/{requestID}/reply",
		"/api/opencode/{agentName}/api/session/{sessionID}/question/{requestID}/reject":
		response = true
	}
	var release func()
	if r.Method != http.MethodGet && r.Method != http.MethodHead && !response {
		q, unlock, err := s.lockCodingProject(r.Context(), tree.ProjectID)
		if err != nil {
			return nil, mapGatewayStoreError("lock coding project", err)
		}
		release = unlock
		current, err := q.GatewayGetCodingWorktree(r.Context(), gatewaydb.GatewayGetCodingWorktreeParams{ID: tree.ID, WorkspaceID: access.workspaceID})
		if err != nil {
			return release, mapGatewayStoreError("get coding checkout", err)
		}
		tree = current.CodingWorktree
	}
	if tree.Deleting || !tree.Ready {
		return release, newAPIError(http.StatusConflict, "checkout_unavailable", "This checkout is being prepared or removed", nil)
	}
	if (strings.HasSuffix(route.Path, "/revert") || strings.Contains(route.Path, "/revert/")) && tree.Shared {
		return release, newAPIError(http.StatusConflict, "shared_worktree", "Filesystem revert is unavailable after multiple threads have used this worktree", nil)
	}
	query := r.URL.Query()
	query.Set("directory", "/home/agentz/"+tree.Directory)
	query.Set("location[directory]", "/home/agentz/"+tree.Directory)
	query.Del("workspace")
	query.Del("location[workspace]")
	r.URL.RawQuery = query.Encode()
	r.Header.Del("X-Opencode-Directory")
	r.Header.Del("X-Opencode-Workspace")
	return release, nil
}

// checkCodingAgentIdle refuses cleanup when an agent cannot confirm it is idle.
func (s *Service) checkCodingAgentIdle(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree) error {
	client, err := s.codingClient(ctx, access.namespace, tree.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	directory := "/home/agentz/" + tree.Directory
	statuses, err := client.SessionStatusWithResponse(ctx, tree.AgentName, &gatewayapi.SessionStatusParams{Directory: &directory})
	if err != nil {
		return errors.New("agent is unavailable; retry cleanup when it is running")
	}
	if statuses.JSON200 == nil {
		return errors.New("could not confirm agent session status")
	}
	for _, status := range *statuses.JSON200 {
		idle, err := status.AsOpencodeSessionStatus0()
		if err != nil || idle.Type != gatewayapi.Idle {
			return errors.New("stop running agent tasks before removing a checkout")
		}
	}
	terminals, err := client.PtyListWithResponse(ctx, tree.AgentName, &gatewayapi.PtyListParams{Directory: &directory})
	if err != nil {
		return err
	}
	if terminals.JSON200 == nil {
		return errors.New("could not confirm terminal status")
	}
	for _, terminal := range *terminals.JSON200 {
		if terminal.Status == gatewayapi.OpencodePtyStatusRunning {
			return errors.New("close running terminals before removing a checkout")
		}
	}
	return nil
}

func (s *Service) deleteCodingConversations(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject) error {
	client, err := s.codingClient(ctx, access.namespace, tree.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	directory := "/home/agentz/" + tree.Directory
	threads, err := s.queries.GatewayListCodingThreads(ctx, gatewaydb.GatewayListCodingThreadsParams{ProjectID: project.ID, WorkspaceID: access.workspaceID})
	if err != nil {
		return err
	}
	for _, thread := range threads {
		if thread.CodingThread.WorktreeID != tree.ID || !thread.CodingThread.SessionID.Valid {
			continue
		}
		response, err := client.SessionDeleteWithResponse(ctx, tree.AgentName, thread.CodingThread.SessionID.String, &gatewayapi.SessionDeleteParams{Directory: &directory})
		if err != nil {
			return err
		}
		if response.StatusCode() != http.StatusOK && response.StatusCode() != http.StatusNotFound {
			return errors.New("could not delete agent conversation")
		}
		if _, err := s.queries.GatewayDeleteSessionTraces(ctx, gatewaydb.GatewayDeleteSessionTracesParams{TenantNamespace: access.namespace, AgentName: tree.AgentName, SessionID: thread.CodingThread.SessionID.String}); err != nil {
			return err
		}
	}
	return s.queries.GatewayDeleteCodingConversations(ctx, gatewaydb.GatewayDeleteCodingConversationsParams{WorkspaceID: access.workspaceID, AgentName: tree.AgentName, WorktreeID: tree.ID})
}

// lockCodingProject holds a session lock across intent commits and engine calls.
// Closing a failed connection releases the lock even if a request was cancelled.
func (s *Service) lockCodingProject(ctx context.Context, projectID string) (*gatewaydb.Queries, func(), error) {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	q := gatewaydb.New(conn)
	if err := q.GatewayLockCodingProject(ctx, projectID); err != nil {
		conn.Release()
		return nil, nil, err
	}
	return q, func() {
		defer conn.Release()
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := q.GatewayUnlockCodingProject(ctx, projectID); err != nil {
			conn.Conn().Close(ctx)
		}
	}, nil
}
