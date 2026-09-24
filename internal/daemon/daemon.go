// Package daemon supervises the native runtime independently of backend connectivity.
package daemon

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/accuknox/agentz/internal/host"
	pb "github.com/accuknox/agentz/internal/host/proto"
	"github.com/accuknox/agentz/internal/skill"
	"github.com/spiffe/go-spiffe/v2/spiffegrpc/grpccredentials"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
)

const runtimeRoot = "/var/lib/agentz/runtime"

// Config is root-owned enrollment state, stored outside user work files.
type Config struct {
	WorkloadID       string `json:"workload_id"`
	XDGDataHome      string `json:"xdg_data_home,omitempty"`
	XDGStateHome     string `json:"xdg_state_home,omitempty"`
	XDGCacheHome     string `json:"xdg_cache_home,omitempty"`
	Backend          string `json:"backend"`
	ServerSPIFFEID   string `json:"server_spiffe_id"`
	WorkloadSocket   string `json:"workload_socket"`
	Username         string `json:"username"`
	XDGConfigHome    string `json:"xdg_config_home,omitempty"`
	WorkDirectory    string `json:"work_directory"`
	StateDirectory   string `json:"state_directory"`
	RuntimeDirectory string `json:"runtime_directory"`
	Executable       string `json:"executable"`
}

type supervisor struct {
	statePath string
	config    Config
	user      *user.User
	network   *Network
	mu        sync.Mutex
	status    host.Status
	desired   *pb.Runtime
	changed   chan struct{}
	password  string
	health    *http.Client
	connected bool
}

