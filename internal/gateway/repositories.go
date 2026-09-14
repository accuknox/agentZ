package gateway

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v91/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// ListCodingRefs serves cached repository discovery without waiting for GitHub.
func (s *Service) ListCodingRefs(w http.ResponseWriter, r *http.Request, projectId string, params gatewayapi.ListCodingRefsParams) {
	access, apiErr := s.codingAccess(r.Context(), params.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	project, err := s.queries.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.claims.UserID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	row, err := s.queries.GatewayTouchCodingSnapshot(
		r.Context(),
		gatewaydb.GatewayTouchCodingSnapshotParams{ProjectID: project.ID, AgentName: params.AgentName},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	var status gatewayapi.CodingGitResult
	if err := json.Unmarshal(row.Result, &status); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	snapshot := gatewayapi.CodingRepositorySnapshot{
		Refs:       []gatewayapi.CodingRef{},
		Worktrees:  []gatewayapi.CodingDiscoveredWorktree{},
		Refreshing: true,
	}
	if status.Repository != nil {
		snapshot = *status.Repository
		snapshot.Refreshing = time.Now().Before(row.LeaseUntil)
	}
	query := ""
	if params.Query != nil {
		query = strings.ToLower(strings.TrimSpace(*params.Query))
	}
	refs := make([]gatewayapi.CodingRef, 0, len(snapshot.Refs))
	for _, ref := range snapshot.Refs {
		if strings.Contains(strings.ToLower(ref.Name), query) {
			refs = append(refs, ref)
		}
	}
	slices.SortFunc(refs, func(a, b gatewayapi.CodingRef) int {
		if a.Current != b.Current {
			if a.Current {
				return -1
			}
			return 1
		}
		if a.Default != b.Default {
			if a.Default {
				return -1
			}
			return 1
		}
		if order := cmp.Compare(b.CommittedAt, a.CommittedAt); order != 0 {
			return order
		}
		return strings.Compare(a.Ref, b.Ref)
	})
	offset := 0
	if params.Cursor != nil {
		revision, value, ok := strings.Cut(*params.Cursor, ":")
		if !ok || revision != snapshot.Revision {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"snapshot_changed",
					"Branches changed; restart the search",
					nil,
				),
			)
			return
		}
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > len(refs) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid branch cursor", nil),
			)
			return
		}
	}
	snapshot.TotalCount = len(refs)
	end := min(offset+100, len(refs))
	snapshot.Refs = refs[offset:end]
	snapshot.NextCursor = nil
	if end < len(refs) {
		snapshot.NextCursor = new(fmt.Sprintf("%s:%d", snapshot.Revision, end))
	}
	apiutil.WriteJSON(w, http.StatusOK, snapshot)
}

// RefreshCodingRepository schedules a refresh without extending the UI request.
func (s *Service) RefreshCodingRepository(w http.ResponseWriter, r *http.Request, projectId string, params gatewayapi.RefreshCodingRepositoryParams) {
	access, apiErr := s.codingAccess(r.Context(), params.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	_, err := s.queries.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.claims.UserID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	_, err = s.queries.GatewayTouchCodingSnapshot(
		r.Context(),
		gatewaydb.GatewayTouchCodingSnapshotParams{ProjectID: projectId, AgentName: params.AgentName},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if err := s.queries.GatewayInvalidateCodingSnapshots(r.Context(), projectId); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(
		w,
		http.StatusAccepted,
		gatewayapi.CodingRepositorySnapshot{
			Refs:       []gatewayapi.CodingRef{},
			Worktrees:  []gatewayapi.CodingDiscoveredWorktree{},
			Refreshing: true,
		},
	)
}

// AdoptCodingWorktree registers only a freshly verified project worktree.
func (s *Service) AdoptCodingWorktree(w http.ResponseWriter, r *http.Request, projectId string) {
	var input gatewayapi.AdoptCodingWorktreeRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), input.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	q, release, err := s.lockCodingProject(r.Context(), projectId)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer release()
	project, err := q.GatewayGetCodingProject(
		r.Context(),
		gatewaydb.GatewayGetCodingProjectParams{
			ID:          projectId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.claims.UserID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get project", err))
		return
	}
	root := path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID)
	tree := gatewaydb.CodingWorktree{AgentName: input.AgentName, Directory: root + "/repo"}
	result, err := s.codingFilesystem(
		r.Context(),
		access.namespace,
		tree,
		project,
		false,
		gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiscover},
	)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "discovery_failed", err.Error(), err))
		return
	}
	if result.Repository != nil {
		for _, discovered := range result.Repository.Worktrees {
			if discovered.Directory != input.Directory || !discovered.Available {
				continue
			}
			tree, err := q.GatewayAdoptCodingWorktree(
				r.Context(),
				gatewaydb.GatewayAdoptCodingWorktreeParams{
					ID:          uuid.NewString(),
					WorkspaceID: access.workspaceID,
					ProjectID:   projectId,
					AgentName:   input.AgentName,
					Directory:   strings.TrimPrefix(discovered.Directory, "/home/agentz/"),
					Branch:      discovered.Branch,
				},
			)
			if err != nil {
				apiutil.WriteError(w, r, mapGatewayStoreError("adopt worktree", err))
				return
			}
			if err := q.GatewayInvalidateCodingSnapshots(r.Context(), projectId); err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			apiutil.WriteJSON(w, http.StatusCreated, codingWorktree(tree))
			return
		}
	}
	apiutil.WriteError(
		w,
		r,
		apiutil.NewError(
			http.StatusConflict,
			"worktree_unavailable",
			"Worktree changed or is outside this project",
			nil,
		),
	)
}

