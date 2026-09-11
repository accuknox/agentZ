package gateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/gateway/filesystem"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

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
			result.Worktrees = append(result.Worktrees, gatewayapi.CodingWorktree{
				Id:        tree.ID,
				ProjectId: tree.ProjectID,
				AgentName: tree.AgentName,
				Directory: "/home/agentz/" + tree.Directory,
				Branch:    tree.Branch,
				Ready:     tree.Ready && !tree.Deleting,
				Shared:    tree.Shared,
			})
		}
	}
	for _, thread := range threads {
		if capabilities[thread.CodingThread.AgentName].Use {
			result.Threads = append(result.Threads, gatewayapi.CodingThread{
				Id:        thread.CodingThread.ID,
				SessionId: thread.CodingThread.SessionID.String,
				Worktree: gatewayapi.CodingWorktree{
					Id:        thread.CodingWorktree.ID,
					ProjectId: thread.CodingWorktree.ProjectID,
					AgentName: thread.CodingWorktree.AgentName,
					Directory: "/home/agentz/" + thread.CodingWorktree.Directory,
					Branch:    thread.CodingWorktree.Branch,
					Ready:     thread.CodingWorktree.Ready && !thread.CodingWorktree.Deleting,
					Shared:    thread.CodingWorktree.Shared,
				},
				Repository:   thread.CodingProject.Repository,
				RepositoryId: thread.CodingProject.RepositoryID,
			})
		}
	}
	writeJSON(w, http.StatusOK, result)
}

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
			directory, branch := root+"/worktrees/"+id, "agentz/"+id
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
			Id:        thread.ID,
			SessionId: thread.SessionID.String,
			Worktree: gatewayapi.CodingWorktree{
				Id:        tree.ID,
				ProjectId: tree.ProjectID,
				AgentName: tree.AgentName,
				Directory: "/home/agentz/" + tree.Directory,
				Branch:    tree.Branch,
				Ready:     tree.Ready && !tree.Deleting,
				Shared:    tree.Shared,
			},
			Repository:   project.Repository,
			RepositoryId: project.RepositoryID,
		})
		return
	}
	if !tree.Ready {
		base := project.DefaultBranch
		if req.BaseBranch != nil {
			base = *req.BaseBranch
		}
		_, err := s.codingFilesystem(r.Context(), access.namespace, tree, project, true, base, gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus, Bundle: req.Bundle})
		if err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "checkout_failed", err.Error(), err))
			return
		}
		if err := q.GatewayReadyCodingWorktree(r.Context(), tree.ID); err != nil {
			writeInternalError(w, r, err)
			return
		}
		tree.Ready = true
	}
	if err := q.GatewayRecordCodingMainCheckout(r.Context(), gatewaydb.GatewayRecordCodingMainCheckoutParams{
		ID: uuid.NewString(), WorkspaceID: access.workspaceID, ProjectID: project.ID, AgentName: tree.AgentName,
		Directory: path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID, "repo"), Branch: project.DefaultBranch,
	}); err != nil {
		writeInternalError(w, r, err)
		return
	}
	session, err := s.createCodingSession(r.Context(), access.namespace, tree, thread.ID)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadGateway, "session_failed", "Failed to prepare agent session; retry to resume", err))
		return
	}
	if err := q.GatewaySetCodingThreadSession(r.Context(), gatewaydb.GatewaySetCodingThreadSessionParams{ID: thread.ID, SessionID: pgtype.Text{String: session.Id, Valid: true}}); err != nil {
		writeInternalError(w, r, err)
		return
	}
	if err := s.storeOpenCodeSession(r.Context(), access.workspaceID, req.AgentName, gatewaydb.ChatSessionKindChat, session); err != nil {
		writeInternalError(w, r, err)
		return
	}
	thread.SessionID = pgtype.Text{String: session.Id, Valid: true}
	writeJSON(w, http.StatusCreated, gatewayapi.CodingThread{
		Id:        thread.ID,
		SessionId: thread.SessionID.String,
		Worktree: gatewayapi.CodingWorktree{
			Id:        tree.ID,
			ProjectId: tree.ProjectID,
			AgentName: tree.AgentName,
			Directory: "/home/agentz/" + tree.Directory,
			Branch:    tree.Branch,
			Ready:     tree.Ready && !tree.Deleting,
			Shared:    tree.Shared,
		},
		Repository:   project.Repository,
		RepositoryId: project.RepositoryID,
	})
}