// Run supervises native processes and reconnects using SPIRE workload credentials.
// Cancellation stops this daemon's listeners, but does not stop runtime units.
func Run(ctx context.Context, config Config) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if os.Geteuid() != 0 {
		return fmt.Errorf("daemon must run as root; workloads run as the enrolled user")
	}
	owner, err := user.Lookup(config.Username)
	if err != nil {
		return fmt.Errorf("resolve runtime user: %w", err)
	}
	if owner.Uid == "0" {
		return fmt.Errorf("runtime user must not be root")
	}
	if config.Backend == "" || config.RuntimeDirectory == "" || config.WorkloadID == "" {
		return fmt.Errorf("backend, workload_id and runtime_directory are required")
	}
	serverID, err := spiffeid.FromString(config.ServerSPIFFEID)
	if err != nil {
		return fmt.Errorf("backend SPIFFE identity: %w", err)
	}
	if config.WorkloadSocket == "" {
		config.WorkloadSocket = "unix:///run/agentz/spire/api.sock"
	}
	if config.StateDirectory == "" {
		config.StateDirectory = "/var/lib/agentz/daemon"
	}
	if config.Executable == "" {
		config.Executable = "/usr/local/lib/agentz/agentz"
	}
	if config.WorkDirectory == "" {
		config.WorkDirectory = filepath.Join(owner.HomeDir, "agentz")
	}
	if config.XDGConfigHome == "" {
		config.XDGConfigHome = filepath.Join(owner.HomeDir, ".config")
	}
	configPathInvalid := !filepath.IsAbs(config.XDGConfigHome) || strings.ContainsAny(config.XDGConfigHome+owner.HomeDir, "\n\r\x00:")
	if configPathInvalid {
		return fmt.Errorf("invalid enrolled user's configuration path")
	}

	if config.XDGDataHome == "" {
		config.XDGDataHome = filepath.Join(owner.HomeDir, ".local/share")
	}
	if config.XDGStateHome == "" {
		config.XDGStateHome = filepath.Join(owner.HomeDir, ".local/state")
	}
	if config.XDGCacheHome == "" {
		config.XDGCacheHome = filepath.Join(owner.HomeDir, ".cache")
	}
	paths := []string{
		config.WorkDirectory,
		config.StateDirectory,
		config.RuntimeDirectory,
		config.Executable,
		config.XDGDataHome,
		config.XDGStateHome,
		config.XDGCacheHome,
	}
	for _, path := range paths {
		pathInvalid := !filepath.IsAbs(path) || strings.TrimSpace(path) != path || strings.ContainsAny(path, "\n\r\x00:")
		if pathInvalid {
			return fmt.Errorf("invalid daemon path %q", path)
		}
	}
	if err := os.MkdirAll(config.StateDirectory, 0700); err != nil {
		return err
	}
	if err := os.Chmod(config.StateDirectory, 0700); err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	s := &supervisor{
		config:  config,
		user:    owner,
		changed: make(chan struct{}, 1),
		status: host.Status{
			WorkDirectory: config.WorkDirectory,
			Hostname:      hostname,
		},
	}
	scope := sha256.Sum256([]byte(config.WorkloadID))
	s.statePath = filepath.Join(runtimeRoot, "state", hex.EncodeToString(scope[:16]))
	passwordPath := filepath.Join(config.StateDirectory, "opencode-password")
	password, err := os.ReadFile(passwordPath)
	if errors.Is(err, os.ErrNotExist) {
		password = make([]byte, 32)
		if _, err = rand.Read(password); err != nil {
			return err
		}
		password = []byte(hex.EncodeToString(password))
		err = os.WriteFile(passwordPath, password, 0600)
	}
	if err != nil {
		return fmt.Errorf("local runtime credential: %w", err)
	}
	s.password = string(password)
	s.health = &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				var conn net.Conn
				err := inNamespace(func() error {
					var err error
					conn, err = (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
					return err
				})
				return conn, err
			},
		},
	}
	defer s.health.CloseIdleConnections()
	// Restore desired state before connecting, so a backend outage does not stop
	// an enrolled machine from restoring its existing local runtime after reboot.
	persisted, err := os.ReadFile(filepath.Join(config.StateDirectory, "desired.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		var desired pb.Runtime
		if err = json.Unmarshal(persisted, &desired); err != nil {
			return fmt.Errorf("read desired runtime: %w", err)
		}
		s.desired = &desired
		s.changed <- struct{}{}
	}
	s.network, err = NewNetwork(ctx, nil)
	if err != nil {
		return err
	}
	// Stop DNS on exit while leaving the workload firewall in place.
	defer func() {
		cancel()
		s.network.Close()
	}()
	go s.reconcile(ctx)
	source, err := workloadapi.NewX509Source(
		ctx,
		workloadapi.WithClientOptions(workloadapi.WithAddr(config.WorkloadSocket)),
	)
	if err != nil {
		return err
	}
	defer source.Close()
	credentials := grpccredentials.MTLSClientCredentials(
		source,
		source,
		tlsconfig.AuthorizeID(serverID),
	)
	conn, err := grpc.NewClient(
		config.Backend,
		grpc.WithTransportCredentials(credentials),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(5*1024*1024)),
	)
	if err != nil {
		return err
	}
	defer conn.Close()
	client := &host.Client{RPC: pb.NewHostRelayClient(conn), Apply: s.apply, Status: s.report}
	client.DialLocal = func(ctx context.Context, service pb.Service) (net.Conn, error) {
		address := ""
		switch service {
		case pb.Service_SERVICE_OPENCODE:
			address = "127.0.0.1:4180"
		case pb.Service_SERVICE_FILESYSTEM:
			address = "127.0.0.1:4097"
		default:
			return nil, fmt.Errorf("unknown local service")
		}
		var conn net.Conn
		err := inNamespace(func() error {
			var err error
			conn, err = (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", address)
			return err
		})
		return conn, err
	}
	ports := map[pb.Service]int{
		pb.Service_SERVICE_MCP:          4181,
		pb.Service_SERVICE_INFERENCE:    4182,
		pb.Service_SERVICE_PLATFORM:     4183,
		pb.Service_SERVICE_SECRET_PROXY: 4184,
		pb.Service_SERVICE_TELEMETRY:    4186,
		pb.Service_SERVICE_TRACES:       4187,
	}
	for service, port := range ports {
		var listener net.Listener
		err := inNamespace(func() error {
			var err error
			listener, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
			return err
		})
		if err != nil {
			return err
		}
		defer listener.Close()
		go func() {
			err := client.ServeForward(ctx, listener, service)
			if ctx.Err() == nil {
				slog.ErrorContext(ctx, "local service bridge stopped", "service", service, "error", err)
				cancel()
			}
		}()
	}
	target, _ := url.Parse("http://127.0.0.1:4096")
	proxy := &httputil.ReverseProxy{Rewrite: func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		request.Out.SetBasicAuth("opencode", s.password)
	}}
	proxy.Transport = &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			var conn net.Conn
			err := inNamespace(func() error {
				var err error
				conn, err = (&net.Dialer{}).DialContext(ctx, network, address)
				return err
			})
			return conn, err
		},
	}
	var listener net.Listener
	err = inNamespace(func() error {
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:4180")
		return err
	})
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second}
	defer server.Close()
	go func() {
		err := server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
			slog.ErrorContext(ctx, "local runtime bridge stopped", "error", err)
			cancel()
		}
	}()
	go func() {
		if err := runTelemetry(ctx); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "native security telemetry stopped", "error", err)
		}
	}()
	delay := time.Second
	for {
		started := time.Now()
		err := client.Run(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.mu.Lock()
		s.connected = false
		s.mu.Unlock()
		s.report()
		slog.WarnContext(ctx, "compute connection lost; local runtime continues", "error", err)
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

// inNamespace confines only socket creation to the workload namespace. The
// daemon's control connection remains in the host namespace. Never leave a
// reusable Go thread in another network namespace.
func inNamespace(action func() error) error {
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		restored := true
		defer func() {
			if restored {
				runtime.UnlockOSThread()
			}
		}()
		original, err := os.Open("/proc/self/task/" + strconv.Itoa(unix.Gettid()) + "/ns/net")
		if err != nil {
			result <- err
			return
		}
		defer original.Close()
		target, err := os.Open("/run/netns/agentz")
		if err != nil {
			result <- err
			return
		}
		defer target.Close()
		if err := unix.Setns(int(target.Fd()), unix.CLONE_NEWNET); err != nil {
			result <- err
			return
		}
		err = action()
		if restoreErr := unix.Setns(int(original.Fd()), unix.CLONE_NEWNET); restoreErr != nil {
			restored = false
			result <- fmt.Errorf("restore host network namespace: %w", restoreErr)
			// A locked goroutine exiting destroys its thread rather than returning a
			// namespace-contaminated thread to the runtime pool.
			runtime.Goexit()
		}
		result <- err
	}()
	return <-result
}

func (s *supervisor) apply(_ context.Context, desired *pb.Runtime) error {
	if len(desired.Configuration) > 4*1024*1024 {
		return fmt.Errorf("runtime configuration too large")
	}
	var spec host.RuntimeSpec
	if err := json.Unmarshal(desired.Configuration, &spec); err != nil {
		return err
	}
	if spec.WorkDirectory != s.config.WorkDirectory {
		return fmt.Errorf("runtime work directory differs from enrollment")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.connected = true
	if s.desired != nil && s.desired.Generation == desired.Generation {
		return nil
	}
	data, err := json.Marshal(desired)
	if err != nil {
		return err
	}
	path := filepath.Join(s.config.StateDirectory, "desired.json")
	if err := os.WriteFile(path+".next", data, 0600); err != nil {
		return err
	}
	if err := os.Rename(path+".next", path); err != nil {
		return err
	}
	s.desired = desired
	s.status.Ready = false
	select {
	case s.changed <- struct{}{}:
	default:
	}
	return nil
}

func (s *supervisor) reconcile(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	var applied string
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.changed:
		case <-ticker.C:
		}
		s.mu.Lock()
		desired := s.desired
		s.mu.Unlock()
		if desired == nil {
			continue
		}
		var err error
		if applied != desired.Generation {
			err = s.install(ctx, desired)
			if err == nil {
				applied = desired.Generation
			}
		}
		if err == nil {
			for _, unit := range []string{"agentz-opencode.service", "agentz-filesystem.service"} {
				if err = exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", unit).Run(); err != nil {
					err = fmt.Errorf("runtime service %s is not active", unit)
					break
				}
			}
		}
		if err == nil {
			addresses := []string{
				"http://127.0.0.1:4096/config",
				"http://127.0.0.1:4097/stat?path=.agents/skills",
			}
			for _, address := range addresses {
				request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
				if requestErr != nil {
					err = requestErr
					break
				}
				request.SetBasicAuth("opencode", s.password)
				response, requestErr := s.health.Do(request)
				if requestErr != nil {
					err = fmt.Errorf("runtime health: %w", requestErr)
					break
				}
				response.Body.Close()
				if response.StatusCode != http.StatusOK {
					err = fmt.Errorf("runtime health returned status %d", response.StatusCode)
					break
				}
			}
		}
		s.mu.Lock()
		s.status.Generation = applied
		s.status.Ready = err == nil
		s.status.Error = ""
		if err != nil {
			s.status.Error = err.Error()
			slog.ErrorContext(ctx, "native runtime not ready", "error", err)
		}
		s.mu.Unlock()
	}
}

