package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/go-github/v91/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// codingWorkerAccess resolves current grants from the saved owner identity. A
// worker is never a system actor and cannot bypass personal project ownership.
func (s *Service) codingWorkerAccess(ctx context.Context, project gatewaydb.GatewayCodingProjectIdentityRow, agent string) (resourceAccess, error) {
	claims := gatewayClaims{
		UserID:         project.CodingProject.OwnerID,
		OrganizationID: project.OrganizationID,
		WorkspaceID:    project.CodingProject.WorkspaceID,
	}
	access := resourceAccess{
		claims:      claims,
		workspaceID: claims.WorkspaceID,
		operation:   authorization.OperationUseSharedAgent,
	}
	effective, err := authorization.New(s.queries).Resolve(
		ctx,
		authorization.Subject{UserID: claims.UserID, OrganizationID: claims.OrganizationID},
	)
	if err != nil {
		return access, err
	}
	access.effective = effective
	allowed, err := s.agentOperationAllowed(ctx, access, agent, access.operation)
	if err != nil || !allowed {
		return access, errors.New("project owner no longer has access to this agent")
	}
	namespace, owner, apiErr := s.resolveResourceScope(ctx, claims, claims.WorkspaceID, "Agent")
	if apiErr != nil {
		return access, apiErr
	}
	access.namespace, access.owner, access.authorized = namespace, owner, true
	return access, nil
}

// StartCodingOperation persists intent before returning; the browser does not
// own execution and resubmitting a lost response cannot repeat a remote write.
func (s *Service) StartCodingOperation(w http.ResponseWriter, r *http.Request) {
	var input gatewayapi.CodingOperationRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.codingAccess(r.Context(), input.AgentName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	row, err := s.queries.GatewayGetCodingThread(
		r.Context(),
		gatewaydb.GatewayGetCodingThreadParams{
			WorkspaceID: access.workspaceID,
			AgentName:   input.AgentName,
			SessionID:   pgtype.Text{String: input.SessionId, Valid: true},
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get coding thread", err))
		return
	}
	if row.CodingProject.OwnerID != access.claims.UserID || row.CodingWorktree.Deleting || !row.CodingWorktree.Ready {
		apiutil.WriteError(w, r, mapGatewayStoreError("get checkout", pgx.ErrNoRows))
		return
	}
	result := gatewayapi.CodingOperation{
		Id:         input.Id,
		ProjectId:  row.CodingProject.ID,
		WorktreeId: row.CodingWorktree.ID,
		AgentName:  input.AgentName,
		SessionId:  input.SessionId,
		Action:     input.Action,
		State:      gatewayapi.CodingOperationQueued,
		Stage:      "Queued",
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}
	request, err := json.Marshal(input)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	body, err := json.Marshal(result)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	job, err := s.queries.GatewayCreateCodingOperation(
		r.Context(),
		gatewaydb.GatewayCreateCodingOperationParams{
			ID:             input.Id,
			WorkspaceID:    access.workspaceID,
			OrganizationID: access.claims.OrganizationID,
			OwnerID:        access.claims.UserID,
			ProjectID:      row.CodingProject.ID,
			WorktreeID:     row.CodingWorktree.ID,
			Request:        request,
			Result:         body,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("create coding operation", err))
		return
	}
	var previous gatewayapi.CodingOperationRequest
	if err := json.Unmarshal(job.Request, &previous); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	canonical, err := json.Marshal(previous)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if !bytes.Equal(canonical, request) {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusConflict,
				"operation_conflict",
				"Operation ID already belongs to another request",
				nil,
			),
		)
		return
	}
	if err := json.Unmarshal(job.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusAccepted, result)
}

