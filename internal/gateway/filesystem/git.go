package filesystem

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// GitRequest is the gateway-to-filesystem protocol. It never carries credentials.
type GitRequest struct {
	Root       string                      `json:"root"`
	Directory  string                      `json:"directory"`
	Branch     string                      `json:"branch"`
	BaseBranch string                      `json:"base_branch"`
	Prepare    bool                        `json:"prepare"`
	Git        gatewayapi.CodingGitRequest `json:"git"`
}

// git handles only local repository operations. Authenticated transport belongs
// to the web worker, which has no access to this process or its filesystem.
func (s *service) git(w http.ResponseWriter, r *http.Request) {
	var req GitRequest
	r.Body = http.MaxBytesReader(w, r.Body, 90<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeFailure(w, r, badRequest("invalid Git request", err))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	result, err := s.runGit(ctx, req)
	if err != nil {
		writeFailure(w, r, &failure{status: http.StatusConflict, code: "git_conflict", message: err.Error(), cause: err})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *service) runGit(ctx context.Context, req GitRequest) (gatewayapi.CodingGitResult, error) {
	result := gatewayapi.CodingGitResult{Branches: []string{}, Files: []gatewayapi.CodingGitFile{}}
	for _, name := range []string{req.Root, req.Directory} {
		if !filepath.IsLocal(name) || !strings.HasPrefix(name, "Projects/") {
			return result, errors.New("git directory must be a managed project path")
		}
	}
	if req.Directory != req.Root+"/repo" && !strings.HasPrefix(req.Directory, req.Root+"/worktrees/") {
		return result, errors.New("worktree does not belong to project")
	}
	if req.Git.Operation == gatewayapi.CodingGitRemove {
		if _, err := s.root.Lstat(req.Directory); errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
	}
	if err := s.root.MkdirAll(req.Root, 0o700); err != nil {
		return result, err
	}
	root, err := filepath.EvalSymlinks(filepath.Join(s.root.Name(), req.Root))
	if err != nil {
		return result, err
	}
	home, err := filepath.EvalSymlinks(s.root.Name())
	if err != nil {
		return result, err
	}
	rel, err := filepath.Rel(home, root)
	if err != nil || !filepath.IsLocal(rel) {
		return result, errors.New("project escapes agent home")
	}
	repo := filepath.Join(root, "repo")
	directory := filepath.Join(home, req.Directory)
	run := func(cwd string, args ...string) (string, error) {
		command := exec.CommandContext(ctx, "git", append([]string{
			"--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
			"-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
			"-c", "submodule.recurse=false", "-c", "diff.external=", "-c", "core.attributesFile=/dev/null",
			// Match Unicode paths in patch headers to porcelain status paths.
			"-c", "core.quotePath=false",
		}, args...)...)
		command.Dir = cwd
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_ATTR_NOSYSTEM=1", "LC_ALL=C"}
		stdout, err := command.StdoutPipe()
		if err != nil {
			return "", err
		}
		if err := command.Start(); err != nil {
			return "", err
		}
		out, readErr := io.ReadAll(io.LimitReader(stdout, (64<<20)+1))
		if readErr != nil || len(out) > 64<<20 {
			command.Process.Kill()
		}
		err = command.Wait()
		if readErr != nil {
			return "", readErr
		}
		if len(out) > 64<<20 {
			return "", errors.New("git result exceeds 64 MiB")
		}
		if err != nil {
			return "", fmt.Errorf("git %s failed: %w", args[0], err)
		}
		return string(out), nil
	}
	importBundle := func(cwd string) error {
		if req.Git.Bundle == nil || len(*req.Git.Bundle) == 0 {
			return errors.New("repository bundle is required")
		}
		file, err := os.CreateTemp("", "agentz-import-*.bundle")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err := file.Write(*req.Git.Bundle); err != nil {
			file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		if _, err := run(cwd, "bundle", "verify", file.Name()); err != nil {
			return err
		}
		namespace := "refs/remotes/origin/"
		if req.Git.Operation == gatewayapi.CodingGitApplyCommit {
			namespace = "refs/agentz/incoming/"
		}
		_, err = run(cwd, "fetch", "--no-tags", "--no-recurse-submodules", file.Name(), "+refs/heads/*:"+namespace+"*")
		return err
	}
	if req.Prepare {
		if _, err := run(root, "check-ref-format", "--branch", req.BaseBranch); err != nil {
			return result, errors.New("invalid base branch")
		}
		if _, err := os.Stat(filepath.Join(repo, ".git")); errors.Is(err, os.ErrNotExist) {
			if _, err := run(root, "init", "--initial-branch="+req.BaseBranch, repo); err != nil {
				return result, err
			}
		}
		if _, err := run(repo, "rev-parse", "HEAD"); err != nil {
			if err := importBundle(repo); err != nil {
				return result, err
			}
			if _, err := run(repo, "checkout", "-B", req.BaseBranch, "refs/remotes/origin/"+req.BaseBranch); err != nil {
				return result, err
			}
		}
		if directory != repo {
			if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
				if _, err := run(repo, "check-ref-format", "--branch", req.Branch); err != nil {
					return result, errors.New("invalid worktree branch")
				}
				if _, err := run(repo, "worktree", "add", "-b", req.Branch, directory, "refs/remotes/origin/"+req.BaseBranch); err != nil {
					return result, err
				}
			}
		}
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return result, err
	}
	rel, err = filepath.Rel(root, resolved)
	if err != nil || !filepath.IsLocal(rel) {
		return result, errors.New("worktree escapes project")
	}
	directory = resolved
	head, err := run(directory, "rev-parse", "HEAD")
	if err != nil {
		return result, err
	}
	result.Head = strings.TrimSpace(head)
	if req.Git.ExpectedHead != nil && *req.Git.ExpectedHead != result.Head {
		return result, errors.New("checkout changed; refresh before retrying")
	}
	switch req.Git.Operation {
	case gatewayapi.CodingGitStage, gatewayapi.CodingGitUnstage:
		if req.Git.Paths == nil || len(*req.Git.Paths) == 0 {
			return result, errors.New("select files first")
		}
		for _, name := range *req.Git.Paths {
			if !filepath.IsLocal(name) || name == ".git" || strings.HasPrefix(name, ".git/") {
				return result, errors.New("invalid file path")
			}
		}
		args := []string{"--literal-pathspecs", "add", "--"}
		if req.Git.Operation == gatewayapi.CodingGitUnstage {
			args = []string{"--literal-pathspecs", "reset", "HEAD", "--"}
		}
		if _, err := run(directory, append(args, *req.Git.Paths...)...); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitImport, gatewayapi.CodingGitApplyCommit:
		if err := importBundle(repo); err != nil {
			return result, err
		}
		if req.Git.Ref != nil {
			if _, err := run(directory, "check-ref-format", "--branch", *req.Git.Ref); err != nil {
				return result, errors.New("invalid branch")
			}
			if req.Git.Operation == gatewayapi.CodingGitApplyCommit {
				staged, err := run(directory, "write-tree")
				if err != nil {
					return result, err
				}
				if req.Git.ExpectedTree == nil || strings.TrimSpace(staged) != *req.Git.ExpectedTree {
					return result, errors.New("staged changes changed; review the diff again")
				}
				commitTree, err := run(directory, "rev-parse", "refs/agentz/incoming/"+*req.Git.Ref+"^{tree}")
				if err != nil {
					return result, err
				}
				parent, err := run(directory, "rev-parse", "refs/agentz/incoming/"+*req.Git.Ref+"^")
				if err != nil {
					return result, err
				}
				if strings.TrimSpace(commitTree) != *req.Git.ExpectedTree || strings.TrimSpace(parent) != result.Head {
					return result, errors.New("commit does not match the reviewed changes")
				}
				if _, err := run(directory, "reset", "--soft", "refs/agentz/incoming/"+*req.Git.Ref); err != nil {
					return result, err
				}
			} else if _, err := run(directory, "merge", "--ff-only", "refs/remotes/origin/"+*req.Git.Ref); err != nil {
				return result, err
			}
		}
	case gatewayapi.CodingGitRename:
		if req.Git.Ref == nil {
			return result, errors.New("branch is required")
		}
		if _, err := run(directory, "check-ref-format", "--branch", *req.Git.Ref); err != nil {
			return result, errors.New("invalid branch")
		}
		branch, err := run(directory, "branch", "--show-current")
		if err != nil {
			return result, err
		}
		if strings.TrimSpace(branch) != req.Branch {
			return result, errors.New("branch changed; refresh before naming it")
		}
		if _, err := run(directory, "branch", "-m", *req.Git.Ref); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitCheckout:
		if req.Git.Ref == nil {
			return result, errors.New("branch is required")
		}
		if _, err := run(directory, "check-ref-format", "--branch", *req.Git.Ref); err != nil {
			return result, errors.New("invalid branch")
		}
		status, err := run(directory, "status", "--porcelain=v1")
		if err != nil {
			return result, err
		}
		if status != "" {
			return result, errors.New("commit or discard changes before switching branches")
		}
		if _, err := run(directory, "checkout", *req.Git.Ref); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitRemove:
		status, err := run(directory, "status", "--porcelain=v1", "--untracked-files=all")
		if err != nil {
			return result, err
		}
		if status != "" {
			return result, errors.New("worktree has uncommitted changes")
		}
		unpushed, err := run(directory, "rev-list", "HEAD", "--not", "--remotes=origin")
		if err != nil {
			return result, err
		}
		if unpushed != "" {
			return result, errors.New("worktree has unpushed commits; push or explicitly resolve them first")
		}
		if directory == repo {
			worktrees, err := run(repo, "worktree", "list", "--porcelain")
			if err != nil {
				return result, err
			}
			if strings.Count(worktrees, "worktree ") > 1 {
				return result, errors.New("remove linked worktrees before the main checkout")
			}
			unpushed, err := run(repo, "rev-list", "--branches", "--not", "--remotes=origin")
			if err != nil {
				return result, err
			}
			if unpushed != "" {
				return result, errors.New("repository has unpushed branches")
			}
			return result, s.root.RemoveAll(req.Root)
		}
		branch, err := run(directory, "branch", "--show-current")
		if err != nil {
			return result, err
		}
		if _, err := run(repo, "worktree", "remove", directory); err != nil {
			return result, err
		}
		if branch = strings.TrimSpace(branch); branch != "" {
			if _, err := run(repo, "branch", "-D", branch); err != nil {
				return result, err
			}
		}
		return result, nil
	case gatewayapi.CodingGitStatus, gatewayapi.CodingGitDiff, gatewayapi.CodingGitExport:
	default:
		return result, errors.New("unsupported local Git operation")
	}
	head, err = run(directory, "rev-parse", "HEAD")
	if err != nil {
		return result, err
	}
	result.Head = strings.TrimSpace(head)
	branch, err := run(directory, "branch", "--show-current")
	if err != nil {
		return result, err
	}
	result.Branch = strings.TrimSpace(branch)
	status, err := run(directory, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return result, err
	}
	entries := strings.Split(strings.TrimSuffix(status, "\x00"), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if entry == "" {
			continue
		}
		if len(entry) < 4 {
			return result, errors.New("invalid Git status response")
		}
		file := gatewayapi.CodingGitFile{Path: entry[3:], Index: entry[:1], Worktree: entry[1:2]}
		if file.Index == "R" || file.Index == "C" || file.Worktree == "R" || file.Worktree == "C" {
			i++
			if i >= len(entries) {
				return result, errors.New("invalid Git rename response")
			}
			file.PreviousPath = new(entries[i])
		}
		result.Files = append(result.Files, file)
	}
	if result.Diff, err = run(directory, "diff", "--no-ext-diff", "--no-textconv"); err != nil {
		return result, err
	}
	if result.StagedDiff, err = run(directory, "diff", "--cached", "--no-ext-diff", "--no-textconv"); err != nil {
		return result, err
	}
	branches, err := run(directory, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return result, err
	}
	result.Branches = strings.Fields(branches)
	tree, err := run(directory, "write-tree")
	if err != nil {
		return result, err
	}
	result.Tree = new(strings.TrimSpace(tree))
	if req.Git.Operation == gatewayapi.CodingGitExport {
		file, err := os.CreateTemp("", "agentz-export-*.bundle")
		if err != nil {
			return result, err
		}
		file.Close()
		os.Remove(file.Name())
		defer os.Remove(file.Name())
		// Export the staged tree through an unsigned transport commit. The trusted
		// worker constructs the actual user commit after reviewing this tree.
		command := exec.CommandContext(ctx, "git", "-c", "user.name=AgentZ transport", "-c", "user.email=transport@invalid", "commit-tree", *result.Tree, "-p", result.Head, "-m", "Staged tree transport")
		command.Dir = directory
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		commit, err := command.Output()
		if err != nil {
			return result, errors.New("could not export staged tree")
		}
		transportRef := "refs/agentz/export"
		if _, err := run(directory, "update-ref", transportRef, strings.TrimSpace(string(commit))); err != nil {
			return result, err
		}
		defer run(directory, "update-ref", "-d", transportRef)
		if _, err := run(directory, "bundle", "create", file.Name(), "--branches", transportRef); err != nil {
			return result, err
		}
		bundle, err := os.ReadFile(file.Name())
		if err != nil {
			return result, err
		}
		if len(bundle) > 64<<20 {
			return result, errors.New("repository bundle exceeds 64 MiB")
		}
		result.Bundle = &bundle
	}
	return result, nil
}
