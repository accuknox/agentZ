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
	"os"
	"path"
	"regexp"
	"strings"
	"text/template"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	"github.com/accuknox/agentz/internal/gateway/filesystem"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

//go:embed prompts/*.tmpl
var codingPromptFiles embed.FS

var codingPrompts = template.Must(template.ParseFS(codingPromptFiles, "prompts/*.tmpl"))

type gatewayLockKey struct{}

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
func (s *Service) codingAccess(ctx context.Context, agentName string) (resourceAccess, *apiutil.APIError) {
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
	workspace, err := s.queries.GatewayGetWorkspace(
		ctx,
		gatewaydb.GatewayGetWorkspaceParams{
			ID:             access.workspaceID,
			OrganizationID: access.organizationID,
		},
	)
	if err != nil {
		return access, mapGatewayStoreError("get workspace", err)
	}
	if workspace.Type != gatewaydb.WorkspaceTypeCoding {
		return access, apiutil.NewError(http.StatusNotFound, "not_found", "Coding workspace required", nil)
	}

	return access, nil
}

// ListCodingProjects lists only projects owned by the caller in this workspace.
func (s *Service) ListCodingProjects(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	rows, err := s.queries.GatewayListCodingProjects(
		r.Context(),
		gatewaydb.GatewayListCodingProjectsParams{WorkspaceID: access.workspaceID, OwnerID: access.userID},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	projects := make([]gatewayapi.CodingProject, 0, len(rows))
	for _, row := range rows {
		var agentName *string
		if row.LastAgentName.Valid {
			agentName = &row.LastAgentName.String
		}
		projects = append(projects, gatewayapi.CodingProject{
			LastAgentName: agentName,
			Id:            row.ID,
			Name:          row.Name,
			Repository:    row.Repository,
			RepositoryId:  row.RepositoryID,
			DefaultBranch: row.DefaultBranch,
			CreatedAt:     row.CreatedAt.Time,
			Deleting:      row.Deleting,
		})
	}
	apiutil.WriteJSON(w, http.StatusOK, projects)
}

// CreateCodingProject records a personal repository without provisioning a checkout.
func (s *Service) CreateCodingProject(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(usableAgentNames(nil, capabilities)) == 0 {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("a usable agent is required")))
		return
	}
	var req gatewayapi.CreateCodingProjectRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	identity, err := s.codingIdentity(r.Context(), access.userID)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "github_failed", err.Error(), err))
		return
	}
	repo, err := identity.repository(r.Context(), req.RepositoryId)
	if err != nil {
		if !errors.As(err, &apiErr) {
			apiErr = apiutil.NewError(http.StatusBadGateway, "github_failed", err.Error(), err)
		}
		apiutil.WriteError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayCreateCodingProject(
		r.Context(),
		gatewaydb.GatewayCreateCodingProjectParams{
			ID:            uuid.NewString(),
			WorkspaceID:   access.workspaceID,
			OwnerID:       access.userID,
			Name:          req.Name,
			RepositoryID:  req.RepositoryId,
			Repository:    repo.GetFullName(),
			DefaultBranch: repo.GetDefaultBranch(),
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("create project", err))
		return
	}
	apiutil.WriteJSON(w, http.StatusCreated, gatewayapi.CodingProject{
		Id:            project.ID,
		Name:          project.Name,
		Repository:    project.Repository,
		RepositoryId:  project.RepositoryID,
		DefaultBranch: project.DefaultBranch,
		CreatedAt:     project.CreatedAt.Time,
		Deleting:      project.Deleting,
	})
}

// GetCodingProject includes threads only on agents the caller can use.
func (s *Service) GetCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	trees, err := s.queries.GatewayListCodingWorktrees(
		r.Context(),
		gatewaydb.GatewayListCodingWorktreesParams{ProjectID: projectId, WorkspaceID: access.workspaceID},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	threads, err := s.queries.GatewayListCodingThreads(
		r.Context(),
		gatewaydb.GatewayListCodingThreadsParams{ProjectID: projectId, WorkspaceID: access.workspaceID},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
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
			Deleting:      project.Deleting,
		},
		Worktrees: []gatewayapi.CodingWorktree{},
		Threads:   []gatewayapi.CodingThread{},
	}
	if project.LastAgentName.Valid {
		result.Project.LastAgentName = &project.LastAgentName.String
	}
	result.Agents, err = s.codingProjectAgents(r.Context(), access, projectId)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
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
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// RenameCodingProject renames a project owned by the caller.
func (s *Service) RenameCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var req gatewayapi.RenameCodingProjectJSONBody
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	count, err := s.queries.GatewayRenameCodingProject(
		r.Context(),
		gatewaydb.GatewayRenameCodingProjectParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
			Name:        req.Name,
		},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if count == 0 {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusNotFound, "not_found", "project not found", nil))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UpdateCodingProjectPreference remembers the agent for this personal project.