func (s *Service) refreshCodingSnapshot(ctx context.Context, snapshot gatewaydb.CodingSnapshot) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var result gatewayapi.CodingGitResult
	if err := json.Unmarshal(snapshot.Result, &result); err != nil {
		slog.ErrorContext(ctx, "decode coding snapshot", "error", err)
		return
	}
	// JSONB rewrites whitespace and key order. Compare encoded API values so
	// unchanged refreshes do not invalidate every subscriber's query cache.
	before, err := json.Marshal(result)
	if err != nil {
		slog.ErrorContext(ctx, "encode previous coding snapshot", "error", err)
		return
	}
	var previous gatewayapi.CodingRepositorySnapshot
	if result.Repository != nil {
		previous = *result.Repository
	}
	project, err := s.queries.GatewayCodingProjectIdentity(ctx, snapshot.ProjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err == nil {
		var access resourceAccess
		access, err = s.codingWorkerAccess(ctx, project, snapshot.AgentName)
		if err == nil {
			err = s.loadCodingSnapshot(ctx, access, project.CodingProject, &snapshot, &result)
		}
	}
	now := time.Now().UTC()
	interval := time.Minute
	if now.Before(snapshot.DemandUntil) {
		interval = 5 * time.Second
	}
	var failures int32
	if err != nil {
		failures = snapshot.Failures + 1
		interval = min(30*time.Second*time.Duration(1<<min(failures-1, 5)), 15*time.Minute)
		message := err.Error()
		var rate *github.RateLimitError
		var abuse *github.AbuseRateLimitError
		switch {
		case errors.As(err, &rate):
			interval = max(interval, time.Until(rate.Rate.Reset.Time))
			message = "GitHub rate limit reached; refresh will retry automatically"
		case errors.As(err, &abuse):
			if abuse.RetryAfter != nil {
				interval = max(interval, *abuse.RetryAfter)
			}
			message = "GitHub requested a cooldown; refresh will retry automatically"
		}
		if rate != nil || abuse != nil {
			retry := now.Add(interval)
			err = s.queries.GatewayDelayCodingGitHub(
				ctx,
				gatewaydb.GatewayDelayCodingGitHubParams{OwnerID: project.CodingProject.OwnerID, RetryAfter: retry},
			)
			if err != nil {
				slog.ErrorContext(ctx, "save GitHub cooldown", "error", err)
			}
		}
		result.RemoteError = &message
		if snapshot.WorktreeID == "" {
			if result.Repository == nil {
				result.Repository = &gatewayapi.CodingRepositorySnapshot{
					Refs:      []gatewayapi.CodingRef{},
					Worktrees: []gatewayapi.CodingDiscoveredWorktree{},
				}
			}
			result.Repository.Error = &message
			result.Repository.Refreshing = false
		}
	}
	snapshot.Failures = failures
	if result.Repository != nil {
		repository := result.Repository
		repository.Refreshing = false
		repository.TotalCount = len(repository.Refs)
		repository.Revision, repository.UpdatedAt = "", nil
		body, err := json.Marshal(repository)
		if err != nil {
			slog.ErrorContext(ctx, "encode repository", "error", err)
			return
		}
		hash := sha256.Sum256(body)
		repository.Revision = hex.EncodeToString(hash[:])
		repository.UpdatedAt = &now
		if previous.Revision == repository.Revision {
			repository.UpdatedAt = previous.UpdatedAt
		}
	}
	body, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		slog.ErrorContext(ctx, "encode coding snapshot", "error", marshalErr)
		return
	}
	// Release the refresh lease even when the remote deadline expired.
	save, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	rows, err := s.queries.GatewaySaveCodingSnapshot(
		save,
		gatewaydb.GatewaySaveCodingSnapshotParams{
			ProjectID:   snapshot.ProjectID,
			AgentName:   snapshot.AgentName,
			WorktreeID:  snapshot.WorktreeID,
			Result:      body,
			NextRefresh: now.Add(interval),
			NextRemote:  snapshot.NextRemote,
			Failures:    snapshot.Failures,
			RemoteRefs:  snapshot.RemoteRefs,
			Generation:  snapshot.Generation,
			LeaseUntil:  snapshot.LeaseUntil,
		},
	)
	if err != nil {
		slog.ErrorContext(ctx, "save coding refresh", "error", err)
		return
	}
	if rows == 1 && !bytes.Equal(before, body) {
		err = s.queries.GatewayNotifyCoding(
			save,
			gatewaydb.GatewayNotifyCodingParams{
				WorkspaceID: project.CodingProject.WorkspaceID,
				OwnerID:     project.CodingProject.OwnerID,
			},
		)
		if err != nil {
			slog.ErrorContext(ctx, "notify coding refresh", "error", err)
		}
	}
}