func (s *Service) createCodingSession(ctx context.Context, namespace string, tree gatewaydb.CodingWorktree, threadID string) (gatewayapi.OpencodeSession, error) {
	resolved, err := s.resolver.resolveAgent(ctx, namespace, tree.AgentName)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	endpoint := target.JoinPath("session")
	query := url.Values{"directory": {"/home/agentz/" + tree.Directory}}
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	response, err := s.outboundHTTP.Do(request)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	var sessions []gatewayapi.OpencodeSession
	err = json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&sessions)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		return gatewayapi.OpencodeSession{}, errors.New("could not inspect existing sessions")
	}
	for _, session := range sessions {
		if session.Metadata != nil && (*session.Metadata)["agentz.codingThread"] == threadID {
			return session, nil
		}
	}
	metadata := map[string]any{"agentz.codingThread": threadID}
	body, err := json.Marshal(gatewayapi.SessionCreateJSONBody{Title: new("New coding thread"), Metadata: &metadata})
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	request, err = http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err = s.outboundHTTP.Do(request)
	if err != nil {
		return gatewayapi.OpencodeSession{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return gatewayapi.OpencodeSession{}, fmt.Errorf("create session returned %d", response.StatusCode)
	}
	var session gatewayapi.OpencodeSession
	err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&session)
	return session, err
}

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
		Id:        thread.CodingThread.ID,
		SessionId: thread.CodingThread.SessionID.String,
		Worktree: gatewayapi.CodingWorktree{
			Id:        thread.CodingWorktree.ID,
			ProjectId: thread.CodingWorktree.ProjectID,
			AgentName: thread.CodingWorktree.AgentName,
			Directory: "/home/agentz/" + thread.CodingWorktree.Directory,
			Branch:    thread.CodingWorktree.Branch,
			Ready:     thread.CodingWorktree.Ready && !thread.CodingWorktree.Deleting,
			Shared:    thread.CodingWorktree.Shared,
		},
		Repository:   thread.CodingProject.Repository,
		RepositoryId: thread.CodingProject.RepositoryID,
	})
}

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
	if req.Operation == gatewayapi.CodingGitRemove {
		if err := s.checkCodingAgentIdle(r.Context(), access, row.CodingWorktree); err != nil {
			writeError(w, r, newAPIError(http.StatusConflict, "cleanup_blocked", err.Error(), err))
			return
		}
	}
	if req.Operation == gatewayapi.CodingGitRemove {
		if err := q.GatewayDeletingCodingWorktree(r.Context(), gatewaydb.GatewayDeletingCodingWorktreeParams{ID: worktreeId, Deleting: true}); err != nil {
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
		if err := s.deleteCodingConversations(r.Context(), access, row.CodingWorktree, row.CodingProject); err != nil {
			writeInternalError(w, r, err)
			return
		}
		if err := q.GatewayDeleteCodingWorktree(r.Context(), worktreeId); err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	if req.Operation != gatewayapi.CodingGitRemove && result.Branch != row.CodingWorktree.Branch {
		if err := q.GatewayUpdateCodingBranch(r.Context(), gatewaydb.GatewayUpdateCodingBranchParams{ID: worktreeId, Branch: result.Branch}); err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) codingFilesystem(ctx context.Context, namespace string, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject, prepare bool, baseBranch string, git gatewayapi.CodingGitRequest) (gatewayapi.CodingGitResult, error) {
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
	response, err := s.outboundHTTP.Do(request)
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
	var release func()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
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
	resolved, err := s.resolver.resolveAgent(ctx, access.namespace, tree.AgentName)
	if err != nil {
		return err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return err
	}
	request := func(method, endpoint string) (*http.Response, error) {
		url := target.JoinPath(endpoint)
		query := url.Query()
		query.Set("directory", "/home/agentz/"+tree.Directory)
		url.RawQuery = query.Encode()
		req, err := http.NewRequestWithContext(ctx, method, url.String(), nil)
		if err != nil {
			return nil, err
		}
		return s.outboundHTTP.Do(req)
	}
	response, err := request(http.MethodGet, "session/status")
	if err != nil {
		return errors.New("agent is unavailable; retry cleanup when it is running")
	}
	var statuses map[string]struct {
		Type gatewayapi.ChatSessionStatus `json:"type"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&statuses)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		return errors.New("could not confirm agent session status")
	}
	for _, status := range statuses {
		if status.Type != gatewayapi.ChatSessionStatusIdle {
			return errors.New("stop running agent tasks before removing a checkout")
		}
	}
	response, err = request(http.MethodGet, "pty")
	if err != nil {
		return err
	}
	var terminals []struct {
		Status string `json:"status"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&terminals)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		return errors.New("could not confirm terminal status")
	}
	for _, terminal := range terminals {
		if terminal.Status == "running" {
			return errors.New("close running terminals before removing a checkout")
		}
	}
	return nil
}

func (s *Service) deleteCodingConversations(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject) error {
	resolved, err := s.resolver.resolveAgent(ctx, access.namespace, tree.AgentName)
	if err != nil {
		return err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return err
	}
	threads, err := s.queries.GatewayListCodingThreads(ctx, gatewaydb.GatewayListCodingThreadsParams{ProjectID: project.ID, WorkspaceID: access.workspaceID})
	if err != nil {
		return err
	}
	for _, thread := range threads {
		if thread.CodingThread.WorktreeID != tree.ID || !thread.CodingThread.SessionID.Valid {
			continue
		}
		endpoint := target.JoinPath("session", thread.CodingThread.SessionID.String)
		query := endpoint.Query()
		query.Set("directory", "/home/agentz/"+tree.Directory)
		endpoint.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint.String(), nil)
		if err != nil {
			return err
		}
		response, err := s.outboundHTTP.Do(request)
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNotFound {
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