// ListCodingOperations restores running and recent results after navigation.
func (s *Service) ListCodingOperations(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	rows, err := s.queries.GatewayListCodingOperations(
		r.Context(),
		gatewaydb.GatewayListCodingOperationsParams{WorkspaceID: access.workspaceID, OwnerID: access.claims.UserID},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result := []gatewayapi.CodingOperation{}
	checked := make(map[string]bool)
	for _, row := range rows {
		var operation gatewayapi.CodingOperation
		if err := json.Unmarshal(row.Result, &operation); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		allowed, ok := checked[operation.AgentName]
		if !ok {
			_, apiErr := s.codingAccess(r.Context(), operation.AgentName)
			allowed = apiErr == nil
			checked[operation.AgentName] = allowed
		}
		if !allowed {
			continue
		}

		result = append(result, operation)
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// GetCodingOperation reads a persisted result on any gateway replica.
func (s *Service) GetCodingOperation(w http.ResponseWriter, r *http.Request, operationId string) {
	access, apiErr := s.codingAccess(r.Context(), "")
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	job, err := s.queries.GatewayGetCodingOperation(
		r.Context(),
		gatewaydb.GatewayGetCodingOperationParams{
			ID:          operationId,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.claims.UserID,
		},
	)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get coding operation", err))
		return
	}
	var result gatewayapi.CodingOperation
	if err := json.Unmarshal(job.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if _, apiErr := s.codingAccess(r.Context(), result.AgentName); apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func (s *Service) runCoding(ctx context.Context) {
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				job, err := s.queries.GatewayClaimCodingOperation(ctx, uuid.NewString())
				if err == nil {
					s.runCodingOperation(ctx, job)
					continue
				}
				if !errors.Is(err, pgx.ErrNoRows) {
					slog.ErrorContext(ctx, "claim coding operation", "error", err)
					continue
				}
				snapshot, err := s.queries.GatewayClaimCodingSnapshot(ctx)
				if err == nil {
					s.refreshCodingSnapshot(ctx, snapshot)
					continue
				}
				if !errors.Is(err, pgx.ErrNoRows) {
					slog.ErrorContext(ctx, "claim coding refresh", "error", err)
				}
			}
		})
	}
	wg.Go(func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			if err := s.queries.GatewayPruneCodingSnapshots(ctx); err != nil {
				slog.ErrorContext(ctx, "prune coding snapshots", "error", err)
			}
			if err := s.queries.GatewaySeedCodingSnapshots(ctx); err != nil {
				slog.ErrorContext(ctx, "seed coding refresh", "error", err)
			}
			workspaces, err := s.queries.GatewayInterruptCodingOperations(ctx)
			if err != nil {
				slog.ErrorContext(ctx, "interrupt abandoned coding operations", "error", err)
			}
			for _, workspace := range workspaces {
				err := s.queries.GatewayNotifyCoding(ctx, gatewaydb.GatewayNotifyCodingParams(workspace))
				if err != nil {
					slog.ErrorContext(ctx, "notify interrupted coding operation", "error", err)
				}
			}
			if err := s.queries.GatewayDeleteOldCodingOperations(ctx); err != nil {
				slog.ErrorContext(ctx, "expire coding operations", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	wg.Wait()
}

func (s *Service) runCodingOperation(ctx context.Context, job gatewaydb.CodingOperation) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var result gatewayapi.CodingOperation
	var input gatewayapi.CodingOperationRequest
	if err := json.Unmarshal(job.Result, &result); err != nil {
		slog.ErrorContext(ctx, "decode coding operation", "error", err)
		return
	}
	if err := json.Unmarshal(job.Request, &input); err != nil {
		slog.ErrorContext(ctx, "decode coding request", "error", err)
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				rows, err := s.queries.GatewayHeartbeatCodingOperation(
					ctx,
					gatewaydb.GatewayHeartbeatCodingOperationParams{ID: job.ID, LeaseToken: job.LeaseToken},
				)
				if err != nil || rows != 1 {
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-done
	}()
	publish := func(stage string) error {
		result.Stage, result.UpdatedAt = stage, time.Now().UTC()
		body, err := json.Marshal(result)
		if err != nil {
			return err
		}
		rows, err := s.queries.GatewayUpdateCodingOperation(
			ctx,
			gatewaydb.GatewayUpdateCodingOperationParams{ID: job.ID, LeaseToken: job.LeaseToken, Result: body},
		)
		if err != nil || rows != 1 {
			return errors.New("operation lease lost")
		}
		return s.queries.GatewayNotifyCoding(
			ctx,
			gatewaydb.GatewayNotifyCodingParams{WorkspaceID: job.WorkspaceID, OwnerID: job.OwnerID},
		)
	}
	err := s.executeCodingOperation(ctx, job, input, &result, publish)
	if ctx.Err() != nil {
		// Expiry recovery marks this operation interrupted. A cancelled worker
		// must never publish a success or replay an unconfirmed remote write.
		return
	}
	// Completion wakes readers, so discard pre-mutation snapshots first.
	cacheErr := s.queries.GatewayInvalidateCodingSnapshots(ctx, job.ProjectID)
	if cacheErr != nil {
		slog.ErrorContext(ctx, "invalidate coding snapshots", "error", cacheErr)
		err = errors.Join(err, fmt.Errorf("invalidate coding snapshots: %w", cacheErr))
	}
	result.State = gatewayapi.CodingOperationSucceeded
	stage := "Completed"
	if err != nil {
		result.State, result.Error = gatewayapi.CodingOperationFailed, new(err.Error())
		stage = "Failed"
	}
	if err := publish(stage); err != nil {
		slog.ErrorContext(ctx, "save coding result", "operation", job.ID, "error", err)
	}
}

func (s *Service) executeCodingOperation(ctx context.Context, job gatewaydb.CodingOperation, input gatewayapi.CodingOperationRequest, result *gatewayapi.CodingOperation, publish func(string) error) error {
	if input.Action == gatewayapi.CodingActionNameBranch {
		return s.nameCodingBranch(ctx, job, input, publish)
	}
	if err := publish("Preparing checkout"); err != nil {
		return err
	}
	_, release, err := lockGatewayResource(ctx, s.lockDB, job.ProjectID, false)
	if err != nil {
		return err
	}
	defer release()
	project, err := s.queries.GatewayCodingProjectIdentity(ctx, job.ProjectID)
	if err != nil {
		return err
	}
	ownerChanged := project.CodingProject.OwnerID != job.OwnerID ||
		project.CodingProject.WorkspaceID != job.WorkspaceID ||
		project.OrganizationID != job.OrganizationID
	if ownerChanged {
		return errors.New("project ownership changed")
	}
	access, err := s.codingWorkerAccess(ctx, project, input.AgentName)
	if err != nil {
		return err
	}
	row, err := s.queries.GatewayGetCodingThread(
		ctx,
		gatewaydb.GatewayGetCodingThreadParams{
			WorkspaceID: job.WorkspaceID,
			AgentName:   input.AgentName,
			SessionID:   pgtype.Text{String: input.SessionId, Valid: true},
		},
	)
	if err != nil {
		return err
	}
	checkoutChanged := row.CodingWorktree.ID != job.WorktreeID ||
		row.CodingProject.ID != job.ProjectID
	if checkoutChanged || row.CodingWorktree.Deleting || !row.CodingWorktree.Ready {
		return errors.New("conversation checkout changed or is unavailable")
	}
	local := func(request gatewayapi.CodingGitRequest) (gatewayapi.CodingGitResult, error) {
		if _, err := s.codingWorkerAccess(ctx, project, input.AgentName); err != nil {
			return gatewayapi.CodingGitResult{}, err
		}
		return s.codingFilesystem(ctx, access.namespace, row.CodingWorktree, row.CodingProject, false, request)
	}
	current, err := local(gatewayapi.CodingGitRequest{
		Operation:    gatewayapi.CodingGitStatus,
		ExpectedHead: &input.ExpectedHead,
	})
	if err != nil {
		return err
	}
	if current.Branch != input.Branch || current.Revision != input.Revision {
		return errors.New("checkout changed; refresh before retrying")
	}
	identity, err := s.codingIdentity(ctx, job.OwnerID)
	if err != nil {
		return err
	}
	repository, _, err := identity.client.Repositories.GetByID(ctx, row.CodingProject.RepositoryID)
	if err != nil {
		return errors.New("could not access the GitHub repository")
	}
	repo, err := newCodingRepository(ctx, repository.GetFullName(), identity.token)
	if err != nil {
		return err
	}
	defer os.RemoveAll(repo.dir)
	message := ""
	if input.Message != nil {
		message = strings.TrimSpace(*input.Message)
	}
	if input.FeatureBranch != nil && *input.FeatureBranch {
		if err := publish("Creating feature branch"); err != nil {
			return err
		}
		text := message
		if text == "" {
			text = "Changes on " + current.Branch
			for _, file := range current.Files {
				text += "\n" + file.Path
			}
		}
		suggestion, err := s.codingSuggestion(
			ctx,
			access,
			row.CodingWorktree,
			row.CodingProject,
			row.CodingThread.SessionID.String,
			gatewayapi.CodingTextRequest{Purpose: gatewayapi.CodingTextBranch, Text: &text},
		)
		if err != nil {
			return err
		}
		current, err = local(gatewayapi.CodingGitRequest{
			Operation:    gatewayapi.CodingGitCreateBranch,
			Ref:          &suggestion.Text,
			ExpectedHead: &current.Head,
		})
		if err != nil {
			return err
		}
		err = s.queries.GatewayUpdateCodingBranch(
			ctx,
			gatewaydb.GatewayUpdateCodingBranchParams{ID: job.WorktreeID, Branch: current.Branch},
		)
		if err != nil {
			return err
		}
	}
	if current.Branch == "" && input.Action != gatewayapi.CodingActionFetch {
		return errors.New("create a branch before committing or publishing")
	}
	if input.Action == gatewayapi.CodingActionFetch || input.Action == gatewayapi.CodingActionPull {
		if err := publish("Fetching remote branches"); err != nil {
			return err
		}
		bundle, err := repo.fetchBundle(ctx)
		if err != nil {
			return err
		}
		request := gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitImport, Bundle: &bundle}
		if input.Action == gatewayapi.CodingActionPull {
			request.ExpectedHead, request.Ref = &current.Head, &current.Branch
		}
		_, err = local(request)
		return err
	}
	commit := input.Action == gatewayapi.CodingActionCommit ||
		input.Action == gatewayapi.CodingActionCommitPush ||
		input.Action == gatewayapi.CodingActionCommitPushPR
	if commit && len(current.Files) > 0 {
		if err := publish("Preparing commit"); err != nil {
			return err
		}
		switch {
		case input.ExpectedTree == nil:
			current, err = local(gatewayapi.CodingGitRequest{
				Operation:    gatewayapi.CodingGitPrepareCommit,
				ExpectedHead: &current.Head,
				Revision:     &current.Revision,
				Paths:        input.Paths,
			})
			if err != nil {
				return err
			}
		case current.Tree == nil || *current.Tree != *input.ExpectedTree:
			return errors.New("staged changes changed; review before committing")
		}
		if current.Tree == nil {
			return errors.New("resolve conflicts before committing")
		}
		if message == "" {
			if err := publish("Generating commit message"); err != nil {
				return err
			}
			suggestion, err := s.codingSuggestion(
				ctx,
				access,
				row.CodingWorktree,
				row.CodingProject,
				row.CodingThread.SessionID.String,
				gatewayapi.CodingTextRequest{
					Purpose:      gatewayapi.CodingTextCommit,
					ExpectedTree: current.Tree,
				},
			)
			if err != nil {
				return err
			}
			message = suggestion.Text
		}
		if err := publish("Committing"); err != nil {
			return err
		}
		exported, err := local(gatewayapi.CodingGitRequest{
			Operation:    gatewayapi.CodingGitExport,
			ExpectedHead: &current.Head,
		})
		if err != nil {
			return err
		}
		sameTree := exported.Tree != nil && *exported.Tree == *current.Tree
		if exported.Bundle == nil || !sameTree || exported.Branch != current.Branch {
			return errors.New("checkout changed while preparing the commit")
		}
		if err := repo.importBundle(ctx, *exported.Bundle); err != nil {
			return err
		}
		tree, err := repo.run(ctx, false, "rev-parse", "refs/agentz/export^{tree}")
		if err != nil || tree != *current.Tree {
			return errors.New("exported tree does not match reviewed changes")
		}
		parent, err := repo.run(ctx, false, "rev-parse", "refs/agentz/export^")
		if err != nil || parent != current.Head {
			return errors.New("exported parent does not match reviewed HEAD")
		}
		committed, err := repo.run(ctx, false, "rev-parse", current.Head+"^{tree}")
		if err != nil {
			return err
		}
		if tree == committed {
			return errors.New("no staged changes to commit")
		}
		sha, err := repo.run(
			ctx,
			false,
			"-c",
			"user.name="+identity.name,
			"-c",
			"user.email="+identity.email,
			"-c",
			"commit.gpgSign=false",
			"commit-tree",
			tree,
			"-p",
			current.Head,
			"-m",
			message,
		)
		if err != nil {
			return err
		}
		_, err = repo.run(ctx, false, "update-ref", "refs/heads/"+current.Branch, sha, current.Head)
		if err != nil {
			return err
		}
		bundle, err := repo.exportBundle(ctx)
		if err != nil {
			return err
		}
		current, err = local(gatewayapi.CodingGitRequest{
			Operation:    gatewayapi.CodingGitApplyCommit,
			Bundle:       &bundle,
			ExpectedHead: &current.Head,
			ExpectedTree: current.Tree,
			Ref:          &current.Branch,
		})
		if err != nil {
			return err
		}
		result.Commit = &sha
		if err := publish("Committed"); err != nil {
			return err
		}
	}
	if input.Action == gatewayapi.CodingActionCommit {
		return nil
	}
	creatingPR := input.Action == gatewayapi.CodingActionCreatePR || input.Action == gatewayapi.CodingActionCommitPushPR
	if creatingPR && current.Branch == repository.GetDefaultBranch() {
		return errors.New("create a feature branch before opening a PR")
	}
	if creatingPR && len(current.Files) > 0 {
		return errors.New("commit changes before creating a PR")
	}
	if err := publish("Checking remote branch"); err != nil {
		return err
	}
	_, err = repo.run(
		ctx,
		true,
		"fetch",
		"--no-tags",
		repo.url,
		"+refs/heads/*:refs/remotes/origin/*",
	)
	if err != nil {
		return err
	}
	remote, err := repo.run(ctx, false, "rev-parse", "--verify", "refs/remotes/origin/"+current.Branch)
	if err != nil {
		remote = ""
	}
	if remote != current.RemoteHead {
		return errors.New("remote branch changed; fetch and review before publishing")
	}
	if remote != current.Head {
		if err := publish("Pushing"); err != nil {
			return err
		}
		exported, err := local(gatewayapi.CodingGitRequest{
			Operation:    gatewayapi.CodingGitExport,
			ExpectedHead: &current.Head,
		})
		if err != nil || exported.Bundle == nil || exported.Branch != current.Branch {
			return errors.New("checkout changed before pushing")
		}
		if err := repo.importBundle(ctx, *exported.Bundle); err != nil {
			return err
		}
		if remote != "" {
			_, err = repo.run(ctx, false, "merge-base", "--is-ancestor", remote, current.Head)
			if err != nil {
				return errors.New("remote branch diverged; reconcile before pushing")
			}
		}
		if _, err := s.codingWorkerAccess(ctx, project, input.AgentName); err != nil {
			return err
		}
		if _, err := s.queries.GatewayCodingConnection(ctx, job.OwnerID); err != nil {
			return errors.New("GitHub account disconnected")
		}
		_, err = repo.run(
			ctx,
			true,
			"push",
			repo.url,
			"--force-with-lease=refs/heads/"+current.Branch+":"+remote,
			current.Head+":refs/heads/"+current.Branch,
		)
		if err != nil {
			return errors.New("could not confirm push; refresh remote state before retrying")
		}
		result.Pushed = true
		if err := publish("Pushed"); err != nil {
			return err
		}
	}
	if !creatingPR {
		return nil
	}

	owner, name := repository.GetOwner().GetLogin(), repository.GetName()
	filter := &github.PullRequestListOptions{
		Head:        owner + ":" + current.Branch,
		State:       "open",
		ListOptions: github.ListOptions{PerPage: 1},
	}
	pulls, _, err := identity.client.PullRequests.List(ctx, owner, name, filter)
	if err != nil {
		return errors.New("could not look up the existing pull request")
	}
	if len(pulls) > 0 {
		result.PullRequest = &gatewayapi.CodingPullRequest{Number: pulls[0].GetNumber(), Url: pulls[0].GetHTMLURL()}
		return nil
	}
	if err := publish("Generating PR content"); err != nil {
		return err
	}
	exported, err := local(gatewayapi.CodingGitRequest{
		Operation:    gatewayapi.CodingGitExport,
		ExpectedHead: &current.Head,
	})
	if err != nil || exported.Bundle == nil || len(exported.Files) > 0 || exported.Branch != current.Branch {
		return errors.New("commit changes before creating a PR")
	}
	if err := repo.importBundle(ctx, *exported.Bundle); err != nil {
		return err
	}
	base := "refs/remotes/origin/" + repository.GetDefaultBranch()
	patch, err := repo.run(ctx, false, "diff", "--no-ext-diff", "--no-textconv", base+"..."+current.Head, "--")
	if err != nil || patch == "" {
		return errors.New("no changes against the default branch")
	}
	commits, err := repo.run(ctx, false, "log", "--format=%s", base+".."+current.Head, "--")
	if err != nil {
		return err
	}
	text := fmt.Sprintf(
		"Branch: %s\nBase: %s\nCommits:\n%s\nDiff:\n%s",
		current.Branch,
		repository.GetDefaultBranch(),
		commits[:min(len(commits), 6000)],
		patch[:min(len(patch), 40000)],
	)
	suggestion, err := s.codingSuggestion(
		ctx,
		access,
		row.CodingWorktree,
		row.CodingProject,
		row.CodingThread.SessionID.String,
		gatewayapi.CodingTextRequest{Purpose: gatewayapi.CodingTextPR, Text: &text},
	)
	if err != nil || suggestion.PullRequest == nil {
		return errors.New("could not generate PR content")
	}
	checked, err := local(gatewayapi.CodingGitRequest{
		Operation:    gatewayapi.CodingGitStatus,
		ExpectedHead: &current.Head,
	})
	if err != nil || checked.Branch != current.Branch || len(checked.Files) > 0 {
		return errors.New("checkout changed while generating PR content")
	}
	ref, _, err := identity.client.Git.GetRef(ctx, owner, name, "heads/"+current.Branch)
	if err != nil || ref.GetObject().GetSHA() != current.Head {
		return errors.New("remote branch changed while generating PR content")
	}
	if _, err := s.queries.GatewayCodingConnection(ctx, job.OwnerID); err != nil {
		return errors.New("GitHub account disconnected")
	}
	if err := publish("Creating pull request"); err != nil {
		return err
	}
	pr, _, err := identity.client.PullRequests.Create(
		ctx,
		owner,
		name,
		github.CreatePullRequest{
			Title: &suggestion.PullRequest.Title,
			Body:  &suggestion.PullRequest.Body,
			Head:  current.Branch,
			Base:  repository.GetDefaultBranch(),
		},
	)
	if err != nil {
		pulls, _, lookupErr := identity.client.PullRequests.List(ctx, owner, name, filter)
		if lookupErr != nil || len(pulls) == 0 {
			return errors.New("could not confirm PR creation; refresh before retrying")
		}
		pr = pulls[0]
	}
	result.PullRequest = &gatewayapi.CodingPullRequest{Number: pr.GetNumber(), Url: pr.GetHTMLURL()}
	return nil
}

// nameCodingBranch generates outside the project lock so the first agent turn
// can proceed. Only the original private temporary branch may be renamed.
func (s *Service) nameCodingBranch(ctx context.Context, job gatewaydb.CodingOperation, input gatewayapi.CodingOperationRequest, publish func(string) error) error {
	project, err := s.queries.GatewayCodingProjectIdentity(ctx, job.ProjectID)
	if err != nil {
		return err
	}
	access, err := s.codingWorkerAccess(ctx, project, input.AgentName)
	if err != nil {
		return err
	}
	row, err := s.queries.GatewayGetCodingThread(
		ctx,
		gatewaydb.GatewayGetCodingThreadParams{
			WorkspaceID: job.WorkspaceID,
			AgentName:   input.AgentName,
			SessionID:   pgtype.Text{String: input.SessionId, Valid: true},
		},
	)
	if err != nil {
		return err
	}
	checkoutChanged := row.CodingProject.OwnerID != job.OwnerID ||
		row.CodingProject.ID != job.ProjectID ||
		row.CodingWorktree.ID != job.WorktreeID
	if checkoutChanged {
		return errors.New("conversation checkout changed")
	}
	if row.CodingWorktree.Shared || row.CodingWorktree.Branch != "chore/"+job.WorktreeID {
		return nil
	}
	if err := publish("Naming branch"); err != nil {
		return err
	}
	suggestion, err := s.codingSuggestion(
		ctx,
		access,
		row.CodingWorktree,
		row.CodingProject,
		row.CodingThread.SessionID.String,
		gatewayapi.CodingTextRequest{
			Purpose: gatewayapi.CodingTextBranch,
			Text:    input.Text,
			Model:   input.Model,
		},
	)
	if err != nil {
		return err
	}
	q, release, err := lockGatewayResource(ctx, s.lockDB, job.ProjectID, false)
	if err != nil {
		return err
	}
	defer release()
	current, err := q.GatewayGetCodingWorktree(
		ctx,
		gatewaydb.GatewayGetCodingWorktreeParams{ID: job.WorktreeID, WorkspaceID: job.WorkspaceID},
	)
	if err != nil {
		return err
	}
	tree := current.CodingWorktree
	unavailable := tree.Shared || tree.Deleting || !tree.Ready
	if unavailable || tree.Branch != row.CodingWorktree.Branch {
		return errors.New("checkout changed while naming its branch")
	}
	if _, err := s.codingWorkerAccess(ctx, project, input.AgentName); err != nil {
		return err
	}
	renamed, err := s.codingFilesystem(
		ctx,
		access.namespace,
		current.CodingWorktree,
		current.CodingProject,
		false,
		gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRename, Ref: &suggestion.Text},
	)
	if err != nil {
		return err
	}
	return q.GatewayUpdateCodingBranch(
		ctx,
		gatewaydb.GatewayUpdateCodingBranchParams{ID: job.WorktreeID, Branch: renamed.Branch},
	)
}
