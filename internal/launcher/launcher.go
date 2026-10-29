// Package launcher connects coding agents to AgentZ through a local relay.
package launcher

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/blang/semver/v4"
	"github.com/cenkalti/backoff/v5"
	"github.com/urfave/cli/v3"
	"go.yaml.in/yaml/v3"
)

var errRelayOwnership = errors.New("another process is using the relay port. It could not be verified as this profile's relay")

type configuration struct {
	ServerURL      string                     `yaml:"serverURL"`
	ExternalAgents []map[string]externalAgent `yaml:"externalAgents"`
}

type externalAgent struct {
	Provider  string `yaml:"provider"`
	ServerURL string `yaml:"serverUrl,omitempty"`
	ClientID  string `yaml:"clientID"`
}

type installation struct {
	externalAgent
	name       string
	configPath string
	profile    string
	address    string
	ownerKey   string
	upstream   *url.URL
}

// Run launches coding agents and manages their local relay.
func Run(ctx context.Context, command *cli.Command) error {
	if command.Name != "launch" {
		var cancel context.CancelFunc
		ctx, cancel = signal.NotifyContext(ctx, os.Interrupt)
		defer cancel()
	}
	args := command.Args().Slice()
	profileName := command.String("profile")
	if command.IsSet("profile") && profileName == "" {
		return errors.New("--profile requires an AgentZ profile name")
	}
	provider := ""
	launch := command.Name == "launch" || command.Name == "login"
	if launch {
		// Parse only the launcher prefix. Everything after -- or the first
		// native argument belongs to the coding agent, including --profile.
		for len(args) > 0 {
			arg := args[0]
			if arg == "--" {
				args = args[1:]
				break
			}
			if provider == "" && (arg == "claude" || arg == "codex") {
				provider, args = arg, args[1:]
				continue
			}
			if arg != "--profile" && !strings.HasPrefix(arg, "--profile=") {
				break
			}
			if profileName != "" {
				return errors.New("specify the AgentZ profile only once")
			}
			profileName = strings.TrimPrefix(arg, "--profile=")
			args = args[1:]
			if arg == "--profile" {
				if len(args) == 0 || strings.HasPrefix(args[0], "--") {
					return errors.New("--profile requires an AgentZ profile name")
				}
				profileName, args = args[0], args[1:]
			}
			if profileName == "" {
				return errors.New("--profile requires an AgentZ profile name")
			}
		}
		if provider == "" && profileName == "" && len(args) > 0 {
			return errors.New("usage: agentz launch [claude|codex] [--profile NAME] [-- native flags]")
		}
	}
	installed, err := loadInstallation(ctx, command.String("config"), profileName, provider)
	if err != nil {
		return err
	}
	if launch {
		provider = installed.Provider
		if _, err := exec.LookPath(provider); err != nil {
			return fmt.Errorf("install %s before launching it: %w", provider, err)
		}
		version, err := exec.CommandContext(ctx, provider, "--version").Output()
		if err != nil {
			return fmt.Errorf("read %s version: %w", provider, err)
		}
		versionText := strings.TrimPrefix(string(version), "codex-cli ")
		versionText, _, _ = strings.Cut(strings.TrimSpace(versionText), " ")
		current, err := semver.Parse(versionText)
		if err != nil {
			return fmt.Errorf("read %s version: %w", provider, err)
		}
		minimum := semver.Version{Major: 2, Minor: 1, Patch: 299}
		if provider == "codex" {
			minimum = semver.Version{Minor: 162, Patch: 1}
		}
		if current.LT(minimum) {
			return fmt.Errorf("AgentZ requires %s %s or later", provider, minimum)
		}
	}

	switch command.Name {
	case "serve":
		return installed.serve(ctx)
	case "status", "stop":
		response, err := installed.controlRelay(ctx, command.Name)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		_, err = io.Copy(command.Writer, response.Body)
		return err
	case "launch", "login":
		if err := installed.ensureRelay(ctx); err != nil {
			return err
		}
		if installed.Provider == "codex" {
			return installed.codex(ctx, command, args)
		}
		if command.Name == "login" {
			return errors.New("run agentz launch claude and complete its gateway sign-in")
		}
		return installed.claude(ctx, command, args)
	default:
		return fmt.Errorf("unknown command %q", command.Name)
	}
}