func (s *Service) UpdateCodingProjectPreference(w http.ResponseWriter, r *http.Request, projectId string) {
	var body gatewayapi.UpdateCodingProjectPreferenceJSONBody
	if !decodeJSONBody(w, r, &body, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), body.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	count, err := s.queries.GatewayUpdateCodingProjectPreference(
		r.Context(),
		gatewaydb.GatewayUpdateCodingProjectPreferenceParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
			AgentName:   pgtype.Text{String: body.AgentName, Valid: true},
		},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if count == 0 {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", pgx.ErrNoRows))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteCodingProject stops project work and removes its managed files on every agent.
func (s *Service) DeleteCodingProject(w http.ResponseWriter, r *http.Request, projectId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(r.Context(), gatewaydb.GatewayGetCodingProjectParams{
		ID: projectId, WorkspaceID: access.workspaceID, OwnerID: access.userID,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	if err := s.deleteCodingProject(r.Context(), access, project); err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "cleanup_failed", err.Error(), err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// codingProjectAgents includes inaccessible checkouts so deletion never silently
// leaves files behind on an agent omitted from the caller's checkout list.
func (s *Service) codingProjectAgents(ctx context.Context, access resourceAccess, projectID string) ([]gatewayapi.CodingProjectAgent, error) {
	names, err := s.queries.GatewayCodingProjectAgents(ctx, projectID)
	if err != nil {
		return nil, err
	}
	capabilities, err := s.agentCapabilityProjections(ctx, access, "")
	if err != nil {
		return nil, err
	}
	agents := make([]gatewayapi.CodingProjectAgent, 0, len(names))
	for _, name := range names {
		agent := gatewayapi.CodingProjectAgent{Name: name}
		resolved, err := s.resolver.resolveAgent(ctx, access.namespace, name)
		switch {
		case !capabilities[name].Use:
			agent.DeleteDisabledReason = new("Access to agent " + name + " is required to delete its checkouts.")
		case err != nil || statusFromAgent(resolved.Agent).Phase != agentPhaseReady:
			agent.DeleteDisabledReason = new("Agent " + name + " is offline. Start it to delete its checkouts.")
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

func (s *Service) deleteCodingProject(ctx context.Context, access resourceAccess, project gatewaydb.CodingProject) error {
	// Serialize deletion separately: a running prompt holds the project lock
	// until it finishes, and must be aborted before we wait for that lock.
	q, unlock, err := lockGatewayResource(ctx, s.lockDB, project.ID+"/delete", false)
	if err != nil {
		return err
	}
	defer unlock()
	agents, err := s.codingProjectAgents(ctx, access, project.ID)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if agent.DeleteDisabledReason != nil {
			return errors.New(*agent.DeleteDisabledReason)
		}
	}
	for _, agent := range agents {
		client, err := s.codingClient(ctx, access.namespace, agent.Name, s.outboundHTTP)
		if err != nil {
			return err
		}
		health, err := client.GlobalHealthWithResponse(ctx, agent.Name)
		if err != nil || health.StatusCode() != http.StatusOK {
			return fmt.Errorf("agent %s is unavailable; retry when it is online", agent.Name)
		}
	}
	trees, err := s.queries.GatewayListCodingWorktrees(ctx, gatewaydb.GatewayListCodingWorktreesParams{
		ProjectID: project.ID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		return err
	}
	// Persist intent before stopping runs. Retries after a lost response or a
	// gateway restart must keep new work from entering partially deleted files.
	if err := s.queries.GatewayBeginCodingProjectDeletion(ctx, project.ID); err != nil {
		return err
	}
	project.Deleting = true
	for {
		for _, tree := range trees {
			if err := s.stopCodingWorktree(ctx, access, tree); err != nil {
				return fmt.Errorf("stop checkout %s on %s: %w", tree.Branch, tree.AgentName, err)
			}
		}
		locked, err := q.GatewayTryLockResource(ctx, project.ID)
		if err != nil {
			return err
		}
		if locked {
			break
		}
		// A prompt admitted just before deletion can start after the first
		// abort. Keep stopping it while its shared project lock drains.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, err := q.GatewayUnlockResource(ctx, gatewaydb.GatewayUnlockResourceParams{Identity: project.ID})
		if err != nil {
			slog.ErrorContext(ctx, "release project deletion lock", "error", err)
		}
	}()
	// Preparation admitted before deletion may have completed while we stopped
	// runs. Read its checkouts again under the lock before deleting any files.
	trees, err = q.GatewayListCodingWorktrees(ctx, gatewaydb.GatewayListCodingWorktreesParams{
		ProjectID: project.ID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		return err
	}
	if err := q.GatewayBeginCodingProjectDeletion(ctx, project.ID); err != nil {
		return err
	}
	agents, err = s.codingProjectAgents(ctx, access, project.ID)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if agent.DeleteDisabledReason != nil {
			return errors.New(*agent.DeleteDisabledReason)
		}
	}
	for _, agent := range agents {
		for _, tree := range trees {
			if tree.AgentName != agent.Name {
				continue
			}
			if err := s.deleteCodingConversations(ctx, access, tree); err != nil {
				return fmt.Errorf("delete conversations on %s: %w", agent.Name, err)
			}
			if err := s.stopCodingWorktree(ctx, access, tree); err != nil {
				return fmt.Errorf("stop checkout %s on %s: %w", tree.Branch, agent.Name, err)
			}
		}
		_, err = s.codingFilesystem(ctx, access.namespace,
			gatewaydb.CodingWorktree{AgentName: agent.Name}, project, false,
			gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRemove})
		if err != nil {
			return fmt.Errorf("delete project files on %s: %w", agent.Name, err)
		}
		err = q.GatewayDeleteCodingAgentCheckouts(ctx, gatewaydb.GatewayDeleteCodingAgentCheckoutsParams{
			ProjectID: project.ID, AgentName: agent.Name,
		})
		if err != nil {
			return err
		}
	}
	_, err = q.GatewayDeleteCodingProject(ctx, gatewaydb.GatewayDeleteCodingProjectParams{
		ID: project.ID, WorkspaceID: access.workspaceID, OwnerID: access.userID,
	})
	return err
}

// stopCodingWorktree shuts down only this checkout's runs and terminals. Native
// abort requests bypass the project lock held by synchronous prompts.
func (s *Service) stopCodingWorktree(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree) error {
	client, err := s.codingClient(ctx, access.namespace, tree.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	directory := "/home/agentz/" + tree.Directory
	statuses, err := client.SessionStatusWithResponse(ctx, tree.AgentName, &gatewayapi.SessionStatusParams{Directory: &directory})
	if err != nil {
		return err
	}
	if statuses.JSON200 == nil {
		return errors.New("could not read agent session status")
	}
	for id, status := range *statuses.JSON200 {
		state, err := status.Discriminator()
		if err != nil {
			return err
		}
		if state == string(gatewayapi.Idle) {
			continue
		}
		stopped, err := client.SessionAbortWithResponse(ctx, tree.AgentName, id, &gatewayapi.SessionAbortParams{Directory: &directory})
		if err != nil {
			return err
		}
		if stopped.StatusCode() != http.StatusOK && stopped.StatusCode() != http.StatusNotFound {
			return errors.New("could not stop agent session")
		}
	}
	// Instance disposal releases terminals, watchers, and cached services for
	// this directory. Unlike listing PTYs, it also works after files vanished.
	disposed, err := client.InstanceDisposeWithResponse(ctx, tree.AgentName, &gatewayapi.InstanceDisposeParams{Directory: &directory})
	if err != nil {
		return err
	}
	if disposed.JSON200 == nil || !*disposed.JSON200 {
		return errors.New("could not shut down checkout resources")
	}
	return nil
}

// PrepareCodingCheckout prepares or reuses an owned checkout for native sessions.
func (s *Service) PrepareCodingCheckout(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.PrepareCodingCheckoutRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), req.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          req.ProjectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	q, release, err := lockGatewayResource(r.Context(), s.lockDB, project.ID, false)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer release()
	// Read the owner predicate again after the lock, since deletion may have won.
	project, err = q.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          req.ProjectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	if project.Deleting {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "deleting", "Project deletion has started", nil))
		return
	}
	var tree gatewaydb.CodingWorktree
	treeID := req.Id
	if req.WorktreeId != nil {
		treeID = *req.WorktreeId
	}
	existing, err := q.GatewayGetCodingWorktree(r.Context(), gatewaydb.GatewayGetCodingWorktreeParams{
		ID: treeID, WorkspaceID: access.workspaceID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if err == nil {
		tree = existing.CodingWorktree
		if tree.ProjectID != project.ID || tree.AgentName != req.AgentName {
			apiutil.WriteError(w, r, mapGatewayStoreError("get checkout", pgx.ErrNoRows))
			return
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if req.WorktreeId != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("get checkout", pgx.ErrNoRows))
			return
		}
		id := req.Id
		root := path.Join(
			"Projects",
			base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)),
			"github",
			project.ID,
		)
		directory, branch := root+"/worktrees/"+id, "chore/"+id
		if req.MainCheckout != nil && *req.MainCheckout {
			directory, branch = root+"/repo", project.DefaultBranch
		}
		tree, err = q.GatewayCreateCodingWorktree(
			r.Context(),
			gatewaydb.GatewayCreateCodingWorktreeParams{
				ID:          id,
				WorkspaceID: access.workspaceID,
				ProjectID:   project.ID,
				AgentName:   req.AgentName,
				Directory:   directory,
				Branch:      branch,
			},
		)
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("create worktree", err))
			return
		}
	}
	if tree.Deleting {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil),
		)
		return
	}
	var bundle []byte
	if !tree.Ready {
		trees, err := q.GatewayListCodingWorktrees(
			r.Context(),
			gatewaydb.GatewayListCodingWorktreesParams{ProjectID: project.ID, WorkspaceID: project.WorkspaceID},
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		ready := false
		for _, existing := range trees {
			ready = ready || existing.AgentName == tree.AgentName && existing.Ready
		}
		if !ready {
			identity, err := s.codingIdentity(r.Context(), access.userID)
			if err != nil {
				apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "github_failed", err.Error(), err))
				return
			}
			repo, err := newCodingRepository(r.Context(), project.Repository, identity.token)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			defer os.RemoveAll(repo.dir)
			bundle, err = repo.fetchBundle(r.Context())
			if err != nil {
				apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "fetch_failed", err.Error(), err))
				return
			}
		}
		result, err := s.codingFilesystem(
			r.Context(),
			access.namespace,
			tree,
			project,
			true,
			gatewayapi.CodingGitRequest{
				Operation: gatewayapi.CodingGitStatus,
				Bundle:    &bundle,
				Ref:       req.BaseRef,
			},
		)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "checkout_failed", err.Error(), err))
			return
		}
		tree.Branch = result.Branch
	}
	err = q.GatewayRecordCodingMainCheckout(r.Context(), gatewaydb.GatewayRecordCodingMainCheckoutParams{
		ID:          uuid.NewString(),
		WorkspaceID: access.workspaceID,
		ProjectID:   project.ID,
		AgentName:   tree.AgentName,
		Directory: path.Join(
			"Projects",
			base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)),
			"github",
			project.ID,
			"repo",
		), Branch: project.DefaultBranch,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if !tree.Ready {
		// A ready checkout must have its actual branch and main checkout recorded
		// so retries can skip preparation without losing either binding.
		err = q.GatewayReadyCodingWorktree(
			r.Context(),
			gatewaydb.GatewayReadyCodingWorktreeParams{ID: tree.ID, Branch: tree.Branch},
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		tree.Ready = true
	}
	apiutil.WriteJSON(w, http.StatusCreated, codingWorktree(tree))
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

// GetCodingThread returns a binding for a session on an accessible agent.
func (s *Service) GetCodingThread(w http.ResponseWriter, r *http.Request, agentName, sessionId string) {
	access, apiErr := s.codingAccess(r.Context(), agentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	thread, err := s.resolveCodingSession(r.Context(), access, agentName, sessionId)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get thread", err))
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.CodingThread{
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
		apiutil.WriteError(w, r, apiErr)
		return
	}
	row, err := s.resolveCodingSession(r.Context(), access, agentName, sessionId)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get thread", err))
		return
	}
	result, err := s.codingSuggestion(r.Context(), access, row.CodingWorktree, row.CodingProject, sessionId, input)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "generation_failed", err.Error(), err))
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func (s *Service) codingSuggestion(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject, sessionID string, input gatewayapi.CodingTextRequest) (gatewayapi.CodingTextSuggestion, error) {
	agentName := tree.AgentName
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	var name string
	var data codingPromptData
	switch input.Purpose {
	case gatewayapi.CodingTextBranch:
		if input.Text == nil || strings.TrimSpace(*input.Text) == "" {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusBadRequest,
				"missing_prompt",
				"A task is required to name the branch",
				nil,
			)
		}
		name = "branch.tmpl"
		data.Text = *input.Text
	case gatewayapi.CodingTextPR:
		if input.Text == nil || strings.TrimSpace(*input.Text) == "" {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusBadRequest,
				"missing_diff",
				"A branch diff is required",
				nil,
			)
		}
		name = "pr.tmpl"
		data.Text = *input.Text
	case gatewayapi.CodingTextCommit:
		status, err := s.codingFilesystem(
			ctx,
			access.namespace,
			tree,
			project,
			false,
			gatewayapi.CodingGitRequest{
				Operation:  gatewayapi.CodingGitDiff,
				Comparison: new(gatewayapi.CodingGitStaged),
			},
		)
		if err != nil {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusConflict,
				"git_conflict",
				err.Error(),
				err,
			)
		}
		if input.ExpectedTree == nil || status.Tree == nil || *input.ExpectedTree != *status.Tree {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusConflict,
				"stale_diff",
				"Staged changes changed; refresh before generating a message",
				nil,
			)
		}
		var files strings.Builder
		for _, file := range status.Files {
			if file.Index != " " && file.Index != "?" {
				fmt.Fprintf(&files, "%s %s\n", file.Index, file.Path)
			}
		}
		if files.Len() == 0 {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusBadRequest,
				"nothing_staged",
				"Stage changes before generating a commit message",
				nil,
			)
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
		return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_purpose",
			"Unknown suggestion purpose",
			nil,
		)
	}
	var prompt strings.Builder
	if err := codingPrompts.ExecuteTemplate(&prompt, name, data); err != nil {
		return gatewayapi.CodingTextSuggestion{}, fmt.Errorf("render coding prompt: %w", err)
	}
	// Model generation uses the request's deadline instead of the short
	// timeout used for ordinary gateway lookups. Keep the shared transport.
	httpClient := *s.outboundHTTP
	httpClient.Timeout = 0
	client, err := s.codingClient(ctx, access.namespace, agentName, &httpClient)
	if err != nil {
		return gatewayapi.CodingTextSuggestion{}, err
	}
	directory := "/home/agentz/" + tree.Directory
	body := gatewayapi.SessionCreateJSONRequestBody{
		ParentID: &sessionID, Title: new("Source control suggestion"),
		Permission: &gatewayapi.OpencodePermissionRuleset{{
			Permission: "*",
			Pattern:    "*",
			Action:     gatewayapi.OpencodePermissionActionDeny,
		}},
	}
	if input.Model == nil {
		parent, err := client.SessionGetWithResponse(
			ctx,
			agentName,
			sessionID,
			&gatewayapi.SessionGetParams{Directory: &directory},
		)
		if err != nil || parent.JSON200 == nil {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusBadGateway,
				"generation_failed",
				"Could not load the thread's model",
				err,
			)
		}
		body.Model = parent.JSON200.Model
	}
	session, err := client.SessionCreateWithResponse(
		ctx,
		agentName,
		&gatewayapi.SessionCreateParams{Directory: &directory},
		body,
	)
	if err != nil || session.JSON200 == nil {
		return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
			http.StatusBadGateway,
			"generation_failed",
			"Could not start source-control generation",
			err,
		)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		// Closing the HTTP request does not stop OpenCode's generation loop.
		// Stop it before deleting the session it may still be writing to.
		stopped, err := client.SessionAbortWithResponse(
			cleanup,
			agentName,
			session.JSON200.Id,
			&gatewayapi.SessionAbortParams{Directory: &directory},
		)
		if err != nil || stopped.StatusCode() != http.StatusOK {
			slog.WarnContext(
				cleanup, "stop source-control generation",
				"session", session.JSON200.Id, "error", err,
			)
			return
		}
		deleted, err := client.SessionDeleteWithResponse(
			cleanup,
			agentName,
			session.JSON200.Id,
			&gatewayapi.SessionDeleteParams{Directory: &directory},
		)
		if err != nil || deleted.StatusCode() != http.StatusOK {
			slog.WarnContext(
				cleanup,
				"remove source-control generation session",
				"session",
				session.JSON200.Id,
				"error",
				err,
			)
		}
	}()
	var part gatewayapi.OpencodePromptPartInput
	err = part.FromOpencodeTextPartInput(gatewayapi.OpencodeTextPartInput{
		Type: gatewayapi.OpencodeTextPartInputTypeText,
		Text: prompt.String(),
	})
	if err != nil {
		return gatewayapi.CodingTextSuggestion{}, err
	}
	reply, err := client.SessionPromptWithResponse(
		ctx,
		agentName,
		session.JSON200.Id,
		&gatewayapi.SessionPromptParams{Directory: &directory},
		gatewayapi.SessionPromptJSONRequestBody{
			Model: input.Model,
			Parts: []gatewayapi.OpencodePromptPartInput{part},
		},
	)
	if err != nil || reply.JSON200 == nil || reply.JSON200.Info.Error != nil {
		return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
			http.StatusBadGateway,
			"generation_failed",
			"Could not generate source-control text",
			err,
		)
	}
	var text strings.Builder
	for _, part := range reply.JSON200.Parts {
		kind, err := part.Discriminator()
		if err != nil {
			return gatewayapi.CodingTextSuggestion{}, err
		}
		if kind != string(gatewayapi.OpencodeTextPartTypeText) {
			continue
		}
		value, err := part.AsOpencodeTextPart()
		if err != nil {
			return gatewayapi.CodingTextSuggestion{}, err
		}
		text.WriteString(value.Text)
	}
	suggestion := strings.TrimSpace(text.String())
	valid := len(suggestion) > 0 && len(suggestion) <= 20000
	if input.Purpose == gatewayapi.CodingTextBranch {
		valid, _ = regexp.MatchString(
			`^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)/[a-z0-9]+(-[a-z0-9]+)*$`,
			suggestion,
		)
		valid = valid && len(suggestion) <= 60
	}
	if !valid {
		return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
			http.StatusBadGateway,
			"invalid_suggestion",
			"The model returned an invalid suggestion; try again",
			nil,
		)
	}
	result := gatewayapi.CodingTextSuggestion{Text: suggestion}
	if input.Purpose == gatewayapi.CodingTextPR {
		var pr gatewayapi.CodingPullRequestText
		err := json.Unmarshal([]byte(suggestion), &pr)
		validTitle := strings.TrimSpace(pr.Title) != "" && len(pr.Title) <= 256
		validBody := strings.TrimSpace(pr.Body) != "" && len(pr.Body) <= 20000
		if err != nil || !validTitle || !validBody {
			return gatewayapi.CodingTextSuggestion{}, apiutil.NewError(
				http.StatusBadGateway,
				"invalid_suggestion",
				"The model returned invalid PR content; try again",
				err,
			)
		}
		result.PullRequest = &pr
	}
	return result, nil
}

