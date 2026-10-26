package launcher

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/cli/browser"
	"github.com/sourcegraph/jsonrpc2"
	"github.com/urfave/cli/v3"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// Codex's generic instructions are fetched alongside its pinned protocol.
// Known models retain their version-matched instructions from the binary.
//
//go:embed codex_prompt.gen.md
var codexInstructions string

// codexTransport joins the app-server pipes for the JSON-RPC client.
type codexTransport struct {
	io.Reader
	io.WriteCloser
}

type codexCatalog struct {
	Models []json.RawMessage `json:"models"`
}

type codexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

type codexTruncation struct {
	Mode  string `json:"mode"`
	Limit int    `json:"limit"`
}

// Unknown models follow Codex 0.162.1's model_info_from_slug fallback.
// Codex fills in omitted fields. Apps usage must be false to match its
// fallback, since deserialization otherwise enables it.
type codexModel struct {
	Slug                         string                `json:"slug"`
	DisplayName                  string                `json:"display_name"`
	SupportedReasoningLevels     []codexReasoningLevel `json:"supported_reasoning_levels"`
	ShellType                    string                `json:"shell_type"`
	Visibility                   string                `json:"visibility"`
	SupportedInAPI               bool                  `json:"supported_in_api"`
	Priority                     int32                 `json:"priority"`
	SupportVerbosity             bool                  `json:"support_verbosity"`
	IncludeAppsUsageInstructions bool                  `json:"include_apps_usage_instructions"`
	TruncationPolicy             codexTruncation       `json:"truncation_policy"`
	ExperimentalSupportedTools   []string              `json:"experimental_supported_tools"`
	ContextWindow                int64                 `json:"context_window"`
	MaxContextWindow             int64                 `json:"max_context_window"`
	BaseInstructions             string                `json:"base_instructions"`
}

func (installed *installation) codex(ctx context.Context, command *cli.Command, args []string) error {
	profile := filepath.Join(installed.profile, "codex")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}

	environment := slices.DeleteFunc(os.Environ(), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		return name == "CODEX_HOME" || name == "CODEX_API_KEY" || strings.HasPrefix(name, "OPENAI_")
	})
	environment = append(environment, "CODEX_HOME="+profile)

	// JSON strings are valid TOML basic strings, including Windows paths.
	client, _ := json.Marshal(installed.ClientID)
	authorize, _ := json.Marshal(installed.upstream.String() + "/api/auth/oauth2/authorize?prompt=consent")
	token, _ := json.Marshal(installed.address + "/oauth/token")
	resource, _ := json.Marshal(installed.upstream.String() + "/api/inference/v1")
	mcpURL, _ := json.Marshal(installed.upstream.String() + "/api/mcp")
	provider := fmt.Sprintf(`model_providers.agentz={
		name="AgentZ",
		base_url=%s,
		wire_api="responses",
		request_max_retries=0,
		stream_max_retries=0,
		requires_openai_auth=false,
		supports_websockets=false,
		gateway_oauth={
			authorization_url=%s,
			token_url=%s,
			client_id=%s,
			resource=%s,
			scopes=["openid","profile","email","offline_access","inference:use"],
			redirect_port=8766,
			delivery={kind="header",name="X-AgentZ-Authorization",scheme="Bearer"},
		},
	}`, resource, authorize, token, client, resource)
	mcp := fmt.Sprintf(`mcp_servers.agentz={
		url=%s,
		scopes=["mcp:use","offline_access"],
		oauth={
			client_id=%s,
			callback_port=8767,
			callback_url="http://127.0.0.1:8767/callback",
		},
	}`, mcpURL, client)
	flags := []string{
		"-c", `model_provider="agentz"`,
		"-c", `web_search="disabled"`,
		"-c", "mcp_oauth_callback_port=8767", "-c", provider, "-c", mcp,
	}

	mcpCommand := len(args) > 0 && args[0] == "mcp"
	// MCP owns a separate OAuth grant and does not need an inference login.
	if !mcpCommand {
		cache := filepath.Join(installed.profile, "codex-catalog.json")
		data, err := os.ReadFile(cache)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("read approved models: %w", err)
		}
		// Cached models let normal launches skip the login controller.
		// Codex refreshes its own credentials.
		if command.Name == "login" || errors.Is(err, os.ErrNotExist) {
			if err := installed.codexLogin(ctx, command, flags, environment); err != nil {
				return err
			}
			data, err = os.ReadFile(cache)
		}
		if err != nil {
			return fmt.Errorf("read approved models: %w\nRun 'agentz login codex' with the same --profile", err)
		}
		var approved gatewayapi.DelegationCatalog
		if err := json.Unmarshal(data, &approved); err != nil {
			return fmt.Errorf("read approved models: %w", err)
		}
		modelFile := filepath.Join(profile, "models.json")
		model, err := installed.codexModels(ctx, approved, modelFile, environment)
		if err != nil {
			return err
		}
		if command.Name == "login" {
			fmt.Fprintln(command.Writer, "Codex is connected.")
			return nil
		}
		modelJSON, _ := json.Marshal(model)
		fileJSON, _ := json.Marshal(modelFile)
		flags = append(flags, "-c", "model="+string(modelJSON), "-c", "model_catalog_json="+string(fileJSON))
	}
	flags = append(flags, args...)
	child := exec.CommandContext(ctx, "codex", flags...)
	child.Env = environment
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, command.Writer, command.ErrWriter
	if err := child.Run(); err != nil {
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return cli.Exit("Codex exited.", exit.ExitCode())
		}
		return err
	}
	return nil
}