func (s *supervisor) install(ctx context.Context, desired *pb.Runtime) error {
	var spec host.RuntimeSpec
	if err := json.Unmarshal(desired.Configuration, &spec); err != nil {
		return err
	}
	if spec.WorkDirectory != s.config.WorkDirectory {
		return fmt.Errorf("desired work directory differs from enrollment")
	}
	if err := s.network.Update(ctx, spec.AllowedHosts); err != nil {
		return fmt.Errorf("configure direct network policy: %w", err)
	}
	installed, err := os.ReadFile(filepath.Join(s.config.StateDirectory, "installed-generation"))
	if err == nil && string(installed) == desired.Generation {
		command := exec.CommandContext(
			ctx, "systemctl", "start",
			"agentz-opencode.service", "agentz-filesystem.service",
		)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("restore runtime units: %w: %.4096s", err, output)
		}
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	runtimePaths := []string{
		runtimeRoot,
		runtimeRoot + "/config",
		runtimeRoot + "/empty",
		runtimeRoot + "/skills/immutable",
	}
	for _, path := range runtimePaths {
		if err := os.MkdirAll(path, 0755); err != nil {
			return err
		}
	}
	for _, directory := range []string{"config", "empty"} {
		path := filepath.Join(runtimeRoot, directory, ".gitignore")
		if err := os.WriteFile(path, []byte("node_modules\n"), 0644); err != nil {
			return err
		}
	}
	uid, err := strconv.Atoi(s.user.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(s.user.Gid)
	if err != nil {
		return err
	}
	for _, directory := range []string{"data", "state", "cache"} {
		path := filepath.Join(s.statePath, directory)
		if err := os.MkdirAll(path, 0755); err != nil {
			return err
		}
		if err := os.Chown(path, uid, gid); err != nil {
			return err
		}
		if err := os.Chmod(path, 0700); err != nil {
			return err
		}
	}
	bundle := filepath.Join(s.config.RuntimeDirectory, "etc/opencode")
	if err := os.Remove(runtimeRoot + "/bundle"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(bundle, runtimeRoot+"/bundle"); err != nil {
		return err
	}
	entries, err := os.ReadDir(bundle)
	if err != nil {
		return fmt.Errorf("managed runtime bundle: %w", err)
	}
	for _, entry := range entries {
		if entry.Name() == "opencode.json" {
			continue
		}
		destination := filepath.Join(runtimeRoot, "config", entry.Name())
		if _, err := os.Lstat(destination); errors.Is(err, os.ErrNotExist) {
			if err := os.Symlink(filepath.Join(bundle, entry.Name()), destination); err != nil {
				return err
			}
		}
	}
	opencodeConfig := runtimeRoot + "/config/opencode.json"
	if err := os.WriteFile(opencodeConfig, spec.OpenCodeConfig, 0644); err != nil {
		return err
	}
	for name, content := range spec.Instructions {
		if filepath.Base(name) != name || name == "." || !strings.HasSuffix(name, ".md") {
			return fmt.Errorf("invalid instruction filename")
		}
		path := filepath.Join(runtimeRoot, "config", name)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return err
		}
	}
	if err := os.WriteFile(runtimeRoot+"/gateway-token", []byte("native-bridge\n"), 0644); err != nil {
		return err
	}
	if spec.SecretProxy {
		if !x509.NewCertPool().AppendCertsFromPEM(spec.CABundle) {
			return fmt.Errorf("secret proxy requires a valid CA bundle")
		}
		bundle := append([]byte(nil), spec.CABundle...)
		certificatePaths := []string{
			"/etc/ssl/certs/ca-certificates.crt",
			"/etc/pki/tls/certs/ca-bundle.crt",
		}
		for _, path := range certificatePaths {
			if system, err := os.ReadFile(path); err == nil {
				bundle = append(bundle, '\n')
				bundle = append(bundle, system...)
				break
			}
		}
		if err := os.WriteFile(runtimeRoot+"/ca.pem", bundle, 0644); err != nil {
			return err
		}
	}
	// The package generator is shared with the Kubernetes runtime, including
	// language-runtime package composition. It never executes request text as shell.
	for _, pkg := range spec.Packages {
		if strings.ContainsAny(pkg, ",\n\r\x00") {
			return fmt.Errorf("invalid package attribute")
		}
	}
	command := exec.CommandContext(
		ctx,
		"/usr/local/lib/agentz/nix-packages.sh", "build", runtimeRoot+"/packages",
	)
	command.Env = append(os.Environ(), "NIX_PACKAGES="+strings.Join(spec.Packages, ","))
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("provision native packages: %w: %.4096s", err, output)
	}
	if err := s.installSkills(ctx, spec); err != nil {
		return err
	}
	command = exec.CommandContext(
		ctx, "runuser", "-u", s.user.Username, "--", "mkdir", "-p", "--",
		s.config.WorkDirectory,
		filepath.Join(s.config.WorkDirectory, ".agents/skills"),
		filepath.Join(s.user.HomeDir, ".opencode"),
		filepath.Join(s.config.XDGConfigHome, "opencode"),
		filepath.Join(s.config.XDGDataHome, "opencode"),
		filepath.Join(s.config.XDGStateHome, "opencode"),
		filepath.Join(s.config.XDGCacheHome, "opencode"),
	)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("create user work directory: %w: %.4096s", err, output)
	}
	units, err := s.units(spec)
	if err != nil {
		return err
	}
	for name, contents := range units {
		path := filepath.Join("/etc/systemd/system", name)
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			return err
		}
	}
	command = exec.CommandContext(ctx, "systemctl", "daemon-reload")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("reload runtime units: %w: %.4096s", err, output)
	}
	command = exec.CommandContext(
		ctx, "systemctl", "restart",
		"agentz-opencode.service", "agentz-filesystem.service",
	)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("start runtime units: %w: %.4096s", err, output)
	}
	generationPath := filepath.Join(s.config.StateDirectory, "installed-generation")
	return os.WriteFile(generationPath, []byte(desired.Generation), 0600)
}