// RunCodingGit runs checkout operations under the project lock.
func (s *Service) RunCodingGit(w http.ResponseWriter, r *http.Request, worktreeId string) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	row, err := s.queries.GatewayGetCodingWorktree(
		r.Context(),
		gatewaydb.GatewayGetCodingWorktreeParams{ID: worktreeId, WorkspaceID: claims.WorkspaceID},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get worktree", err))
		return
	}
	if row.CodingProject.OwnerID != claims.UserID {
		apiutil.WriteError(w, r, mapGatewayStoreError("get checkout", pgx.ErrNoRows))
		return
	}
	access, apiErr := s.codingAccess(r.Context(), row.CodingWorktree.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var req gatewayapi.CodingGitRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	switch req.Operation {
	case gatewayapi.CodingGitStatus, gatewayapi.CodingGitDiff, gatewayapi.CodingGitStashes:
		if row.CodingWorktree.Deleting {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil),
			)
			return
		}
		if req.Operation == gatewayapi.CodingGitStatus && req.ExpectedHead == nil {
			snapshot, err := s.queries.GatewayTouchCodingSnapshot(
				r.Context(),
				gatewaydb.GatewayTouchCodingSnapshotParams{
					ProjectID:  row.CodingProject.ID,
					AgentName:  row.CodingWorktree.AgentName,
					WorktreeID: worktreeId,
				},
			)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			_, err = s.queries.GatewayTouchCodingSnapshot(
				r.Context(),
				gatewaydb.GatewayTouchCodingSnapshotParams{
					ProjectID: row.CodingProject.ID,
					AgentName: row.CodingWorktree.AgentName,
				},
			)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			var cached gatewayapi.CodingGitResult
			if err := json.Unmarshal(snapshot.Result, &cached); err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			if cached.Revision != "" && (req.Fresh == nil || !*req.Fresh) {
				apiutil.WriteJSON(w, http.StatusOK, cached)
				return
			}
		}
		result, err := s.codingFilesystem(
			r.Context(),
			access.namespace,
			row.CodingWorktree,
			row.CodingProject,
			false,
			req,
		)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "git_conflict", err.Error(), err))
			return
		}
		apiutil.WriteJSON(w, http.StatusOK, result)
		return
	}
	q, release, err := lockGatewayResource(r.Context(), s.lockDB, row.CodingProject.ID, false)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer release()
	row, err = q.GatewayGetCodingWorktree(
		r.Context(),
		gatewaydb.GatewayGetCodingWorktreeParams{ID: worktreeId, WorkspaceID: claims.WorkspaceID},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get worktree", err))
		return
	}
	switch req.Operation {
	case gatewayapi.CodingGitCheckout, gatewayapi.CodingGitRename, gatewayapi.CodingGitCreateBranch:
		bound, err := q.GatewayCodingWorktreeBound(r.Context(), worktreeId)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if bound {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conversation_started",
					"Branch selection is fixed once a conversation starts",
					nil,
				),
			)
			return
		}
	}
	if row.CodingProject.Deleting || row.CodingWorktree.Deleting && req.Operation != gatewayapi.CodingGitRemove {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusConflict, "deleting", "Checkout removal is in progress", nil),
		)
		return
	}
	if req.Operation == gatewayapi.CodingGitRemove {
		err = s.checkCodingAgentIdle(r.Context(), access, row.CodingWorktree)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "cleanup_blocked", err.Error(), err))
			return
		}
		err = q.GatewayDeletingCodingWorktree(
			r.Context(),
			gatewaydb.GatewayDeletingCodingWorktreeParams{ID: worktreeId, Deleting: true},
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	result, err := s.codingFilesystem(r.Context(), access.namespace, row.CodingWorktree, row.CodingProject, false, req)
	if err != nil {
		if req.Operation == gatewayapi.CodingGitRemove {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			resetErr := q.GatewayDeletingCodingWorktree(
				ctx,
				gatewaydb.GatewayDeletingCodingWorktreeParams{ID: worktreeId, Deleting: false},
			)
			if resetErr != nil {
				apiutil.WriteInternalError(w, r, resetErr)
				return
			}
		}
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "git_conflict", err.Error(), err))
		return
	}
	if req.Operation == gatewayapi.CodingGitRemove {
		err = s.deleteCodingConversations(r.Context(), access, row.CodingWorktree)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if err := q.GatewayDeleteCodingWorktree(r.Context(), worktreeId); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	if req.Operation != gatewayapi.CodingGitRemove && result.Branch != row.CodingWorktree.Branch {
		err = q.GatewayUpdateCodingBranch(
			r.Context(),
			gatewaydb.GatewayUpdateCodingBranchParams{ID: worktreeId, Branch: result.Branch},
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	err = q.GatewayInvalidateCodingSnapshots(r.Context(), row.CodingProject.ID)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func (s *Service) codingFilesystem(ctx context.Context, namespace string, tree gatewaydb.CodingWorktree, project gatewaydb.CodingProject, prepare bool, git gatewayapi.CodingGitRequest) (gatewayapi.CodingGitResult, error) {
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
	body, err := json.Marshal(filesystem.GitRequest{
		Root:       root,
		Directory:  tree.Directory,
		Branch:     tree.Branch,
		BaseBranch: project.DefaultBranch,
		Prepare:    prepare,
		Git:        git,
	})
	if err != nil {
		return result, err
	}
	method, endpoint := http.MethodPost, "git"
	if project.Deleting && git.Operation == gatewayapi.CodingGitRemove {
		method, endpoint = http.MethodDelete, "project"
	}
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		target.JoinPath(endpoint).String(),
		bytes.NewReader(body),
	)
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
		err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&failure)
		if err != nil {
			return result, fmt.Errorf("filesystem Git returned %d", response.StatusCode)
		}
		return result, errors.New(failure.Message)
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 90<<20)).Decode(&result)
	return result, err
}