func (installed *installation) codexLogin(ctx context.Context, command *cli.Command, flags, environment []string) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	args := append([]string{"app-server", "--strict-config"}, flags...)
	child := exec.CommandContext(ctx, "codex", args...)
	child.Env, child.Stderr = environment, command.ErrWriter
	input, err := child.StdinPipe()
	if err != nil {
		return err
	}
	output, err := child.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	if err := child.Start(); err != nil {
		input.Close()
		output.Close()
		return err
	}
	defer func() {
		input.Close()
		cancel()
		child.Wait()
	}()
	defer output.Close()
	handler := jsonrpc2.HandlerWithError(func(_ context.Context, _ *jsonrpc2.Conn, request *jsonrpc2.Request) (any, error) {
		if request.Method != "account/gatewayOAuth/changed" || request.Params == nil {
			return nil, nil
		}
		var changed GatewayOAuthChangedNotification
		if err := json.Unmarshal(*request.Params, &changed); err != nil {
			return nil, err
		}
		if changed.AuthUrl != nil {
			fmt.Fprintln(command.Writer, "Sign in to Codex in your browser:", *changed.AuthUrl)
			// SSH users can open the printed URL on their own machine.
			if runtime.GOOS != "linux" || os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
				go func() { browser.OpenURL(*changed.AuthUrl) }()
			}
		}
		return nil, nil
	})
	stream := jsonrpc2.NewPlainObjectStream(codexTransport{Reader: output, WriteCloser: input})
	conn := jsonrpc2.NewConn(ctx, stream, handler)
	defer conn.Close()
	// Codex accepts a JSON-RPC version field but leaves it out of replies.
	// The JSON-RPC client supports both forms.
	initialize := InitializeParams{
		ClientInfo: ClientInfo{Name: "agentz", Version: command.Root().Version},
		Capabilities: &InitializeParamsCapabilities{
			ExperimentalApi:      true,
			ExplicitGatewayOauth: new(true),
		},
	}
	if err := conn.Call(ctx, "initialize", initialize, nil); err != nil {
		return err
	}
	if err := conn.Notify(ctx, "initialized", nil); err != nil {
		return err
	}
	var state GatewayOAuthReadResponse
	if err := conn.Call(ctx, "account/gatewayOAuth/read", nil, &state); err != nil {
		return err
	}
	if !state.Required {
		return errors.New("codex did not select the AgentZ OAuth provider")
	}
	return conn.Call(ctx, "account/gatewayOAuth/login", nil, nil)
}

func (installed *installation) codexModels(ctx context.Context, approved gatewayapi.DelegationCatalog, name string, environment []string) (string, error) {
	child := exec.CommandContext(ctx, "codex", "debug", "models", "--bundled")
	child.Env = environment
	data, err := child.Output()
	if err != nil {
		return "", fmt.Errorf("read Codex's version-matched model catalog: %w", err)
	}
	var bundled codexCatalog
	if err := json.Unmarshal(data, &bundled); err != nil {
		return "", err
	}
	catalog := codexCatalog{Models: []json.RawMessage{}}
	first := ""
	for _, selected := range approved.Models {
		if selected.ModelInfo == nil || selected.ApiCompatibility == nil {
			continue
		}
		supported := slices.ContainsFunc(*selected.ApiCompatibility, func(api gatewayapi.DelegationAPICompatibility) bool {
			return api.Api == gatewayapi.Responses && api.Support == gatewayapi.DelegationAPICompatibilitySupportNative
		})
		if !supported || !selected.ModelInfo.Capabilities.ToolCall {
			continue
		}
		var entry json.RawMessage
		for _, raw := range bundled.Models {
			var native codexModel
			if err := json.Unmarshal(raw, &native); err != nil {
				return "", err
			}
			if native.Slug != selected.Model {
				continue
			}
			// Keep Codex's settings. Change the routing ID and show approved models.
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil {
				return "", err
			}
			fields["slug"], _ = json.Marshal(selected.Id)
			fields["visibility"] = json.RawMessage(`"list"`)
			entry, err = json.Marshal(fields)
			if err != nil {
				return "", err
			}
			break
		}
		if entry == nil {
			model := codexModel{
				Slug:                       selected.Id,
				DisplayName:                selected.ModelDisplayName,
				SupportedReasoningLevels:   []codexReasoningLevel{},
				ShellType:                  "unified_exec",
				Visibility:                 "list",
				SupportedInAPI:             true,
				Priority:                   99,
				TruncationPolicy:           codexTruncation{Mode: "bytes", Limit: 10000},
				ExperimentalSupportedTools: []string{},
				ContextWindow:              272000,
				MaxContextWindow:           272000,
				BaseInstructions:           codexInstructions,
			}
			entry, err = json.Marshal(model)
			if err != nil {
				return "", err
			}
		}
		if first == "" {
			first = selected.Id
		}
		catalog.Models = append(catalog.Models, entry)
	}
	if first == "" {
		return "", errors.New(
			"no approved model can run Codex tools. Run 'agentz login codex' and select a model with native Responses support",
		)
	}
	data, err = json.Marshal(catalog)
	if err != nil {
		return "", err
	}
	return first, writeProfileFile(name, data)
}
