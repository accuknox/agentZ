package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/cli/browser"
	"github.com/gofrs/flock"
	"github.com/tailscale/hujson"
	"github.com/tmaxmax/go-sse"
	"github.com/urfave/cli/v3"
	"golang.org/x/oauth2"
	"gomodules.xyz/jsonpatch/v2"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type copilotProvider struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	BaseURL   string `json:"baseUrl"`
	APIKey    string `json:"apiKey"`
	WireAPI   string `json:"wireApi,omitempty"`
	Transport string `json:"transport"`
}

type copilotModel struct {
	ID                     string              `json:"id"`
	Provider               string              `json:"provider"`
	Name                   string              `json:"name"`
	WireModel              string              `json:"wireModel"`
	ModelID                string              `json:"modelId"`
	MaxPromptTokens        *int32              `json:"maxPromptTokens,omitempty"`
	MaxContextWindowTokens int32               `json:"maxContextWindowTokens,omitempty"`
	MaxOutputTokens        int32               `json:"maxOutputTokens,omitempty"`
	Capabilities           copilotCapabilities `json:"capabilities"`
}

type copilotCapabilities struct {
	Supports copilotSupport `json:"supports"`
	Limits   copilotLimits  `json:"limits"`
}

type copilotLimits struct {
	Prompt  *int32 `json:"max_prompt_tokens,omitempty"`
	Context int32  `json:"max_context_window_tokens,omitempty"`
	Output  int32  `json:"max_output_tokens,omitempty"`
}

type copilotSupport struct {
	Vision    bool `json:"vision"`
	ToolCalls bool `json:"toolCalls"`
	Streaming bool `json:"streaming"`
}

type copilotRegistry struct {
	Providers []copilotProvider `json:"providers"`
	Models    []copilotModel    `json:"models"`
}

type copilotServer struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Tools   []string          `json:"tools"`
}

type copilotOutput struct {
	OutputIndex int               `json:"output_index"`
	Item        json.RawMessage   `json:"item"`
	Response    copilotCompletion `json:"response"`
}

type copilotCompletion struct {
	Output []json.RawMessage `json:"output"`
}

// copilotStream retains completed items when subscription backends omit them
// from response.completed. Copilot renders deltas but its native telemetry
// reads the completed response. Only observed output items are restored.
type copilotStream struct {
	io.ReadCloser
	next  func() (sse.Event, error, bool)
	stop  func()
	data  []byte
	items map[int]json.RawMessage
	size  int
}

// Read preserves streamed events and retains items for the terminal response.
func (stream *copilotStream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(stream.data) == 0 {
		frame, err, ok := stream.next()
		if err != nil {
			return 0, err
		}
		if !ok {
			return 0, io.EOF
		}
		if frame.Type == "response.output_item.done" || frame.Type == "response.completed" {
			var output copilotOutput
			if err := json.Unmarshal([]byte(frame.Data), &output); err != nil {
				return 0, err
			}
			if frame.Type == "response.output_item.done" {
				stream.size += len(output.Item) - len(stream.items[output.OutputIndex])
				if stream.size > 32<<20 {
					return 0, errors.New("response exceeds the Copilot relay limit")
				}
				stream.items[output.OutputIndex] = output.Item
			}
			if frame.Type == "response.completed" && len(output.Response.Output) == 0 && len(stream.items) > 0 {
				items := make([]json.RawMessage, 0, len(stream.items))
				for _, index := range slices.Sorted(maps.Keys(stream.items)) {
					items = append(items, stream.items[index])
				}
				data, err := json.Marshal(items)
				if err != nil {
					return 0, err
				}
				var envelope map[string]json.RawMessage
				if err := json.Unmarshal([]byte(frame.Data), &envelope); err != nil {
					return 0, err
				}
				var response map[string]json.RawMessage
				if err := json.Unmarshal(envelope["response"], &response); err != nil {
					return 0, err
				}
				if response == nil {
					return 0, errors.New("missing completed Copilot response")
				}
				response["output"] = data
				envelope["response"], err = json.Marshal(response)
				if err != nil {
					return 0, err
				}
				data, err = json.Marshal(envelope)
				if err != nil {
					return 0, err
				}
				frame.Data = string(data)
			}
		}
		var message sse.Message
		message.AppendData(frame.Data)
		message.Type, err = sse.NewType(frame.Type)
		if err != nil {
			return 0, err
		}
		message.ID, err = sse.NewID(frame.LastEventID)
		if err != nil {
			return 0, err
		}
		stream.data, err = message.MarshalText()
		if err != nil {
			return 0, err
		}
	}
	n := copy(p, stream.data)
	stream.data = stream.data[n:]
	return n, nil
}