func (installed *installation) claude(ctx context.Context, command *cli.Command, args []string) error {
	profile := filepath.Join(installed.profile, "claude")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}
	// Keep native preferences and credentials while enforcing gateway selection
	// and supported modes. Models arrive through authenticated managed settings.
	settingsPath := filepath.Join(profile, "settings.json")
	settings := make(map[string]json.RawMessage)
	data, err := os.ReadFile(settingsPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("read Claude settings: %w", err)
		}
		if settings == nil {
			return errors.New("expected a JSON object in Claude settings")
		}
	}
	gateway, _ := json.Marshal(installed.address)
	settings["forceLoginMethod"] = json.RawMessage(`"gateway"`)
	settings["forceLoginGatewayUrl"] = gateway
	settings["disableAutoMode"] = json.RawMessage(`"disable"`)
	// Persist correlation hints so native sessions that reuse this profile
	// also supply prompt IDs when started without the launcher environment.
	env := make(map[string]json.RawMessage)
	if raw := settings["env"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("read Claude environment settings: %w", err)
		}
		if env == nil {
			env = make(map[string]json.RawMessage)
		}
	}
	env["CLAUDE_CODE_GATEWAY_HINT_HEADERS"] = json.RawMessage(`"1"`)
	settings["env"], err = json.Marshal(env)
	if err != nil {
		return err
	}
	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	// Rename protects readers from truncated JSON during concurrent launches.
	if err := writeProfileFile(settingsPath, data); err != nil {
		return err
	}
	child := exec.CommandContext(ctx, "claude", args...)
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, command.Writer, command.ErrWriter
	child.Env = slices.DeleteFunc(os.Environ(), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		return name == "CLAUDE_CONFIG_DIR" || name == "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" || name == "CLAUDE_CODE_GATEWAY_HINT_HEADERS" ||
			strings.HasPrefix(name, "ANTHROPIC_") || name == "CLAUDE_CODE_OAUTH_TOKEN" ||
			name == "CLAUDE_CODE_USE_BEDROCK" || name == "CLAUDE_CODE_USE_VERTEX" ||
			name == "CLAUDE_CODE_USE_FOUNDRY" || name == "CLAUDE_CODE_USE_MANTLE"
	})
	child.Env = append(child.Env,
		"CLAUDE_CONFIG_DIR="+profile,
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1", "CLAUDE_CODE_GATEWAY_HINT_HEADERS=1",
	)
	if err := child.Run(); err != nil {
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return cli.Exit("Claude exited", exit.ExitCode())
		}
		return err
	}
	return nil
}

func writeProfileFile(name string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(name), ".agentz-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(data)
	err = errors.Join(writeErr, file.Close())
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), name)
}

func loadInstallation(ctx context.Context, configPath, profileName, provider string) (*installation, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	if configPath == "" {
		configPath = filepath.Join(root, "agentz", "config.yaml")
	}
	configPath, err = filepath.Abs(configPath)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(configPath)
	if err != nil {
		return nil, fmt.Errorf(
			"read %s: %w\nAdd serverURL and externalAgents from your agent setup instructions",
			configPath, err,
		)
	}
	defer file.Close()
	var config configuration
	decoder := yaml.NewDecoder(io.LimitReader(file, 64<<10))
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("read AgentZ configuration: %w", err)
	}
	if err := decoder.Decode(new(configuration)); err != io.EOF {
		return nil, errors.New("AgentZ configuration must contain one YAML document")
	}
	if len(config.ExternalAgents) == 0 {
		return nil, errors.New("externalAgents must contain at least one named agent")
	}
	var selected externalAgent
	selectedName := ""
	names := make(map[string]bool, len(config.ExternalAgents))
	for index, entry := range config.ExternalAgents {
		if len(entry) != 1 {
			return nil, fmt.Errorf("externalAgents entry %d must contain exactly one named agent", index+1)
		}
		for name, agent := range entry {
			if strings.TrimSpace(name) == "" || strings.IndexFunc(name, unicode.IsControl) >= 0 {
				return nil, errors.New("external agent profile names must not be empty or contain control characters")
			}
			if names[name] {
				return nil, fmt.Errorf("duplicate external agent profile %q", name)
			}
			names[name] = true
			if agent.Provider != "claude" && agent.Provider != "codex" {
				return nil, fmt.Errorf("profile %q: provider must be claude or codex", name)
			}
			if profileName != "" && profileName != name {
				continue
			}
			if profileName == "" && provider != "" && provider != agent.Provider {
				continue
			}
			if selectedName == "" {
				selected, selectedName = agent, name
			}
		}
	}
	if selectedName == "" {
		if profileName != "" {
			return nil, fmt.Errorf("external agent profile %q was not found", profileName)
		}
		return nil, fmt.Errorf("no external agent profile is configured for %s", provider)
	}
	if provider != "" && provider != selected.Provider {
		return nil, fmt.Errorf("profile %q uses %s, not %s", selectedName, selected.Provider, provider)
	}
	if selected.ServerURL == "" {
		selected.ServerURL = config.ServerURL
	}
	upstream, err := url.Parse(selected.ServerURL)
	if err != nil {
		return nil, fmt.Errorf("invalid serverURL: %w", err)
	}
	loopback := upstream.Hostname() == "localhost" || upstream.Hostname() == "127.0.0.1" || upstream.Hostname() == "::1"
	secure := upstream.Scheme == "https" || upstream.Scheme == "http" && loopback
	invalidOrigin := upstream.Host == "" || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" ||
		(upstream.Path != "" && upstream.Path != "/") || !secure
	if invalidOrigin {
		return nil, errors.New("serverURL must be an HTTPS origin. HTTP is allowed on loopback addresses for local development")
	}
	if selected.ClientID == "" || strings.ContainsAny(selected.ClientID, "\r\n\t ") {
		return nil, errors.New("clientID must be the OAuth client ID from your agent setup")
	}
	upstream.Path = ""
	digest := sha256.Sum256([]byte(upstream.String() + "\x00" + selected.ClientID))
	profile := filepath.Join(root, "agentz", "profiles", hex.EncodeToString(digest[:8]))
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(profile, "relay.key")
	key, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, writeErr := key.WriteString(hex.EncodeToString([]byte(rand.Text())))
		err = errors.Join(writeErr, key.Close())
		if err != nil {
			return nil, err
		}
	}
	if err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	// Another launcher may still be writing the key. Wait for it before
	// verifying the relay.
	ownerKey, err := backoff.Retry(
		ctx,
		func() ([]byte, error) {
			data, err := os.ReadFile(keyPath)
			if err != nil {
				return nil, backoff.Permanent(err)
			}
			if len(data) < 32 {
				return nil, errors.New("relay identity file is incomplete. Remove it and launch again")
			}
			return data, nil
		},
		backoff.WithMaxTries(20),
		backoff.WithBackOff(backoff.NewConstantBackOff(25*time.Millisecond)),
	)
	if err != nil {
		return nil, err
	}
	port := 20000 + (int(digest[0])<<8|int(digest[1]))%30000
	return &installation{
		externalAgent: selected,
		name:          selectedName,
		configPath:    configPath,
		profile:       profile,
		address:       "http://127.0.0.1:" + strconv.Itoa(port),
		ownerKey:      string(ownerKey),
		upstream:      upstream,
	}, nil
}

