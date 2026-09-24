package daemon

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/accuknox/agentz/internal/host"
)

func TestRuntimeUnitsParseWithUserPathsAndEnvironment(t *testing.T) {
	analyzer, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze unavailable")
	}
	root := t.TempDir()
	bundle := filepath.Join(root, "runtime with spaces %n $NAME")
	if err := os.MkdirAll(filepath.Join(bundle, "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/bin/true", filepath.Join(bundle, "bin/opencode")); err != nil {
		t.Fatal(err)
	}
	owner, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	s := &supervisor{
		config: Config{
			RuntimeDirectory: bundle,
			Executable:       "/bin/true",
			WorkDirectory:    root,
			XDGConfigHome:    filepath.Join(root, ".config"),
			XDGDataHome:      filepath.Join(root, ".local/share"),
			XDGStateHome:     filepath.Join(root, ".local/state"),
			XDGCacheHome:     filepath.Join(root, ".cache"),
		},
		user: owner, password: "local-password", statePath: filepath.Join(root, "state"),
	}
	units, err := s.units(host.RuntimeSpec{Env: map[string]string{
		"LOCAL_SETTING": "literal $HOME %n \"quoted\"\nnext line",
	}})
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 2, 2+len(units))
	paths[0], paths[1] = "verify", "--man=no"
	for name, content := range units {
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
		if strings.Contains(content, "XDG_CONFIG_HOME=/var/lib/") {
			t.Fatal("host CLI configuration was replaced")
		}
		if strings.Contains(content, "PartOf=agentz-daemon") {
			t.Fatal("daemon lifecycle owns runtime process lifetime")
		}
	}
	command := exec.CommandContext(t.Context(), analyzer, paths...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("systemd rejected generated unit: %v\n%s", err, output)
	}
}

func TestRuntimeEnvironmentRejectsInjectedDirectives(t *testing.T) {
	s := &supervisor{user: &user.User{}, config: Config{}}
	for _, key := range []string{"", "NORMAL\nExecStart", "NAME=value", "NAME\x00"} {
		if _, err := s.units(host.RuntimeSpec{Env: map[string]string{key: "x"}}); err == nil {
			t.Errorf("accepted environment key %q", key)
		}
	}
}