// Close releases the upstream body and the suspended SSE iterator.
func (stream *copilotStream) Close() error {
	err := stream.ReadCloser.Close()
	stream.stop()
	return err
}

func (installed *installation) copilot(ctx context.Context, command *cli.Command, args []string) error {
	if command.Name == "login" {
		resource := "inference"
		if slices.Equal(args, []string{"--mcp"}) {
			resource = "mcp"
			args = nil
		}
		if len(args) != 0 {
			return errors.New("usage: agentz login copilot [--profile NAME] [--mcp]")
		}
		return installed.copilotLogin(ctx, command, resource)
	}
	// Native management commands must work before model consent, including an
	// MCP-only setup. Inference authentication is needed only for conversations.
	management := false
	if len(args) > 0 {
		switch args[0] {
		case "login", "mcp", "help", "config", "completion", "version", "update", "sessions", "memories", "plugin", "skill", "instruction", "lsp", "sandbox", "--help", "-h", "--version":
			management = true
		}
	}
	profile := filepath.Join(installed.profile, "copilot")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}
	var registry copilotRegistry
	if !management {
		_, err := os.Stat(filepath.Join(installed.profile, "inference-oauth.json"))
		if errors.Is(err, os.ErrNotExist) {
			if err := installed.copilotLogin(ctx, command, "inference"); err != nil {
				return err
			}
		}
		token, err := installed.copilotToken(ctx, "inference")
		if err != nil {
			return err
		}
		httpClient := &http.Client{
			Timeout:       20 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		client, err := gatewayapi.NewClientWithResponses(installed.upstream.String(), gatewayapi.WithHTTPClient(httpClient))
		if err != nil {
			return err
		}
		catalog, err := client.GetDelegatedCatalogWithResponse(ctx, func(_ context.Context, r *http.Request) error {
			r.Header.Set("Authorization", "Bearer "+token)
			return nil
		})
		if err != nil {
			return errors.New("AgentZ model catalog is unavailable")
		}
		if catalog.JSON200 == nil {
			if catalog.StatusCode() == http.StatusUnauthorized || catalog.StatusCode() == http.StatusForbidden {
				return errors.New("AgentZ model access was revoked. Reconnect with agentz login copilot using the same --profile")
			}
			return fmt.Errorf("AgentZ model discovery is unavailable (HTTP %d). Try launching again", catalog.StatusCode())
		}
		for _, model := range catalog.JSON200.Models {
			if model.ModelInfo == nil || !model.ModelInfo.Capabilities.ToolCall || model.ApiCompatibility == nil {
				continue
			}
			provider, rank := "", 6
			// Native protocols preserve provider-specific tools and reasoning.
			// Responses conversion is deliberately excluded for that reason.
			for _, compatibility := range *model.ApiCompatibility {
				if compatibility.Support == gatewayapi.DelegationAPICompatibilitySupportUnsupported {
					continue
				}
				candidate, score := "", 6
				switch compatibility.Api {
				case gatewayapi.Responses:
					if compatibility.Support != gatewayapi.DelegationAPICompatibilitySupportNative {
						continue
					}
					candidate, score = "agentz-responses", 0
				case gatewayapi.Messages:
					candidate, score = "agentz-messages", 1
					if compatibility.Support == gatewayapi.DelegationAPICompatibilitySupportTranslated {
						score = 4
					}
				case gatewayapi.ChatCompletions:
					candidate, score = "agentz-chat", 2
					if compatibility.Support == gatewayapi.DelegationAPICompatibilitySupportTranslated {
						score = 3
					}
				}
				if score < rank {
					provider, rank = candidate, score
				}
			}
			if provider == "" {
				continue
			}
			configured := slices.ContainsFunc(registry.Providers, func(connection copilotProvider) bool {
				return connection.Name == provider
			})
			if !configured {
				connection := copilotProvider{
					Name:      provider,
					Type:      "openai",
					BaseURL:   installed.address + "/v1",
					APIKey:    installed.clientKey,
					Transport: "http",
				}
				switch provider {
				case "agentz-responses":
					connection.WireAPI = "responses"
				case "agentz-messages":
					connection.Type = "anthropic"
					connection.BaseURL = installed.address
				case "agentz-chat":
					connection.WireAPI = "completions"
				}
				registry.Providers = append(registry.Providers, connection)
			}
			registry.Models = append(registry.Models, copilotModel{
				ID:                     model.Id,
				Provider:               provider,
				Name:                   model.ModelDisplayName,
				WireModel:              model.Id,
				ModelID:                model.Model,
				MaxPromptTokens:        model.ModelInfo.Limits.Input,
				MaxContextWindowTokens: model.ModelInfo.Limits.Context,
				MaxOutputTokens:        model.ModelInfo.Limits.Output,
				Capabilities: copilotCapabilities{
					Limits: copilotLimits{
						Prompt:  model.ModelInfo.Limits.Input,
						Context: model.ModelInfo.Limits.Context,
						Output:  model.ModelInfo.Limits.Output,
					},
					Supports: copilotSupport{
						Vision:    slices.Contains(model.ModelInfo.Modalities.Input, gatewayapi.InferenceModelModalityImage),
						ToolCalls: true,
						Streaming: true,
					},
				},
			})
		}
		if len(registry.Models) == 0 {
			return errors.New("no approved model supports Copilot tool calls. Run agentz login copilot and select a compatible model")
		}
		data, err := json.MarshalIndent(registry, "", "  ")
		if err != nil {
			return err
		}
		if err := writeProfileFile(filepath.Join(profile, "providers.json"), data); err != nil {
			return err
		}
	}
	_, err := os.Stat(filepath.Join(installed.profile, "mcp-oauth.json"))
	if err == nil {
		path := filepath.Join(profile, "mcp-config.json")
		data, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if errors.Is(err, os.ErrNotExist) {
			data = []byte(`{}`)
		}
		config, err := hujson.Parse(data)
		if err != nil {
			return fmt.Errorf("read Copilot MCP configuration: %w", err)
		}
		// Native MCP commands read this file, including its comments. Patch
		// only our server so user and plugin configuration remain native-owned.
		patch := make([]jsonpatch.Operation, 0, 2)
		if config.Find("/mcpServers") == nil {
			patch = append(patch, jsonpatch.Operation{
				Operation: "add",
				Path:      "/mcpServers",
				Value:     map[string]copilotServer{},
			})
		}
		patch = append(patch, jsonpatch.Operation{
			Operation: "add",
			Path:      "/mcpServers/agentz",
			Value: copilotServer{
				Type:    "http",
				URL:     installed.address + "/mcp",
				Headers: map[string]string{"Authorization": "Bearer " + installed.clientKey},
				Tools:   []string{"*"},
			},
		})
		data, err = json.Marshal(patch)
		if err != nil {
			return err
		}
		if err := config.Patch(data); err != nil {
			return fmt.Errorf("configure AgentZ MCP: %w", err)
		}
		if err := writeProfileFile(path, config.Pack()); err != nil {
			return err
		}
	}
	flags := append([]string{"--disable-builtin-mcps"}, args...)
	environment := slices.DeleteFunc(os.Environ(), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		switch name {
		case "COPILOT_HOME", "COPILOT_MODEL", "COPILOT_OFFLINE",
			"COPILOT_API_URL", "GITHUB_COPILOT_API_TOKEN", "OLLAMA_HOST":
			return true
		}
		return strings.HasPrefix(name, "COPILOT_PROVIDER") || strings.HasPrefix(name, "OTEL_") ||
			strings.HasPrefix(name, "COPILOT_OTEL_")
	})
	environment = append(environment,
		"COPILOT_HOME="+profile,
		"COPILOT_PROVIDERS_CONFIG="+filepath.Join(profile, "providers.json"),
		// Keep GitHub authentication available for repository features while
		// routing Copilot's own inference and discovery through this relay too.
		"COPILOT_API_URL="+installed.address+"/v1",
		"GITHUB_COPILOT_API_TOKEN="+installed.clientKey,
		// Native discovery must not add a direct local inference provider.
		"OLLAMA_HOST="+installed.address,
		"COPILOT_OTEL_ENABLED=true",
		"OTEL_EXPORTER_OTLP_ENDPOINT="+installed.address,
		"OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		"OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer "+installed.clientKey,
		"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
	)
	if len(registry.Models) > 0 {
		// Use the native settings command so JSONC and future settings changes
		// stay Copilot's responsibility. Preserve an approved saved selection.
		settings := exec.CommandContext(ctx, "copilot", "config", "model")
		settings.Env = environment
		data, err := settings.Output()
		if err != nil {
			exit, ok := errors.AsType[*exec.ExitError](err)
			if !ok || exit.ExitCode() != 1 {
				return fmt.Errorf("read Copilot model setting: %w", err)
			}
		}
		configured := strings.TrimSpace(string(data))
		approved := slices.ContainsFunc(registry.Models, func(model copilotModel) bool {
			return configured == model.Provider+"/"+model.ID
		})
		if !approved {
			model := registry.Models[0]
			environment = append(environment, "COPILOT_MODEL="+model.Provider+"/"+model.ID)
		}
	}
	child := exec.CommandContext(ctx, "copilot", flags...)
	child.Env = environment
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, command.Writer, command.ErrWriter
	if err := child.Run(); err != nil {
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return cli.Exit("Copilot exited.", exit.ExitCode())
		}
		return err
	}
	return nil
}