// resolveCodingSession verifies ancestry before exposing or cataloging a child.
// Tasks create sessions inside the engine, so their first direct link can arrive
// before the gateway has seen any metadata for them.
func (s *Service) resolveCodingSession(ctx context.Context, access resourceAccess, agentName, sessionID string) (gatewaydb.GatewayResolveCodingSessionRow, error) {
	params := gatewaydb.GatewayResolveCodingSessionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agentName,
		SessionID:   sessionID,
		OwnerID:     access.userID,
	}
	row, err := s.queries.GatewayResolveCodingSession(ctx, params)
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, err
	}
	client, err := s.codingClient(ctx, access.namespace, agentName, s.outboundHTTP)
	if err != nil {
		return row, err
	}
	var children []gatewayapi.OpencodeSession
	seen := make(map[string]bool)
	for {
		if seen[params.SessionID] {
			return row, pgx.ErrNoRows
		}
		seen[params.SessionID] = true
		response, err := client.SessionGetWithResponse(ctx, agentName, params.SessionID, nil)
		if err != nil {
			return row, err
		}
		if response.JSON200 == nil {
			return row, pgx.ErrNoRows
		}
		switch response.JSON200.ParentID {
		case nil:
			err = s.storeOpenCodeSession(
				ctx,
				access.workspaceID,
				agentName,
				gatewaydb.ChatSessionKindChat,
				*response.JSON200,
			)
			if err != nil {
				return row, err
			}
		default:
			children = append(children, *response.JSON200)
			params.SessionID = *response.JSON200.ParentID
		}
		row, err = s.queries.GatewayResolveCodingSession(ctx, params)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return row, err
		}
		for _, child := range children {
			if path.Clean(child.Directory) != "/home/agentz/"+row.CodingWorktree.Directory {
				return row, pgx.ErrNoRows
			}
		}
		for i := len(children) - 1; i >= 0; i-- {
			err = s.storeOpenCodeSession(
				ctx,
				access.workspaceID,
				agentName,
				gatewaydb.ChatSessionKindChat,
				children[i],
			)
			if err != nil {
				return row, err
			}
		}
		return row, nil
	}
}

