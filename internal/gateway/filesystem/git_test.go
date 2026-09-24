package filesystem

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestGitDiscoveryUsesConfiguredRuntimeRoot(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	home := t.TempDir()
	project := "Projects/user/github/project"
	repository := filepath.Join(home, project, "repo")
	if err := os.MkdirAll(repository, 0700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "--initial-branch=main"},
		{"-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "--allow-empty", "-m", "initial"},
	} {
		cmd := exec.CommandContext(t.Context(), "git", args...)
		cmd.Dir = repository
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("create test repository: %v: %s", err, output)
		}
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	s := &service{root: root}
	request := GitRequest{
		Root: project, Directory: project + "/repo",
		Git: gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiscover},
	}
	result, err := s.runGit(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Repository == nil || len(result.Repository.Worktrees) != 1 {
		t.Fatalf("unexpected discovery: %#v", result.Repository)
	}
	if got := result.Repository.Worktrees[0].Directory; got != repository {
		t.Fatalf("discovered directory = %q, want enrolled root %q", got, repository)
	}
}
