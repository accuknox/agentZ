package filesystem

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestGitWorktreeLifecycle(t *testing.T) {
	ctx := t.Context()
	home := t.TempDir()
	origin := t.TempDir()
	git := func(cwd string, args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = cwd
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
		return strings.TrimSpace(string(output))
	}
	git(origin, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(origin, "café.md"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(origin, "add", ".")
	git(origin, "commit", "-m", "Initial")
	bundlePath := filepath.Join(t.TempDir(), "repo.bundle")
	git(origin, "bundle", "create", bundlePath, "--branches")
	bundle, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	service := &service{root: root}
	req := GitRequest{Root: "Projects/user/github/project", Directory: "Projects/user/github/project/worktrees/thread", Branch: "chore/thread", BaseBranch: "main", Prepare: true, Git: gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus, Bundle: &bundle}}
	run := func(req GitRequest) gatewayapi.CodingGitResult {
		t.Helper()
		r, e := service.runGit(ctx, req)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	result := run(req)
	if result.Branch != req.Branch || len(result.Files) != 0 {
		t.Fatalf("unexpected initial checkout: %+v", result)
	}
	req.Prepare = false
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRename, Ref: new("docs/update-guide"), ExpectedHead: &result.Head}
	result = run(req)
	if result.Branch != "docs/update-guide" {
		t.Fatalf("branch did not rename: %s", result.Branch)
	}
	req.Branch = result.Branch
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus}
	directory := filepath.Join(home, req.Directory)
	if err := os.WriteFile(filepath.Join(directory, "café.md"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "space and\nnewline.txt"), []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result = run(req)
	if len(result.Files) != 2 {
		t.Fatalf("want two changes: %+v", result.Files)
	}
	// Multiple untracked files use an isolated index. Keep literal paths,
	// symlinks and patch-looking file contents intact without staging anything.
	fixtures := map[string]string{
		"binary":            "a\x00b",
		"empty":             "",
		"looks-like-header": "diff --git a/fake b/fake\n@@ -1 +1 @@\n--- old\n+++ new\n",
	}
	for name, content := range fixtures {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("space and\nnewline.txt", filepath.Join(directory, "link")); err != nil {
		t.Fatal(err)
	}
	index := git(directory, "rev-parse", "--git-path", "index")
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Comparison: new(gatewayapi.CodingGitAll)}
	review := run(req)
	if review.Patches == nil || len(*review.Patches) != 6 {
		t.Fatalf("lost files or split on patch-looking contents: %+v", review.Patches)
	}
	for _, patch := range *review.Patches {
		if patch.Path == "binary" && !patch.Binary {
			t.Fatal("binary metadata missing")
		}
		if patch.Path == "looks-like-header" && !strings.Contains(patch.Patch, "+diff --git a/fake b/fake") {
			t.Fatal("rewrote patch-looking file contents")
		}
	}
	after, err := os.ReadFile(index)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("review changed the real index", err)
	}
	for _, name := range []string{"binary", "empty", "looks-like-header", "link"} {
		if err := os.Remove(filepath.Join(directory, name)); err != nil {
			t.Fatal(err)
		}
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStage, Paths: new([]string{"café.md", "space and\nnewline.txt"}), ExpectedHead: &result.Head}
	result = run(req)
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Comparison: new(gatewayapi.CodingGitStaged)}
	result = run(req)
	if result.Patches == nil || len(*result.Patches) != 2 || (*result.Patches)[0].Path != "café.md" || result.Tree == nil {
		t.Fatal("staged review missing")
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitExport, ExpectedHead: &result.Head}
	exported := run(req)
	if exported.Bundle == nil || len(*exported.Bundle) == 0 {
		t.Fatal("missing bundle")
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRemove}
	if _, err := service.runGit(ctx, req); err == nil {
		t.Fatal("removed dirty worktree")
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitCheckout, Ref: new("main")}
	if _, err := service.runGit(ctx, req); err == nil {
		t.Fatal("switched dirty worktree")
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus, ExpectedHead: new(strings.Repeat("0", 40))}
	if _, err := service.runGit(ctx, req); err == nil {
		t.Fatal("accepted stale head")
	}
	git(directory, "reset", "--hard", "HEAD")
	git(directory, "clean", "-fd")
	git(directory, "branch", "switched")
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitCheckout, Ref: new("switched")}
	if result := run(req); result.Branch != "switched" {
		t.Fatalf("branch did not switch: %s", result.Branch)
	}
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRemove}
	run(req)
	branches := git(filepath.Join(home, req.Root, "repo"), "branch", "--list", "switched")
	if branches != "" {
		t.Fatal("cleanup left the branch currently checked out")
	}
	req.Directory = req.Root + "/repo"
	repo := filepath.Join(home, req.Directory)
	git(repo, "update-ref", "refs/remotes/origin/stale", result.Head)
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitImport, Bundle: &bundle}
	run(req)
	if git(repo, "for-each-ref", "refs/remotes/origin/stale") != "" {
		t.Fatal("import kept a deleted remote branch")
	}
	if err := os.WriteFile(filepath.Join(repo, "café.md"), []byte("saved\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(repo, "stash", "push", "-m", "Keep this work")
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitRemove}
	if _, err := service.runGit(ctx, req); err == nil || !strings.Contains(err.Error(), "stashes") {
		t.Fatalf("cleanup did not protect saved work: %v", err)
	}
	if git(repo, "stash", "show", "-p") == "" {
		t.Fatal("cleanup changed the saved stash")
	}
	git(repo, "stash", "drop")
	run(req)
	if _, err := os.Stat(filepath.Join(home, req.Root)); !os.IsNotExist(err) {
		t.Fatalf("project not cleaned up: %v", err)
	}
}