// enforceCodingSession prevents the generic engine routes from bypassing
// project-bound creation, directory routing, and shared-worktree revert rules.
func (s *Service) enforceCodingSession(r *http.Request, access resourceAccess, route *opencodeRouteMatch, agentName string) (func(), *apiutil.APIError) {
	workspace, err := s.queries.GatewayGetWorkspace(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceParams{ID: access.workspaceID, OrganizationID: access.organizationID},
	)
	if err != nil {
		return nil, mapGatewayStoreError("get workspace", err)
	}
	if workspace.Type != gatewaydb.WorkspaceTypeCoding {
		return nil, nil
	}
	if route.ID == "session.share" {
		return nil, apiutil.NewError(http.StatusForbidden, "private_project", "Coding conversations are private", nil)
	}
	changesCheckout := strings.Contains(route.Path, "/experimental/worktree") ||
		strings.Contains(route.Path, "/experimental/workspace") ||
		strings.HasSuffix(route.Path, "/move-session")
	if changesCheckout && r.Method != http.MethodGet {
		return nil, apiutil.NewError(
			http.StatusConflict,
			"managed_checkout",
			"Manage Coding checkouts from the project",
			nil,
		)
	}
	var create *gatewayapi.SessionCreateJSONBody
	var createV2 *gatewayapi.V2SessionCreateJSONBody
	switch route.ID {
	case "session.create":
		create = new(gatewayapi.SessionCreateJSONBody)
		if err := apiutil.DecodeJSONBody(r, create, true); err != nil {
			return nil, mapGatewayStoreError("read session", err)
		}
		create.WorkspaceID = nil
	case "v2.session.create":
		createV2 = new(gatewayapi.V2SessionCreateJSONBody)
		if err := apiutil.DecodeJSONBody(r, createV2, true); err != nil {
			return nil, mapGatewayStoreError("read session", err)
		}
	}
	sessionID := route.Params["sessionID"]
	var tree gatewaydb.CodingWorktree
	switch {
	case sessionID != "":
		thread, err := s.resolveCodingSession(r.Context(), access, agentName, sessionID)
		if err != nil {
			return nil, mapGatewayStoreError("get conversation", err)
		}
		tree = thread.CodingWorktree
	default:
		endpoint := strings.TrimPrefix(route.Path, "/api/opencode/{agentName}")
		catalog := false
		// These catalogs are agent capabilities, available before a checkout exists.
		if r.Method == http.MethodGet {
			switch endpoint {
			case "/agent", "/api/agent", "/provider", "/api/provider", "/provider/auth", "/config",
				"/config/providers", "/api/model", "/api/reference", "/api/integration",
				"/api/integration/{integrationID}", "/command", "/skill", "/experimental/tool",
				"/experimental/tool/ids", "/global/health", "/pty/shells":
				catalog = true
			}
		}
		switch {
		case catalog:
		case endpoint == "/event", endpoint == "/global/event", endpoint == "/session", endpoint == "/session/status",
			endpoint == "/api/session", endpoint == "/api/session/active",
			endpoint == "/path", endpoint == "/project/current",
			endpoint == "/project/{projectID}/directories",
			endpoint == "/lsp", endpoint == "/mcp", endpoint == "/formatter", endpoint == "/experimental/resource",
			strings.HasPrefix(endpoint, "/permission"), strings.HasPrefix(endpoint, "/question"),
			strings.HasPrefix(endpoint, "/pty"), strings.HasPrefix(endpoint, "/api/pty"),
			strings.HasPrefix(endpoint, "/file"), strings.HasPrefix(endpoint, "/find"), endpoint == "/vcs":
			// Global events are adapted from the scoped event stream.
		default:
			return nil, mapGatewayStoreError("get resource", pgx.ErrNoRows)
		}
		directory := r.URL.Query().Get("directory")
		if directory == "" {
			directory = r.URL.Query().Get("location[directory]")
		}
		if createV2 != nil && createV2.Location != nil {
			directory = createV2.Location.Directory
		}
		if catalog && (directory == "" || path.Clean(directory) == "/home/agentz") {
			// Pre-checkout catalogs must use the agent home, never a caller's
			// workspace selector or a previously active project's configuration.
			query := r.URL.Query()
			query.Set("directory", "/home/agentz")
			query.Set("location[directory]", "/home/agentz")
			query.Del("workspace")
			query.Del("location[workspace]")
			r.URL.RawQuery = query.Encode()
			r.Header.Del("X-Opencode-Directory")
			r.Header.Del("X-Opencode-Workspace")
			return nil, nil
		}
		directory = strings.TrimPrefix(path.Clean(directory), "/home/agentz/")
		tree, err = s.queries.GatewayOwnedCodingDirectory(
			r.Context(),
			gatewaydb.GatewayOwnedCodingDirectoryParams{
				WorkspaceID: access.workspaceID,
				AgentName:   agentName,
				OwnerID:     access.userID,
				Directory:   directory,
			},
		)
		if err != nil {
			return nil, mapGatewayStoreError("get checkout", err)
		}
		if strings.HasPrefix(endpoint, "/file") || strings.HasPrefix(endpoint, "/find") {
			clean := path.Clean(r.URL.Query().Get("path"))
			if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
				return nil, mapGatewayStoreError("get file", pgx.ErrNoRows)
			}
		}
		if route.ID == "pty.create" || route.ID == "v2.pty.create" {
			var body gatewayapi.PtyCreateJSONBody
			if err := apiutil.DecodeJSONBody(r, &body, false); err != nil {
				return nil, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Invalid terminal request", err)
			}
			body.Cwd = new("/home/agentz/" + tree.Directory)
			if err := replaceOpenCodeRequest(r, body); err != nil {
				return nil, apiutil.NewError(
					http.StatusInternalServerError, "internal_error",
					"Could not prepare terminal", err,
				)
			}
		}
	}
	// A synchronous prompt holds the project lock until generation finishes.
	// Its cancellation and input responses must be able to reach the agent.
	response := false
	switch route.ID {
	case "permission.reply", "permission.respond", "question.reply", "question.reject",
		"session.abort", "v2.session.interrupt", "v2.session.permission.reply",
		"v2.session.question.reply", "v2.session.question.reject":
		response = true
	}
	execution := false
	switch route.ID {
	case "session.prompt", "session.prompt_async", "session.command",
		"session.shell", "session.summarize", "v2.session.prompt",
		"v2.session.compact", "v2.session.wait":
		execution = true
	}
	var release func()
	if r.Method != http.MethodGet && r.Method != http.MethodHead && !response {
		q, unlock, err := lockGatewayResource(r.Context(), s.lockDB, tree.ProjectID, execution)
		if err != nil {
			return nil, mapGatewayStoreError("lock coding project", err)
		}
		release = unlock
		*r = *r.WithContext(context.WithValue(r.Context(), gatewayLockKey{}, q))
		current, err := q.GatewayGetCodingWorktree(
			r.Context(),
			gatewaydb.GatewayGetCodingWorktreeParams{ID: tree.ID, WorkspaceID: access.workspaceID},
		)
		if err != nil {
			return release, mapGatewayStoreError("get coding checkout", err)
		}
		tree = current.CodingWorktree
	}
	if tree.Deleting || !tree.Ready {
		return release, apiutil.NewError(
			http.StatusConflict,
			"checkout_unavailable",
			"This checkout is being prepared or removed",
			nil,
		)
	}
	revert := strings.HasSuffix(route.Path, "/revert") ||
		strings.Contains(route.Path, "/revert/")
	if revert && tree.Shared {
		return release, apiutil.NewError(
			http.StatusConflict,
			"shared_worktree",
			"Filesystem revert is unavailable after multiple threads have used this worktree",
			nil,
		)
	}
	if create != nil {
		if create.ParentID != nil {
			parent, err := s.resolveCodingSession(r.Context(), access, agentName, *create.ParentID)
			if err != nil || parent.CodingWorktree.ID != tree.ID {
				return release, mapGatewayStoreError("get parent session", pgx.ErrNoRows)
			}
		}
		if err := replaceOpenCodeRequest(r, create); err != nil {
			return release, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Invalid session request", err)
		}
	}
	if createV2 != nil {
		createV2.Location = &gatewayapi.OpencodeLocationRef{Directory: "/home/agentz/" + tree.Directory}
		if err := replaceOpenCodeRequest(r, createV2); err != nil {
			return release, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Invalid session request", err)
		}
	}
	if route.ID == "project.directories" {
		client, err := s.codingClient(r.Context(), access.namespace, agentName, s.outboundHTTP)
		if err != nil {
			return release, mapGatewayStoreError("get project", err)
		}
		directory := "/home/agentz/" + tree.Directory
		current, err := client.ProjectCurrentWithResponse(
			r.Context(), agentName,
			&gatewayapi.ProjectCurrentParams{Directory: &directory},
		)
		if err != nil {
			return release, mapGatewayStoreError("get project", err)
		}
		if current.JSON200 == nil || current.JSON200.Id != route.Params["projectID"] {
			return release, mapGatewayStoreError("get project", pgx.ErrNoRows)
		}
	}
	if route.ID == "v2.session.list" && r.URL.Query().Get("cursor") != "" {
		// Native cursors embed the list query and override URL parameters.
		// Require the exact upstream JSON field names. Go struct decoding
		// also accepts uppercase names that OpenCode ignores.
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(r.URL.Query().Get("cursor"), "="))
		if err != nil {
			return release, apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid session cursor", err)
		}
		var cursor gatewayapi.V2SessionListParams
		if err := json.Unmarshal(raw, &cursor); err != nil {
			return release, apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid session cursor", err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return release, apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid session cursor", err)
		}
		cursor.Directory = nil
		if err := json.Unmarshal(fields["directory"], &cursor.Directory); err != nil {
			return release, apiutil.NewError(
				http.StatusBadRequest, "invalid_cursor",
				"Invalid session cursor directory", err,
			)
		}
		sameDirectory := cursor.Directory != nil &&
			*cursor.Directory == "/home/agentz/"+tree.Directory
		if !sameDirectory || cursor.Project != nil || cursor.Workspace != nil {
			return release, apiutil.NewError(
				http.StatusBadRequest, "invalid_cursor",
				"Session cursor belongs to another checkout", nil,
			)
		}
	}
	query := r.URL.Query()
	if strings.HasSuffix(route.Path, "/session") {
		query.Del("path")
	}
	query.Set("directory", "/home/agentz/"+tree.Directory)
	query.Set("location[directory]", "/home/agentz/"+tree.Directory)
	query.Del("scope")
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
	statuses, err := client.SessionStatusWithResponse(
		ctx,
		tree.AgentName,
		&gatewayapi.SessionStatusParams{Directory: &directory},
	)
	if err != nil {
		return errors.New("agent is unavailable; retry cleanup when it is running")
	}
	if statuses.JSON200 == nil {
		return errors.New("could not confirm agent session status")
	}
	for _, status := range *statuses.JSON200 {
		state, err := status.Discriminator()
		if err != nil || state != string(gatewayapi.Idle) {
			return errors.New("stop running agent tasks before removing a checkout")
		}
	}
	terminals, err := client.PtyListWithResponse(
		ctx, tree.AgentName,
		&gatewayapi.PtyListParams{Directory: &directory},
	)
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