func (installed *installation) ensureRelay(ctx context.Context) error {
	startupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, err := installed.controlRelay(startupCtx, "status")
	if err == nil {
		response.Body.Close()
		return nil
	}
	if errors.Is(err, errRelayOwnership) {
		return err
	}
	if err := startupCtx.Err(); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	logPath := filepath.Join(installed.profile, "relay.log")
	log, err := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	info, err := log.Stat()
	if err != nil {
		return err
	}
	child := exec.Command(executable, "--config", installed.configPath, "--profile", installed.name, "relay", "serve")
	child.Stdout, child.Stderr = log, log
	if err := startRelay(child); err != nil {
		return err
	}
	exited := make(chan struct{})
	var childErr error
	// Reap the persistent relay when it exits, even after readiness returns.
	go func() {
		childErr = child.Wait()
		close(exited)
	}()
	ready := false
	defer func() {
		if !ready {
			child.Process.Kill()
			<-exited
		}
	}()
	_, err = backoff.Retry(
		startupCtx,
		func() (bool, error) {
			var finished bool

			select {
			case <-exited:
				finished = true
			default:
			}

			response, err := installed.controlRelay(startupCtx, "status")
			if err == nil {
				response.Body.Close()
				// Another launcher may have started the relay first. Stop our
				// unused child in that case.
				ready = response.Header.Get("X-AgentZ-Relay-Pid") == strconv.Itoa(child.Process.Pid)
				return true, nil
			}
			if errors.Is(err, errRelayOwnership) {
				return false, backoff.Permanent(err)
			}
			if !finished {
				return false, err
			}
			if childErr == nil {
				childErr = errors.New("relay exited before becoming ready")
			}
			output, readErr := io.ReadAll(io.NewSectionReader(log, info.Size(), 4<<10))
			err = fmt.Errorf("%w\n%s", errors.Join(childErr, readErr), strings.TrimSpace(string(output)))
			return false, backoff.Permanent(err)
		},
		backoff.WithBackOff(backoff.NewConstantBackOff(100*time.Millisecond)),
	)
	if err != nil {
		return fmt.Errorf("start relay at %s: %w\nRelay log: %s", installed.address, err, logPath)
	}
	return nil
}

func (installed *installation) controlRelay(ctx context.Context, operation string) (*http.Response, error) {
	method := http.MethodGet
	if operation == "stop" {
		method = http.MethodPost
	}
	request, err := http.NewRequestWithContext(ctx, method, installed.address+"/relay/"+operation, nil)
	if err != nil {
		return nil, err
	}
	nonce := strconv.FormatInt(time.Now().Unix(), 10) + ":" + rand.Text()
	message := operation + ":" + nonce
	signature := hmac.New(sha256.New, []byte(installed.ownerKey))
	signature.Write([]byte(message))
	request.Header.Set("X-AgentZ-Relay-Nonce", nonce)
	request.Header.Set("Authorization", "AgentZ-HMAC "+hex.EncodeToString(signature.Sum(nil)))
	// Idle probe connections can otherwise keep Shutdown waiting for headers.
	client := &http.Client{
		Transport:     &http.Transport{DisableKeepAlives: true},
		Timeout:       time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("AgentZ relay is unavailable: %w", err)
	}
	signature.Reset()
	signature.Write([]byte("response:" + message))
	expected := hex.EncodeToString(signature.Sum(nil))
	proof := response.Header.Get("X-AgentZ-Relay-Proof")
	if response.StatusCode != http.StatusOK || !hmac.Equal([]byte(proof), []byte(expected)) {
		response.Body.Close()
		return nil, fmt.Errorf("relay at %s: %w", installed.address, errRelayOwnership)
	}
	return response, nil
}