func TestGitReviewHunksAndStashes(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Projects/review/repo")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(t.Context(), "git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	base := "first\n" + strings.Repeat("unchanged\n", 30) + "last\n"
	write("café.txt", base)
	git("add", ".")
	git("commit", "-m", "Initial")
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	s := &service{root: root}
	req := GitRequest{Root: "Projects/review", Directory: "Projects/review/repo"}
	run := func(body gatewayapi.CodingGitRequest) gatewayapi.CodingGitResult {
		t.Helper()
		req.Git = body
		result, err := s.runGit(t.Context(), req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	write("café.txt", strings.ReplaceAll(strings.ReplaceAll(base, "first", "FIRST"), "last", "LAST"))
	status := run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus})
	if status.Patches != nil {
		t.Fatal("status loaded patch content")
	}
	review := run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Comparison: new(gatewayapi.CodingGitUnstaged)})
	patch := (*review.Patches)[0]
	if !patch.CanStageHunks || patch.Path != "café.txt" {
		t.Fatalf("ordinary modification cannot stage hunks: %+v", patch)
	}
	stage := gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStage, Comparison: new(gatewayapi.CodingGitUnstaged), Paths: new([]string{patch.Path}), Hunk: new(0), Revision: &patch.Revision}
	run(stage)
	if cached := git("diff", "--cached"); !strings.Contains(cached, "+FIRST") || strings.Contains(cached, "+LAST") {
		t.Fatalf("staged unrelated hunk: %s", cached)
	}
	req.Git = stage
	if _, err := s.runGit(t.Context(), req); err == nil {
		t.Fatal("accepted stale patch")
	}
	review = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Comparison: new(gatewayapi.CodingGitStaged)})
	patch = (*review.Patches)[0]
	run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitUnstage, Comparison: new(gatewayapi.CodingGitStaged), Paths: new([]string{patch.Path}), Hunk: new(0), Revision: &patch.Revision})
	if git("diff", "--cached") != "" || !strings.Contains(git("diff"), "+LAST") {
		t.Fatal("unstage did not preserve the worktree")
	}
	name := "space and\n雪.txt"
	write(name, "untracked\n")
	status = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus})
	run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashCreate, Comparison: new(gatewayapi.CodingGitAll), Revision: &status.Revision, Message: new("Saved review")})
	stashes := run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashes})
	if len(stashes.Files) != 0 || stashes.Stashes == nil || len(*stashes.Stashes) != 1 {
		t.Fatalf("stash did not save all changes: %+v", stashes)
	}
	oid := (*stashes.Stashes)[0].Oid
	review = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff, Stash: &oid})
	if review.Patches == nil || len(*review.Patches) != 2 || (*review.Patches)[1].Path != name {
		t.Fatal("stash review omitted untracked third-parent content")
	}
	// A new commit conflicts with the saved first hunk. Pop must keep the stash,
	// and unmerged index entries must not make status unavailable.
	write("café.txt", strings.ReplaceAll(base, "first", "COMPETING"))
	git("add", ".")
	git("commit", "-m", "Competing edit")
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashPop, Stash: &oid}
	if _, err := s.runGit(t.Context(), req); err == nil || !strings.Contains(err.Error(), "CONFLICT") {
		t.Fatalf("missing stash conflict details: %v", err)
	}
	status = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus})
	if status.Tree != nil || !status.Files[0].Conflict {
		t.Fatalf("unmerged index not represented: %+v", status)
	}
	stashes = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashes})
	if len(*stashes.Stashes) != 1 || (*stashes.Stashes)[0].Oid != oid {
		t.Fatal("conflicting pop removed the saved entry")
	}
	write("café.txt", strings.ReplaceAll(base, "first", "RESOLVED"))
	status = run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus})
	status = run(gatewayapi.CodingGitRequest{
		Operation: gatewayapi.CodingGitStage,
		Paths:     new([]string{"café.txt"}), Revision: &status.Revision,
	})
	if status.Tree == nil || strings.Contains(git("ls-files", "--unmerged"), "café.txt") {
		t.Fatal("staging did not mark the edited conflict resolved")
	}
	if !strings.Contains(git("diff", "--cached"), "+RESOLVED") {
		t.Fatal("staging did not preserve the conflict resolution")
	}
	run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashDrop, Stash: &oid})
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashApply, Stash: &oid}
	if _, err := s.runGit(t.Context(), req); err == nil {
		t.Fatal("accepted removed stash identity")
	}
}