func (installed *installation) copilotLogin(ctx context.Context, command *cli.Command, resource string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	scope := "inference:use"
	if resource == "mcp" {
		scope = "mcp:use"
	}
	config := oauth2.Config{
		ClientID: installed.ClientID,
		Scopes:   []string{"openid", "profile", "email", "offline_access", scope},
		Endpoint: oauth2.Endpoint{
			DeviceAuthURL: installed.upstream.String() + "/api/auth/device/code",
			TokenURL:      installed.upstream.String() + "/api/auth/oauth2/token",
			AuthStyle:     oauth2.AuthStyleInParams,
		},
	}
	resourceURL := installed.upstream.String() + "/api/inference/v1"
	if resource == "mcp" {
		resourceURL = installed.upstream.String() + "/api/mcp"
	}
	device, err := config.DeviceAuth(ctx, oauth2.SetAuthURLParam("resource", resourceURL))
	if err != nil {
		return errors.New("AgentZ sign-in is unavailable. Check the server and client ID")
	}
	fmt.Fprintf(command.ErrWriter, "Sign in for %s at %s\nCode: %s\n", resource, device.VerificationURI, device.UserCode)
	if device.VerificationURIComplete != "" {
		_ = browser.OpenURL(device.VerificationURIComplete)
	}
	token, err := config.DeviceAccessToken(ctx, device, oauth2.SetAuthURLParam("resource", resourceURL))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("AgentZ sign-in was denied or expired. Run agentz login copilot again")
	}
	if !token.Valid() || token.Expiry.IsZero() || !strings.EqualFold(token.TokenType, "Bearer") {
		return errors.New("AgentZ returned an invalid OAuth credential")
	}
	lock := flock.New(filepath.Join(installed.profile, resource+"-oauth.lock"))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil || !locked {
		return fmt.Errorf("lock AgentZ credential: %w", errors.Join(err, ctx.Err()))
	}
	defer lock.Close()
	data, err := json.Marshal(token)
	if err != nil {
		return err
	}
	if err := writeProfileFile(filepath.Join(installed.profile, resource+"-oauth.json"), data); err != nil {
		return err
	}
	fmt.Fprintf(command.ErrWriter, "AgentZ %s connected.\n", resource)
	return nil
}

