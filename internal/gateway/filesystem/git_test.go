package filesystem

import (
	"context"
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
	run(req) // interrupted provisioning retries must not reset existing work
	req.Prepare = false
	req.Git.Bundle = nil
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
	for _, name := range []string{"../outside", ".git/config", "/etc/passwd"} {
		req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStage, Paths: new([]string{name})}
		if _, err := service.runGit(ctx, req); err == nil {
			t.Errorf("accepted path %q", name)
		}
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
	run(req)
	if _, err := os.Stat(filepath.Join(home, req.Root)); !os.IsNotExist(err) {
		t.Fatalf("project not cleaned up: %v", err)
	}
}

func TestGitRejectsEscapingDirectories(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	service := &service{root: root}
	for _, directory := range []string{"/tmp/repo", "../repo", "Projects/project/../../outside", "Projects/other/repo"} {
		_, err := service.runGit(context.Background(), GitRequest{Root: "Projects/project", Directory: directory, Git: gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStatus}})
		if err == nil {
			t.Errorf("accepted escaping directory %q", directory)
		}
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
	run(gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashDrop, Stash: &oid})
	req.Git = gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitStashApply, Stash: &oid}
	if _, err := s.runGit(t.Context(), req); err == nil {
		t.Fatal("accepted removed stash identity")
	}
}