type gitReviewFixture struct {
	name    string
	files   int
	lines   int
	tracked bool
	sparse  bool
	status  bool
}

// BenchmarkGitReview includes Git execution, canonical patches and HTTP JSON.
// Fixture creation and the first filesystem-cache warmup are outside the timer.
func BenchmarkGitReview(b *testing.B) {
	for _, fixture := range []gitReviewFixture{
		{name: "status_1000_untracked", files: 1000, lines: 1, status: true},
		{name: "untracked_1", files: 1, lines: 1},
		{name: "untracked_100", files: 100, lines: 1},
		{name: "untracked_1000", files: 1000, lines: 1},
		{name: "tracked_1000", files: 1000, lines: 1, tracked: true},
		{name: "added_100k", files: 1, lines: 100000},
		{name: "replaced_100k", files: 1, lines: 100000, tracked: true},
		{name: "sparse_100k", files: 1, lines: 100000, tracked: true, sparse: true},
	} {
		b.Run(fixture.name, func(b *testing.B) {
			home := b.TempDir()
			dir := filepath.Join(home, "Projects/benchmark/repo")
			if err := os.MkdirAll(dir, 0700); err != nil {
				b.Fatal(err)
			}
			git := func(args ...string) {
				b.Helper()
				cmd := exec.CommandContext(b.Context(), "git", args...)
				cmd.Dir = dir
				cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Benchmark", "GIT_AUTHOR_EMAIL=benchmark@example.invalid", "GIT_COMMITTER_NAME=Benchmark", "GIT_COMMITTER_EMAIL=benchmark@example.invalid")
				if out, err := cmd.CombinedOutput(); err != nil {
					b.Fatalf("git %v: %v: %s", args, err, out)
				}
			}
			write := func(content string) {
				b.Helper()
				for i := range fixture.files {
					name := filepath.Join(dir, fmt.Sprintf("file-%04d.txt", i))
					if err := os.WriteFile(name, []byte(content), 0600); err != nil {
						b.Fatal(err)
					}
				}
			}
			git("init", "-b", "main")
			git("commit", "--allow-empty", "-m", "Baseline")
			var content strings.Builder
			for i := range fixture.lines {
				fmt.Fprintf(&content, "line %06d: baseline text\n", i+1)
			}
			write(content.String())
			if fixture.tracked {
				git("add", ".")
				git("commit", "-m", "Tracked baseline")
				changed := strings.ReplaceAll(content.String(), "baseline", "modified")
				if fixture.sparse {
					changed = strings.ReplaceAll(content.String(), "line 000005", "line early edit")
					changed = strings.ReplaceAll(changed, "line 099990", "line late edit")
				}
				write(changed)
			}
			root, err := os.OpenRoot(home)
			if err != nil {
				b.Fatal(err)
			}
			defer root.Close()
			s := &service{root: root}
			op := gatewayapi.CodingGitDiff
			if fixture.status {
				op = gatewayapi.CodingGitStatus
			}
			body, err := json.Marshal(GitRequest{Root: "Projects/benchmark", Directory: "Projects/benchmark/repo", Git: gatewayapi.CodingGitRequest{Operation: op, Comparison: new(gatewayapi.CodingGitAll)}})
			if err != nil {
				b.Fatal(err)
			}
			warm := httptest.NewRecorder()
			s.git(warm, httptest.NewRequestWithContext(b.Context(), http.MethodPost, "/git", bytes.NewReader(body)))
			if warm.Code != http.StatusOK {
				b.Fatal(warm.Body.String())
			}
			var result gatewayapi.CodingGitResult
			if err := json.Unmarshal(warm.Body.Bytes(), &result); err != nil {
				b.Fatal(err)
			}
			if len(result.Files) != fixture.files || (!fixture.status && (result.Patches == nil || len(*result.Patches) != fixture.files)) {
				b.Fatal("incomplete fixture comparison")
			}
			if fixture.lines == 100000 && !fixture.sparse && !strings.Contains(warm.Body.String(), "line 100000") {
				b.Fatal("comparison truncated the final line")
			}
			size := warm.Body.Len()
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				response := httptest.NewRecorder()
				s.git(response, httptest.NewRequestWithContext(b.Context(), http.MethodPost, "/git", bytes.NewReader(body)))
				if response.Code != http.StatusOK || response.Body.Len() != size {
					b.Fatal("comparison changed or failed during benchmark")
				}
			}
		})
	}
}