func (installed *installation) copilotToken(ctx context.Context, resource string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	login := "agentz login copilot --profile NAME"
	if resource == "mcp" {
		login += " --mcp"
	}
	lock := flock.New(filepath.Join(installed.profile, resource+"-oauth.lock"))
	locked, err := lock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil || !locked {
		return "", fmt.Errorf("lock AgentZ credential: %w", errors.Join(err, ctx.Err()))
	}
	defer lock.Close()
	path := filepath.Join(installed.profile, resource+"-oauth.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("sign in for %s with %s", resource, login)
	}
	var stored oauth2.Token
	if err := json.Unmarshal(data, &stored); err != nil || stored.Expiry.IsZero() || !strings.EqualFold(stored.TokenType, "Bearer") {
		return "", fmt.Errorf("invalid AgentZ OAuth credential. Reconnect with %s", login)
	}
	client := &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	config := oauth2.Config{
		ClientID: installed.ClientID,
		Endpoint: oauth2.Endpoint{
			TokenURL:  installed.upstream.String() + "/api/auth/oauth2/token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
	// Each grant contains exactly one resource. Better Auth retains that
	// resource on refresh when the OAuth client omits the resource parameter.
	refresh := &oauth2.Token{RefreshToken: stored.RefreshToken}
	source := oauth2.ReuseTokenSourceWithExpiry(&stored, config.TokenSource(ctx, refresh), 30*time.Second)
	token, err := source.Token()
	if err != nil {
		return "", fmt.Errorf("AgentZ authorization expired or was revoked. Reconnect with %s", login)
	}
	changed := token.AccessToken != stored.AccessToken || token.RefreshToken != stored.RefreshToken
	if changed || !token.Expiry.Equal(stored.Expiry) {
		data, err := json.Marshal(token)
		if err != nil {
			return "", err
		}
		if err := writeProfileFile(path, data); err != nil {
			return "", err
		}
	}
	return token.AccessToken, nil
}