// TestNativeRuntimeSmoke is opt-in because it starts real, isolated systemd
// units and a network namespace. It does not change the installed AgentZ units.
func TestNativeRuntimeSmoke(t *testing.T) {
	runtimePath := os.Getenv("AGENTZ_SMOKE_RUNTIME")
	executable := os.Getenv("AGENTZ_SMOKE_BINARY")
	if runtimePath == "" || executable == "" {
		t.Skip("set AGENTZ_SMOKE_RUNTIME and AGENTZ_SMOKE_BINARY for native smoke")
	}
	if os.Geteuid() != 0 {
		t.Fatal("native smoke requires root")
	}
	owner, err := user.Lookup("nobody")
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp("/tmp", "agentz-native-smoke-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	uid, err := strconv.Atoi(owner.Uid)
	if err != nil {
		t.Fatal(err)
	}
	gid, err := strconv.Atoi(owner.Gid)
	if err != nil {
		t.Fatal(err)
	}
	owner.HomeDir = filepath.Join(root, "home")
	userPaths := []string{
		owner.HomeDir,
		filepath.Join(owner.HomeDir, "work"),
		filepath.Join(owner.HomeDir, "work/.agents"),
		filepath.Join(owner.HomeDir, "work/.agents/skills"),
		filepath.Join(owner.HomeDir, ".opencode"),
		filepath.Join(owner.HomeDir, ".config"),
		filepath.Join(owner.HomeDir, ".config/opencode"),
	}
	for _, path := range userPaths {
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	managed := filepath.Join(root, "runtime")
	for _, path := range []string{managed, managed + "/config", managed + "/empty"} {
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, directory := range []string{"config", "empty"} {
		path := filepath.Join(managed, directory, ".gitignore")
		if err := os.WriteFile(path, []byte("node_modules\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	bundle := filepath.Join(runtimePath, "etc/opencode")
	if err := os.Symlink(bundle, managed+"/bundle"); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(bundle)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == "opencode.json" || entry.Name() == ".gitignore" {
			continue
		}
		source := filepath.Join(bundle, entry.Name())
		destination := filepath.Join(managed, "config", entry.Name())
		if err := os.Symlink(source, destination); err != nil {
			t.Fatal(err)
		}
	}
	opencodeConfig := managed + "/config/opencode.json"
	if err := os.WriteFile(opencodeConfig, []byte(`{"share":"disabled"}`), 0644); err != nil {
		t.Fatal(err)
	}
	resolverPath := filepath.Join(root, "resolv.conf")
	if err := os.WriteFile(resolverPath, []byte("nameserver 127.0.0.53\n"), 0644); err != nil {
		t.Fatal(err)
	}
	namespace := filepath.Base(root)
	run := func(args ...string) []byte {
		t.Helper()
		output, err := exec.CommandContext(t.Context(), args[0], args[1:]...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", strings.Join(args, " "), err, output)
		}
		return output
	}
	run("ip", "netns", "add", namespace)
	t.Cleanup(func() { exec.Command("ip", "netns", "delete", namespace).Run() })
	run("ip", "-n", namespace, "link", "set", "lo", "up")
	s := &supervisor{
		config: Config{
			RuntimeDirectory: runtimePath,
			Executable:       executable,
			WorkDirectory:    owner.HomeDir + "/work",
			XDGConfigHome:    owner.HomeDir + "/.config",
			XDGDataHome:      owner.HomeDir + "/.local/share",
			XDGStateHome:     owner.HomeDir + "/.local/state",
			XDGCacheHome:     owner.HomeDir + "/.cache",
		},
		user: owner, password: "smoke-password", statePath: runtimeRoot + "/state/smoke",
	}
	statePaths := []string{
		managed + "/state/smoke/data",
		managed + "/state/smoke/state",
		managed + "/state/smoke/cache",
		owner.HomeDir + "/.local",
		owner.HomeDir + "/.local/share",
		owner.HomeDir + "/.local/state",
		owner.HomeDir + "/.cache",
		owner.HomeDir + "/.local/share/opencode",
		owner.HomeDir + "/.local/state/opencode",
		owner.HomeDir + "/.cache/opencode",
	}
	for _, path := range statePaths {
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	units, err := s.units(host.RuntimeSpec{})
	if err != nil {
		t.Fatal(err)
	}
	for original, content := range units {
		name := namespace + "-" + original
		content = strings.ReplaceAll(content, runtimeRoot, managed)
		content = strings.ReplaceAll(content, "/run/netns/agentz", "/run/netns/"+namespace)
		content = strings.ReplaceAll(
			content, "/etc/netns/agentz/resolv.conf", filepath.Join(root, "resolv.conf"),
		)
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			exec.Command("systemctl", "stop", name).Run()
			os.Remove(filepath.Join("/etc/systemd/system", name))
			exec.Command("systemctl", "daemon-reload").Run()
			exec.Command("systemctl", "reset-failed", name).Run()
		})
		run("systemctl", "link", path)
		run("systemctl", "start", name)
	}
	endpoints := []string{
		"http://127.0.0.1:4096/global/health",
		"http://127.0.0.1:4097/stat?path=.agents/skills",
		"http://127.0.0.1:4096/config",
		"http://127.0.0.1:4096/experimental/tool/ids",
	}
	for _, endpoint := range endpoints {
		var output []byte
		for attempt := 0; attempt < 40; attempt++ {
			command := exec.CommandContext(
				t.Context(), "ip", "netns", "exec", namespace, "curl",
				"--max-time", "2", "--fail-with-body", "--silent", "--show-error",
				"-u", "opencode:smoke-password", endpoint,
			)
			output, err = command.CombinedOutput()
			if err == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if err != nil {
			files, _ := filepath.Glob(filepath.Join(managed, "state/smoke/data/log/*"))
			for _, file := range files {
				data, _ := os.ReadFile(file)
				if len(data) > 12000 {
					data = data[len(data)-12000:]
				}
				t.Logf("opencode log %s: %s", file, data)
			}
			command := exec.CommandContext(
				t.Context(), "journalctl", "--no-pager", "-n", "100",
				"-u", namespace+"-agentz-opencode.service",
				"-u", namespace+"-agentz-filesystem.service",
			)
			logs, _ := command.CombinedOutput()
			t.Fatalf("native endpoint %s: %v\n%s\n%s", endpoint, err, output, logs)
		}
		t.Logf("native endpoint %s succeeded (%d bytes)", endpoint, len(output))
	}
}
