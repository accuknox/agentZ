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
	if !strings.Contains(result.StagedDiff, "+++ b/café.md\n") || result.Tree == nil {
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