func (s *Service) loadCodingSnapshot(ctx context.Context, access resourceAccess, project gatewaydb.CodingProject, snapshot *gatewaydb.CodingSnapshot, result *gatewayapi.CodingGitResult) error {
	root := path.Join("Projects", base64.RawURLEncoding.EncodeToString([]byte(project.OwnerID)), "github", project.ID)
	tree := gatewaydb.CodingWorktree{AgentName: snapshot.AgentName, Directory: root + "/repo"}
	if snapshot.WorktreeID != "" {
		row, err := s.queries.GatewayGetCodingWorktree(
			ctx,
			gatewaydb.GatewayGetCodingWorktreeParams{ID: snapshot.WorktreeID, WorkspaceID: project.WorkspaceID},
		)
		if err != nil || row.CodingWorktree.Deleting || !row.CodingWorktree.Ready {
			return errors.New("checkout is unavailable")
		}
		tree = row.CodingWorktree
		current, err := s.codingFilesystem(
			ctx,
			access.namespace,
			tree,
			project,
			false,
			gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus},
		)
		if err != nil {
			return err
		}
		if current.Branch == result.Branch {
			current.PullRequest = result.PullRequest
		}
		current.RemoteError = result.RemoteError
		*result = current
		if time.Now().Before(snapshot.NextRemote) {
			return nil
		}
		if current.Branch == "" {
			snapshot.NextRemote = time.Now().Add(time.Minute)
			return nil
		}
		identity, err := s.codingIdentity(ctx, project.OwnerID)
		if err != nil {
			return err
		}
		repository, _, err := identity.client.Repositories.GetByID(ctx, project.RepositoryID)
		if err != nil {
			return err
		}
		owner, repo := repository.GetOwner().GetLogin(), repository.GetName()
		pulls, _, err := identity.client.PullRequests.List(
			ctx,
			owner,
			repo,
			&github.PullRequestListOptions{
				Head:        owner + ":" + current.Branch,
				State:       "open",
				ListOptions: github.ListOptions{PerPage: 1},
			},
		)
		if err != nil {
			return err
		}
		checked, err := s.codingFilesystem(
			ctx,
			access.namespace,
			tree,
			project,
			false,
			gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus},
		)
		if err != nil {
			return err
		}
		if checked.Branch != current.Branch {
			*result = checked
			snapshot.NextRemote = time.Now()
			return nil
		}
		result.RemoteError = nil
		result.PullRequest = nil
		if len(pulls) > 0 {
			result.PullRequest = &gatewayapi.CodingPullRequest{
				Number: pulls[0].GetNumber(),
				Url:    pulls[0].GetHTMLURL(),
			}
		}
		snapshot.NextRemote = time.Now().Add(time.Minute)
		if time.Now().Before(snapshot.DemandUntil) {
			snapshot.NextRemote = time.Now().Add(30 * time.Second)
		}
		return nil
	}
	trees, err := s.queries.GatewayListCodingWorktrees(
		ctx,
		gatewaydb.GatewayListCodingWorktreesParams{ProjectID: project.ID, WorkspaceID: project.WorkspaceID},
	)
	if err != nil {
		return err
	}
	ready := false
	for _, existing := range trees {
		ready = ready || existing.AgentName == tree.AgentName && existing.Ready && !existing.Deleting
	}
	if ready {
		current, err := s.codingFilesystem(
			ctx,
			access.namespace,
			tree,
			project,
			false,
			gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiscover},
		)
		if err != nil {
			return err
		}
		current.RemoteError = result.RemoteError
		*result = current
		for i := range result.Repository.Worktrees {
			discovered := &result.Repository.Worktrees[i]
			for _, managed := range trees {
				if managed.AgentName == tree.AgentName && discovered.Directory == "/home/agentz/"+managed.Directory {
					discovered.ManagedId = &managed.ID
					if managed.Deleting {
						discovered.Available = false
						discovered.Reason = new("Checkout removal is in progress")
					}
					break
				}
			}
		}
	}
	var remoteErr error
	if !time.Now().Before(snapshot.NextRemote) && (time.Now().Before(snapshot.DemandUntil) || !ready) {
		identity, err := s.codingIdentity(ctx, project.OwnerID)
		if err != nil {
			return err
		}
		repository, _, err := identity.client.Repositories.GetByID(ctx, project.RepositoryID)
		if err != nil {
			return err
		}
		if project.Repository != repository.GetFullName() || project.DefaultBranch != repository.GetDefaultBranch() {
			project.Repository, project.DefaultBranch = repository.GetFullName(), repository.GetDefaultBranch()
			err = s.queries.GatewayUpdateCodingRepository(
				ctx,
				gatewaydb.GatewayUpdateCodingRepositoryParams{
					ID:            project.ID,
					Repository:    project.Repository,
					DefaultBranch: project.DefaultBranch,
				},
			)
			if err != nil {
				return err
			}
		}
		repo, err := newCodingRepository(ctx, project.Repository, identity.token)
		if err != nil {
			return err
		}
		defer os.RemoveAll(repo.dir)
		remote, err := repo.run(ctx, true, "ls-remote", "--heads", repo.url)
		if err != nil {
			return err
		}
		switch {
		case !ready:
			result.Repository = &gatewayapi.CodingRepositorySnapshot{
				Refs:      []gatewayapi.CodingRef{},
				Worktrees: []gatewayapi.CodingDiscoveredWorktree{},
			}
			for _, line := range strings.Split(remote, "\n") {
				head, ref, ok := strings.Cut(line, "\t")
				if !ok {
					continue
				}
				name := strings.TrimPrefix(ref, "refs/heads/")
				result.Repository.Refs = append(
					result.Repository.Refs,
					gatewayapi.CodingRef{
						Ref:     "refs/remotes/origin/" + name,
						Name:    "origin/" + name,
						Head:    head,
						Remote:  true,
						Default: name == project.DefaultBranch,
					},
				)
			}
		case remote != snapshot.RemoteRefs:
			_, release, err := s.lockCodingProject(ctx, project.ID)
			if err != nil {
				return err
			}
			defer release()
			var bundle []byte
			bundle, remoteErr = repo.fetchBundle(ctx)
			if remoteErr == nil {
				_, remoteErr = s.codingFilesystem(
					ctx,
					access.namespace,
					tree,
					project,
					false,
					gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitImport, Bundle: &bundle},
				)
			}
		}
		if remoteErr == nil {
			result.RemoteError = nil
			if result.Repository != nil {
				result.Repository.Error = nil
			}
			snapshot.RemoteRefs = remote
			snapshot.NextRemote = time.Now().Add(30 * time.Second)
		}
	}

	return remoteErr
}

// WatchCoding sends invalidations; reconnecting readers obtain persisted state.
func (s *Service) WatchCoding(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		apiutil.WriteInternalError(w, r, errors.New("streaming is unavailable"))
		return
	}
	events, release := s.codingEvents.subscribe(access.workspaceID + "/" + access.claims.UserID)
	defer release()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case revision := <-events:
			body, err := json.Marshal(gatewayapi.WatchChatSessionsEvent{Revision: strconv.FormatUint(revision, 10)})
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, apiErr := s.codingAccess(r.Context(), ""); apiErr != nil {
				return
			}
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Service) listenCoding(ctx context.Context) {
	for ctx.Err() == nil {
		conn, err := s.db.Acquire(ctx)
		if err == nil {
			q := gatewaydb.New(conn.Conn())
			err = q.GatewayListenCoding(ctx)
			for err == nil {
				notification, waitErr := conn.Conn().WaitForNotification(ctx)
				err = waitErr
				if err == nil {
					s.codingEvents.publish(notification.Payload)
				}
			}
			conn.Release()
		}
		if ctx.Err() != nil {
			return
		}
		slog.ErrorContext(ctx, "listen for coding updates", "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