func (s *supervisor) units(spec host.RuntimeSpec) (map[string]string, error) {
	environment := make(map[string]string, len(spec.Env)+8)
	for key, value := range spec.Env {
		environment[key] = value
	}
	environment["HOME"] = s.user.HomeDir
	environment["XDG_CONFIG_HOME"] = s.config.XDGConfigHome
	environment["XDG_DATA_HOME"] = s.config.XDGDataHome
	environment["XDG_STATE_HOME"] = s.config.XDGStateHome
	environment["XDG_CACHE_HOME"] = s.config.XDGCacheHome
	environment["USER"] = s.user.Username
	environment["PATH"] = s.config.RuntimeDirectory + "/bin:" + runtimeRoot + "/packages/bin:/usr/local/bin:/usr/bin:/bin"
	environment["OPENCODE_CONFIG_DIR"] = runtimeRoot + "/config"
	environment["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1"
	environment["OPENCODE_DISABLE_MODELS_FETCH"] = "1"
	environment["OPENCODE_DISABLE_SHARE"] = "1"
	environment["OPENCODE_SERVER_PASSWORD"] = s.password
	// Keep local CLI credentials in the real HOME and XDG directories. Only
	// OpenCode's own configuration directories are overlaid in the unit.
	common := fmt.Sprintf(`[Unit]
After=network-online.target
[Service]
Type=simple
User=%s
Group=%s
WorkingDirectory=%s
NetworkNamespacePath=/run/netns/agentz
BindReadOnlyPaths=/etc/netns/agentz/resolv.conf:/etc/resolv.conf
Restart=on-failure
RestartSec=5
KillMode=control-group
`, s.user.Uid, s.user.Gid, strings.ReplaceAll(s.config.WorkDirectory, "%", "%%"))
	var env strings.Builder
	for key, value := range environment {
		if key == "" || strings.ContainsAny(key, "=\n\r\x00") {
			return nil, fmt.Errorf("invalid runtime environment key")
		}
		env.WriteString("Environment=" + unitQuote(key+"="+value) + "\n")
	}
	userConfig := unitQuote(filepath.Join(s.user.HomeDir, ".opencode"))
	managedConfig := unitQuote(filepath.Join(s.config.XDGConfigHome, "opencode"))
	opencodeExecutable := unitQuote(filepath.Join(s.config.RuntimeDirectory, "bin/opencode"))
	openCode := common + env.String() +
		"BindReadOnlyPaths=" + unitQuote(runtimeRoot+"/empty") + ":" + userConfig +
		" " + unitQuote(runtimeRoot+"/bundle") + ":" + managedConfig +
		" " + runtimeRoot + "/empty:/etc/opencode\nExecStart=:" +
		opencodeExecutable + " serve --hostname 127.0.0.1 --port 4096\n"
	stateDirectories := map[string]string{
		s.config.XDGDataHome:  "data",
		s.config.XDGStateHome: "state",
		s.config.XDGCacheHome: "cache",
	}
	for destination, source := range stateDirectories {
		openCode += "BindPaths=" + unitQuote(filepath.Join(s.statePath, source)) + ":" +
			unitQuote(filepath.Join(destination, "opencode")) + "\n"
	}
	filesystem := common + "Environment=" + unitQuote("HOME="+s.user.HomeDir) +
		"\nExecStart=:" + unitQuote(s.config.Executable) +
		" filesystem serve --addr 127.0.0.1:4097 --root " + unitQuote(s.config.WorkDirectory) + "\n"
	return map[string]string{
		"agentz-opencode.service":   openCode,
		"agentz-filesystem.service": filesystem,
	}, nil
}

// unitQuote escapes systemd specifier/argument expansion as well as whitespace.
func unitQuote(value string) string { return strconv.Quote(strings.ReplaceAll(value, "%", "%%")) }

func (s *supervisor) installSkills(ctx context.Context, spec host.RuntimeSpec) error {
	staged, err := os.MkdirTemp(runtimeRoot+"/skills", "staging-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staged)
	if err := os.Chmod(staged, 0755); err != nil {
		return err
	}
	if len(spec.Skills) > 0 {
		transport := &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				var conn net.Conn
				err := inNamespace(func() error {
					var err error
					conn, err = (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
					return err
				})
				return conn, err
			},
		}
		defer transport.CloseIdleConnections()
		client := &http.Client{
			Transport: transport,
			Timeout:   time.Minute,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		request, err := http.NewRequestWithContext(
			ctx, http.MethodGet, "http://127.0.0.1:4183/api/compute/skills", nil,
		)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return fmt.Errorf("download managed skills: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("download managed skills: status %d", response.StatusCode)
		}
		bundle, err := skill.ParseCanonicalZIP(response.Body)
		if err != nil {
			return err
		}
		root, err := os.OpenRoot(staged)
		if err != nil {
			return err
		}
		defer root.Close()
		expected := make(map[string]bool, len(spec.Skills))
		for _, entry := range spec.Skills {
			expected[entry.Name] = true
		}
		if len(bundle.Skills) != len(expected) {
			return fmt.Errorf("managed skill archive does not match desired skills")
		}
		for _, tree := range bundle.Skills {
			if !expected[tree.Name] {
				return fmt.Errorf("unexpected managed skill %q", tree.Name)
			}
			for _, file := range tree.Files {
				path := filepath.Join(tree.Name, file.Path)
				if err := root.MkdirAll(filepath.Dir(path), 0755); err != nil {
					return err
				}
				if err := root.WriteFile(path, file.Content, 0644); err != nil {
					return err
				}
			}
		}
	}
	destination := runtimeRoot + "/skills/immutable"
	previous := destination + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return err
	}
	if err := os.Rename(destination, previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(staged, destination); err != nil {
		_ = os.Rename(previous, destination)
		return err
	}
	return os.RemoveAll(previous)
}

// Unenroll stops the fixed native services and removes only AgentZ identity
// state. Work directories, user credentials, Nix and sensor TLS remain intact.
// Backend revocation is performed through the Agent's existing authorization.
func Unenroll(ctx context.Context, output io.Writer) error {
	if os.Geteuid() != 0 {
		return errors.New("unenrollment requires sudo")
	}
	units := []string{
		"agentz-daemon.service", "agentz-spire.service",
		"agentz-opencode.service", "agentz-filesystem.service",
	}
	for _, unit := range units {
		if err := exec.CommandContext(ctx, "systemctl", "stop", unit).Run(); err != nil {
			inspect := exec.CommandContext(
				ctx, "systemctl", "show", "--property=ActiveState", "--value", unit,
			)
			state, inspectErr := inspect.Output()
			value := strings.TrimSpace(string(state))
			if inspectErr != nil || value != "inactive" && value != "failed" {
				return fmt.Errorf("stop %s before deleting identity: %w", unit, err)
			}
		}
	}
	_, err := os.Stat("/run/agentz/native-network")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err := networkCommand(ctx, "", "ip", "link", "show", "agentz-host"); err == nil {
			if err := networkCommand(ctx, "", "ip", "link", "delete", "agentz-host"); err != nil {
				return err
			}
		}
		_, namespaceErr := os.Stat("/run/netns/agentz")
		if namespaceErr != nil && !errors.Is(namespaceErr, os.ErrNotExist) {
			return namespaceErr
		}
		if namespaceErr == nil {
			if err := networkCommand(ctx, "", "ip", "netns", "delete", NativeNetworkNamespace); err != nil {
				return err
			}
		}
		if err := networkCommand(ctx, "", "nft", "list", "table", "inet", networkTable); err == nil {
			if err := networkCommand(ctx, "", "nft", "delete", "table", "inet", networkTable); err != nil {
				return err
			}
		}
		networkPaths := []string{
			"/etc/netns/agentz/resolv.conf",
			"/etc/netns/agentz",
			"/run/agentz/native-network",
		}
		for _, path := range networkPaths {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	identityPaths := []string{
		"/etc/agentz/daemon.json", "/etc/agentz/spire.conf",
		"/etc/agentz/join-token", "/run/agentz/daemon-status.json",
	}
	for _, path := range identityPaths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, path := range []string{"/var/lib/agentz/spire", "/var/lib/agentz/daemon"} {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	fmt.Fprintln(output, "Local enrollment removed. Work files, local credentials and Nix packages were preserved.")
	fmt.Fprintln(output, "Disconnect this host in AgentZ to revoke its backend assignment before enrolling again.")
	return nil
}
