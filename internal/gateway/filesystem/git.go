package filesystem

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/bluekeyes/go-gitdiff/gitdiff"
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
	// Reads do not wait behind repository mutations or unrelated file writes.
	if req.Prepare || (req.Git.Operation != gatewayapi.CodingGitStatus && req.Git.Operation != gatewayapi.CodingGitDiff && req.Git.Operation != gatewayapi.CodingGitStashes) {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
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
	run := func(cwd, index string, args ...string) (string, error) {
		command := exec.CommandContext(ctx, "git", append([]string{
			"--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
			"-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
			"-c", "submodule.recurse=false", "-c", "diff.external=", "-c", "core.attributesFile=/dev/null",
			// Match Unicode paths in patch headers to porcelain status paths.
			"-c", "core.quotePath=false",
		}, args...)...)
		command.Dir = cwd
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_ATTR_NOSYSTEM=1", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0", "GIT_AUTHOR_NAME=AgentZ", "GIT_AUTHOR_EMAIL=stash@invalid", "GIT_COMMITTER_NAME=AgentZ", "GIT_COMMITTER_EMAIL=stash@invalid"}
		if index != "" {
			command.Env = append(command.Env, "GIT_INDEX_FILE="+index)
		}
		var stderr bytes.Buffer
		command.Stderr = &stderr
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
			var exit *exec.ExitError
			if !slices.Contains(args, "--no-index") || !errors.As(err, &exit) || exit.ExitCode() != 1 {
				detail := strings.TrimSpace(stderr.String())
				if detail == "" {
					detail = strings.TrimSpace(string(out))
				}
				return "", fmt.Errorf("git %s: %s: %w", args[0], detail[:min(len(detail), 4000)], err)
			}
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
		if _, err := run(cwd, "", "bundle", "verify", file.Name()); err != nil {
			return err
		}
		namespace := "refs/remotes/origin/"
		if req.Git.Operation == gatewayapi.CodingGitApplyCommit {
			namespace = "refs/agentz/incoming/"
		}
		_, err = run(cwd, "", "fetch", "--prune", "--no-tags", "--no-recurse-submodules", file.Name(), "+refs/heads/*:"+namespace+"*")
		return err
	}
	if req.Prepare {
		if _, err := run(root, "", "check-ref-format", "--branch", req.BaseBranch); err != nil {
			return result, errors.New("invalid base branch")
		}
		if _, err := os.Stat(filepath.Join(repo, ".git")); errors.Is(err, os.ErrNotExist) {
			if _, err := run(root, "", "init", "--initial-branch="+req.BaseBranch, repo); err != nil {
				return result, err
			}
		}
		if _, err := run(repo, "", "rev-parse", "HEAD"); err != nil {
			if err := importBundle(repo); err != nil {
				return result, err
			}
			if _, err := run(repo, "", "checkout", "-B", req.BaseBranch, "refs/remotes/origin/"+req.BaseBranch); err != nil {
				return result, err
			}
		}
		if directory != repo {
			if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
				if _, err := run(repo, "", "check-ref-format", "--branch", req.Branch); err != nil {
					return result, errors.New("invalid worktree branch")
				}
				if _, err := run(repo, "", "worktree", "add", "-b", req.Branch, directory, "refs/remotes/origin/"+req.BaseBranch); err != nil {
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
	paths := []string{}
	if req.Git.Paths != nil {
		paths = *req.Git.Paths
	}
	for _, name := range paths {
		if !filepath.IsLocal(name) || name == ".git" || strings.HasPrefix(name, ".git/") {
			return result, errors.New("invalid file path")
		}
	}
	if req.Git.Stash != nil {
		oid, err := hex.DecodeString(*req.Git.Stash)
		if err != nil || (len(oid) != 20 && len(oid) != 32) {
			return result, errors.New("invalid stash object")
		}
	}
	readStashes := func() ([]gatewayapi.CodingGitStash, error) {
		output, err := run(directory, "", "stash", "list", "--format=%gd%x00%H%x00%cI%x00%gs%x00")
		if err != nil {
			return nil, err
		}
		entries := strings.Split(output, "\x00")
		stashes := make([]gatewayapi.CodingGitStash, 0, len(entries)/4)
		for i := 0; i+3 < len(entries); i += 4 {
			created, err := time.Parse(time.RFC3339, entries[i+2])
			if err != nil {
				return nil, fmt.Errorf("read stash date: %w", err)
			}
			stashes = append(stashes, gatewayapi.CodingGitStash{Reference: strings.TrimSpace(entries[i]), Oid: entries[i+1], CreatedAt: created, Message: entries[i+3]})
		}
		return stashes, nil
	}

	readStatus := func() error {
		head, err := run(directory, "", "rev-parse", "--verify", "HEAD")
		if err != nil {
			if _, err := run(directory, "", "symbolic-ref", "HEAD"); err != nil {
				return err
			}
			head = ""
		}
		result.Head = strings.TrimSpace(head)
		branch, err := run(directory, "", "branch", "--show-current")
		if err != nil {
			return err
		}
		result.Branch = strings.TrimSpace(branch)
		status, err := run(directory, "", "status", "--porcelain=v1", "-z", "--untracked-files=all")
		if err != nil {
			return err
		}
		result.Files = []gatewayapi.CodingGitFile{}
		result.Tree = nil
		entries := strings.Split(strings.TrimSuffix(status, "\x00"), "\x00")
		digest := sha256.New()
		fmt.Fprint(digest, result.Head, "\x00", status)
		conflicts := false
		for i := 0; i < len(entries); i++ {
			entry := entries[i]
			if entry == "" {
				continue
			}
			if len(entry) < 4 {
				return errors.New("invalid Git status response")
			}
			file := gatewayapi.CodingGitFile{Path: entry[3:], Index: entry[:1], Worktree: entry[1:2]}
			file.Conflict = strings.Contains(entry[:2], "U") || entry[:2] == "AA" || entry[:2] == "DD"
			conflicts = conflicts || file.Conflict
			if file.Index == "R" || file.Index == "C" || file.Worktree == "R" || file.Worktree == "C" {
				i++
				if i >= len(entries) {
					return errors.New("invalid Git rename response")
				}
				file.PreviousPath = new(entries[i])
			}
			info, err := os.Lstat(filepath.Join(directory, file.Path))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if info != nil {
				fmt.Fprintf(digest, "%s\x00%d:%d:%d\x00", file.Path, info.Size(), info.ModTime().UnixNano(), info.Mode())
			}
			result.Files = append(result.Files, file)
		}
		if !conflicts {
			tree, err := run(directory, "", "write-tree")
			if err != nil {
				return err
			}
			result.Tree = new(strings.TrimSpace(tree))
			fmt.Fprint(digest, *result.Tree)
		}
		result.Revision = fmt.Sprintf("%x", digest.Sum(nil))
		return nil
	}
	if err := readStatus(); err != nil {
		return result, err
	}
	if req.Git.ExpectedHead != nil && *req.Git.ExpectedHead != result.Head {
		return result, errors.New("checkout changed; refresh before retrying")
	}
	comparison := gatewayapi.CodingGitUnstaged
	if req.Git.Comparison != nil {
		comparison = *req.Git.Comparison
	}
	// Git owns patch bodies. Reads parse only file headers; full hunk parsing is
	// reserved for mutations so reviewing large files does not build a second AST.
	readPatches := func() ([]gatewayapi.CodingGitPatch, error) {
		args := []string{"--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--diff-filter=ACDMRT"}
		if req.Git.Stash != nil {
			args = append(args, *req.Git.Stash+"^1", *req.Git.Stash)
		} else if comparison == gatewayapi.CodingGitStaged {
			args = append(args, "--cached")
		} else if comparison == gatewayapi.CodingGitAll {
			base := result.Head
			if base == "" {
				empty, err := run(directory, "", "hash-object", "-t", "tree", "/dev/null")
				if err != nil {
					return nil, err
				}
				base = strings.TrimSpace(empty)
			}
			args = append(args, base)
		}
		args = append(args, "--")
		if req.Git.Paths != nil {
			args = append(args, *req.Git.Paths...)
		}
		patch, err := run(directory, "", args...)
		if err != nil {
			return nil, err
		}
		chunks := []string{patch}
		if req.Git.Stash != nil {
			if _, err := run(directory, "", "rev-parse", "--verify", *req.Git.Stash+"^3"); err == nil {
				args := []string{"--literal-pathspecs", "diff-tree", "--root", "--no-commit-id", "-r", "-p", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", *req.Git.Stash + "^3", "--"}
				if req.Git.Paths != nil {
					args = append(args, *req.Git.Paths...)
				}
				patch, err := run(directory, "", args...)
				if err != nil {
					return nil, err
				}
				chunks = append(chunks, patch)
			}
		} else if comparison != gatewayapi.CodingGitStaged {
			var untracked []string
			for _, file := range result.Files {
				if file.Index != "?" || (req.Git.Paths != nil && !slices.Contains(*req.Git.Paths, file.Path)) {
					continue
				}
				untracked = append(untracked, file.Path)
			}
			if len(untracked) == 1 {
				patch, err := run(directory, "", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", untracked[0])
				if err != nil {
					return nil, err
				}
				chunks = append(chunks, patch)
			} else if len(untracked) > 1 {
				// Batch intent-to-add entries in an isolated index. The real index is
				// never changed, and Git still owns binary, symlink and path handling.
				tmp, err := os.MkdirTemp("", "agentz-review-*")
				if err != nil {
					return nil, err
				}
				defer os.RemoveAll(tmp)
				index := filepath.Join(tmp, "index")
				spec := filepath.Join(tmp, "paths")
				if err := os.WriteFile(spec, []byte(strings.Join(untracked, "\x00")+"\x00"), 0600); err != nil {
					return nil, err
				}
				if _, err := run(directory, index, "--literal-pathspecs", "add", "--intent-to-add", "--pathspec-from-file="+spec, "--pathspec-file-nul"); err != nil {
					return nil, err
				}
				patch, err := run(directory, index, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--src-prefix=a/", "--dst-prefix=b/")
				if err != nil {
					return nil, err
				}
				chunks = append(chunks, patch)
			}
		}
		patches := make([]gatewayapi.CodingGitPatch, 0, len(result.Files))
		// Reuse the parser's input buffer instead of allocating 4 KiB per file.
		headers := bufio.NewReader(strings.NewReader(""))
		size := 0
		for _, chunk := range chunks {
			size += len(chunk)
			if size > 64<<20 {
				return nil, errors.New("comparison exceeds 64 MiB")
			}
			for chunk != "" {
				// Git frames each file with an unprefixed diff header. Hunk contents
				// always carry a space, + or - prefix, including header-looking text.
				end := len(chunk)
				if next := strings.Index(chunk, "\ndiff --git "); next >= 0 {
					end = next + 1
				}
				patch := chunk[:end]
				chunk = chunk[end:]
				header, _, text := strings.Cut(patch, "\n@@ ")
				headers.Reset(strings.NewReader(header))
				files, _, err := gitdiff.Parse(headers)
				if err != nil {
					return nil, err
				}
				if len(files) != 1 {
					return nil, errors.New("invalid Git file header")
				}
				file := files[0]
				name := file.NewName
				if file.IsDelete {
					name = file.OldName
				}
				patches = append(patches, gatewayapi.CodingGitPatch{Path: name, Patch: patch, Revision: fmt.Sprintf("%x", sha256.Sum256([]byte(patch))), Binary: file.IsBinary, CanStageHunks: !file.IsBinary && !file.IsRename && !file.IsCopy && file.NewMode == 0 && !file.IsDelete && text})
			}
		}
		return patches, nil
	}
	switch req.Git.Operation {
	case gatewayapi.CodingGitStashes:
		stashes, err := readStashes()
		if err != nil {
			return result, err
		}
		result.Stashes = &stashes
		return result, nil
	case gatewayapi.CodingGitStashCreate:
		if req.Git.Revision == nil || *req.Git.Revision != result.Revision {
			return result, errors.New("checkout changed; review before stashing")
		}
		if result.Tree == nil {
			return result, errors.New("resolve conflicts before stashing")
		}
		args := []string{"stash", "push", "--quiet"}
		if comparison == gatewayapi.CodingGitAll {
			args = append(args, "--include-untracked")
		}
		if comparison == gatewayapi.CodingGitStaged {
			args = append(args, "--staged")
		}
		if req.Git.Message != nil {
			args = append(args, "--message", *req.Git.Message)
		}
		if _, err := run(directory, "", args...); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitStashApply, gatewayapi.CodingGitStashPop, gatewayapi.CodingGitStashDrop:
		if req.Git.Stash == nil {
			return result, errors.New("select a stash")
		}
		stashes, err := readStashes()
		if err != nil {
			return result, err
		}
		index := slices.IndexFunc(stashes, func(stash gatewayapi.CodingGitStash) bool { return stash.Oid == *req.Git.Stash })
		if index < 0 {
			return result, errors.New("stash changed; refresh before retrying")
		}
		selected := stashes[index]
		if req.Git.Operation != gatewayapi.CodingGitStashDrop {
			args := []string{"stash", "apply"}
			if req.Git.RestoreIndex != nil && *req.Git.RestoreIndex {
				args = append(args, "--index")
			}
			// Apply by immutable object identity. A conflict leaves the stash intact.
			if _, err := run(directory, "", append(args, selected.Oid)...); err != nil {
				return result, err
			}
		}
		if req.Git.Operation != gatewayapi.CodingGitStashApply {
			current, err := readStashes()
			if err != nil {
				return result, err
			}
			if !slices.Equal(stashes, current) {
				return result, errors.New("stash list changed; saved entry was kept, refresh before removing it")
			}
			if _, err := run(directory, "", "stash", "drop", selected.Reference); err != nil {
				return result, err
			}
		}
	case gatewayapi.CodingGitDiff:
		patches, err := readPatches()
		if err != nil {
			return result, err
		}
		result.Patches = &patches
		return result, nil
	case gatewayapi.CodingGitStage, gatewayapi.CodingGitUnstage:
		if len(paths) == 0 {
			return result, errors.New("select files first")
		}
		if req.Git.Hunk != nil {
			if len(paths) != 1 || req.Git.Revision == nil || *req.Git.Hunk < 0 {
				return result, errors.New("a reviewed file and hunk are required")
			}
			if (req.Git.Operation == gatewayapi.CodingGitStage && comparison != gatewayapi.CodingGitUnstaged) || (req.Git.Operation == gatewayapi.CodingGitUnstage && comparison != gatewayapi.CodingGitStaged) {
				return result, errors.New("select the staged or unstaged comparison first")
			}
			patches, err := readPatches()
			if err != nil {
				return result, err
			}
			if len(patches) != 1 || patches[0].Revision != *req.Git.Revision {
				return result, errors.New("file changed since review; refresh before staging")
			}
			if !patches[0].CanStageHunks {
				return result, errors.New("this change must be staged as a whole file")
			}
			files, _, err := gitdiff.Parse(strings.NewReader(patches[0].Patch))
			if err != nil {
				return result, err
			}
			if len(files) != 1 || *req.Git.Hunk >= len(files[0].TextFragments) {
				return result, errors.New("invalid Git hunk")
			}
			file := files[0]
			file.TextFragments = []*gitdiff.TextFragment{file.TextFragments[*req.Git.Hunk]}
			patch, err := os.CreateTemp("", "agentz-hunk-*.patch")
			if err != nil {
				return result, err
			}
			defer os.Remove(patch.Name())
			_, err = patch.WriteString(file.String())
			closeErr := patch.Close()
			if err != nil {
				return result, err
			}
			if closeErr != nil {
				return result, closeErr
			}
			args := []string{"apply", "--cached", "--whitespace=nowarn"}
			if req.Git.Operation == gatewayapi.CodingGitUnstage {
				args = append(args, "--reverse")
			}
			// Git applies the exact reviewed patch under its index lock. Failure leaves
			// the index unchanged; never use --reject or stage regenerated contents.
			if _, err := run(directory, "", append(args, "--", patch.Name())...); err != nil {
				return result, err
			}
		} else {
			if req.Git.Revision != nil && *req.Git.Revision != result.Revision {
				return result, errors.New("checkout changed since review; refresh before staging")
			}
			args := []string{"--literal-pathspecs", "add", "--"}
			if req.Git.Operation == gatewayapi.CodingGitUnstage {
				args = []string{"--literal-pathspecs", "reset", "HEAD", "--"}
				if result.Head == "" {
					args = []string{"--literal-pathspecs", "rm", "--cached", "--"}
				}
			}
			if _, err := run(directory, "", append(args, paths...)...); err != nil {
				return result, err
			}
		}
	case gatewayapi.CodingGitImport, gatewayapi.CodingGitApplyCommit:
		if err := importBundle(repo); err != nil {
			return result, err
		}
		if req.Git.Ref != nil {
			if _, err := run(directory, "", "check-ref-format", "--branch", *req.Git.Ref); err != nil {
				return result, errors.New("invalid branch")
			}
			if req.Git.Operation == gatewayapi.CodingGitApplyCommit {
				staged, err := run(directory, "", "write-tree")
				if err != nil {
					return result, err
				}
				if req.Git.ExpectedTree == nil || strings.TrimSpace(staged) != *req.Git.ExpectedTree {
					return result, errors.New("staged changes changed; review the diff again")
				}
				commitTree, err := run(directory, "", "rev-parse", "refs/agentz/incoming/"+*req.Git.Ref+"^{tree}")
				if err != nil {
					return result, err
				}
				parent, err := run(directory, "", "rev-parse", "refs/agentz/incoming/"+*req.Git.Ref+"^")
				if err != nil {
					return result, err
				}
				if strings.TrimSpace(commitTree) != *req.Git.ExpectedTree || strings.TrimSpace(parent) != result.Head {
					return result, errors.New("commit does not match the reviewed changes")
				}
				if _, err := run(directory, "", "reset", "--soft", "refs/agentz/incoming/"+*req.Git.Ref); err != nil {
					return result, err
				}
			} else if _, err := run(directory, "", "merge", "--ff-only", "refs/remotes/origin/"+*req.Git.Ref); err != nil {
				return result, err
			}
		}
	case gatewayapi.CodingGitRename:
		if req.Git.Ref == nil {
			return result, errors.New("branch is required")
		}
		if _, err := run(directory, "", "check-ref-format", "--branch", *req.Git.Ref); err != nil {
			return result, errors.New("invalid branch")
		}
		if result.Branch != req.Branch {
			return result, errors.New("branch changed; refresh before naming it")
		}
		if _, err := run(directory, "", "branch", "-m", *req.Git.Ref); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitCheckout:
		if req.Git.Ref == nil {
			return result, errors.New("branch is required")
		}
		if _, err := run(directory, "", "check-ref-format", "--branch", *req.Git.Ref); err != nil {
			return result, errors.New("invalid branch")
		}
		if len(result.Files) > 0 {
			return result, errors.New("commit or discard changes before switching branches")
		}
		if _, err := run(directory, "", "checkout", *req.Git.Ref); err != nil {
			return result, err
		}
	case gatewayapi.CodingGitRemove:
		if len(result.Files) > 0 {
			return result, errors.New("worktree has uncommitted changes")
		}
		unpushed, err := run(directory, "", "rev-list", "HEAD", "--not", "--remotes=origin")
		if err != nil {
			return result, err
		}
		if unpushed != "" {
			return result, errors.New("worktree has unpushed commits; push or explicitly resolve them first")
		}
		if directory == repo {
			stashes, err := readStashes()
			if err != nil {
				return result, err
			}
			if len(stashes) > 0 {
				return result, errors.New("repository has saved stashes; apply or drop them before removing it")
			}
			worktrees, err := run(repo, "", "worktree", "list", "--porcelain")
			if err != nil {
				return result, err
			}
			if strings.Count(worktrees, "worktree ") > 1 {
				return result, errors.New("remove linked worktrees before the main checkout")
			}
			unpushed, err := run(repo, "", "rev-list", "--branches", "--not", "--remotes=origin")
			if err != nil {
				return result, err
			}
			if unpushed != "" {
				return result, errors.New("repository has unpushed branches")
			}
			return result, s.root.RemoveAll(req.Root)
		}
		if _, err := run(repo, "", "worktree", "remove", directory); err != nil {
			return result, err
		}
		if result.Branch != "" {
			if _, err := run(repo, "", "branch", "-D", result.Branch); err != nil {
				return result, err
			}
		}
		return result, nil
	case gatewayapi.CodingGitStatus, gatewayapi.CodingGitExport:
	default:
		return result, errors.New("unsupported local Git operation")
	}
	if req.Git.Operation != gatewayapi.CodingGitStatus && req.Git.Operation != gatewayapi.CodingGitExport {
		if err := readStatus(); err != nil {
			return result, err
		}
	}
	branches, err := run(directory, "", "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return result, err
	}
	result.Branches = strings.Fields(branches)
	if req.Git.Operation == gatewayapi.CodingGitExport {
		if result.Tree == nil || result.Head == "" {
			return result, errors.New("resolve conflicts and create a commit before exporting")
		}
		file, err := os.CreateTemp("", "agentz-export-*.bundle")
		if err != nil {
			return result, err
		}
		file.Close()
		os.Remove(file.Name())
		defer os.Remove(file.Name())
		// Export the staged tree through an unsigned transport commit. The trusted
		// worker constructs the actual user commit after reviewing this tree.
		commit, err := run(directory, "", "-c", "commit.gpgSign=false", "commit-tree", *result.Tree, "-p", result.Head, "-m", "Staged tree transport")
		if err != nil {
			return result, errors.New("could not export staged tree")
		}
		transportRef := "refs/agentz/export"
		if _, err := run(directory, "", "update-ref", transportRef, strings.TrimSpace(commit)); err != nil {
			return result, err
		}
		defer run(directory, "", "update-ref", "-d", transportRef)
		if _, err := run(directory, "", "bundle", "create", file.Name(), "--branches", transportRef); err != nil {
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