func (s *Service) deleteCodingConversations(ctx context.Context, access resourceAccess, tree gatewaydb.CodingWorktree) error {
	client, err := s.codingClient(ctx, access.namespace, tree.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	directory := "/home/agentz/" + tree.Directory
	threads, err := s.queries.GatewayListCodingWorktreeThreads(ctx, tree.ID)
	if err != nil {
		return err
	}
	for _, thread := range threads {
		if !thread.SessionID.Valid {
			continue
		}
		response, err := client.SessionDeleteWithResponse(
			ctx,
			tree.AgentName,
			thread.SessionID.String,
			&gatewayapi.SessionDeleteParams{Directory: &directory},
		)
		if err != nil {
			return err
		}
		if response.StatusCode() != http.StatusOK && response.StatusCode() != http.StatusNotFound {
			return errors.New("could not delete agent conversation")
		}
		_, err = s.queries.GatewayDeleteSessionTraces(
			ctx,
			gatewaydb.GatewayDeleteSessionTracesParams{
				TenantNamespace: access.namespace,
				AgentName:       tree.AgentName,
				SessionID:       thread.SessionID.String,
			},
		)
		if err != nil {
			return err
		}
	}
	return s.queries.GatewayDeleteCodingConversations(
		ctx,
		gatewaydb.GatewayDeleteCodingConversationsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   tree.AgentName,
			WorktreeID:  tree.ID,
		},
	)
}

// gatewayLocks gives nested request locks one connection. Keeping the scope
// alive independently of each lock lets admission end before execution does.
func gatewayLocks(ctx context.Context, pool *pgxpool.Pool) (context.Context, func(), error) {
	if _, ok := ctx.Value(gatewayLockKey{}).(*gatewaydb.Queries); ok {
		return ctx, nil, nil
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return ctx, nil, err
	}
	q := gatewaydb.New(conn)
	return context.WithValue(ctx, gatewayLockKey{}, q), func() {
		defer conn.Release()
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := q.GatewayUnlockResources(ctx); err != nil {
			conn.Conn().Close(ctx)
		}
	}, nil
}

// lockGatewayResource holds a cross-replica lock across database and engine IO.
func lockGatewayResource(ctx context.Context, pool *pgxpool.Pool, identity string, shared bool) (*gatewaydb.Queries, func(), error) {
	ctx, release, err := gatewayLocks(ctx, pool)
	if err != nil {
		return nil, nil, err
	}
	q := ctx.Value(gatewayLockKey{}).(*gatewaydb.Queries)
	err = q.GatewayLockResource(ctx, gatewaydb.GatewayLockResourceParams{Identity: identity, Shared: shared})
	if err != nil {
		if release != nil {
			release()
		}
		return nil, nil, err
	}
	return q, func() {
		if release != nil {
			defer release()
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, err := q.GatewayUnlockResource(
			ctx, gatewaydb.GatewayUnlockResourceParams{Identity: identity, Shared: shared},
		)
		if err != nil {
			slog.ErrorContext(ctx, "release gateway lock", "error", err)
		}
	}, nil
}
