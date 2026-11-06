package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/urfave/cli/v3"
)

func adapterResource(args []string) (string, error) {
	if len(args) == 0 {
		return "inference", nil
	}
	if slices.Equal(args, []string{"--mcp"}) {
		return "mcp", nil
	}
	return "", errors.New("usage: agentz login PROVIDER [--profile NAME] [-- --mcp]")
}

func (installed *installation) adapterCatalog(ctx context.Context) (*gatewayapi.DelegationCatalog, error) {
	token, err := installed.accessToken(ctx, "inference")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	client, err := gatewayapi.NewClientWithResponses(installed.upstream.String(), gatewayapi.WithHTTPClient(&http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}))
	if err != nil {
		return nil, err
	}
	response, err := client.GetDelegatedCatalogWithResponse(ctx, func(_ context.Context, r *http.Request) error {
		r.Header.Set("Authorization", "Bearer "+token)
		return nil
	})
	if err != nil {
		return nil, errors.New("AgentZ model catalog is unavailable")
	}
	if response.JSON200 == nil {
		return nil, fmt.Errorf("AgentZ rejected model discovery (HTTP %d); reconnect this profile", response.StatusCode())
	}
	return response.JSON200, nil
}

func compatibleModels(catalog *gatewayapi.DelegationCatalog, api gatewayapi.InferenceModelAPI, claudeOnly bool) []gatewayapi.DelegationModel {
	models := []gatewayapi.DelegationModel{}
	for _, model := range catalog.Models {
		if model.ModelInfo == nil || !model.ModelInfo.Capabilities.ToolCall || model.ApiCompatibility == nil {
			continue
		}
		if claudeOnly && !strings.HasPrefix(model.Model, "claude-") {
			continue
		}
		if slices.ContainsFunc(*model.ApiCompatibility, func(item gatewayapi.DelegationAPICompatibility) bool {
			return item.Api == api && item.Support != gatewayapi.DelegationAPICompatibilitySupportUnsupported
		}) {
			models = append(models, model)
		}
	}
	return models
}

func (installed *installation) copilot(ctx context.Context, command *cli.Command, args []string) error {
	if command.Name == "login" {
		resource, err := adapterResource(args)
		if err != nil {
			return err
		}
		return installed.loginAdapter(ctx, command.Writer, resource)
	}
	if _, err := os.Stat(filepath.Join(installed.profile, "inference-oauth.json")); errors.Is(err, os.ErrNotExist) {
		if err := installed.loginAdapter(ctx, command.Writer, "inference"); err != nil {
			return err
		}
	}
	catalog, err := installed.adapterCatalog(ctx)
	if err != nil {
		return err
	}
	models := copilotModels(catalog)
	if len(models) == 0 {
		return errors.New("no approved model supports native Responses or Messages tool calls; reconnect and select a supported model")
	}
	if err := installed.ensureRelay(ctx); err != nil {
		return err
	}
	profile := filepath.Join(installed.profile, "copilot")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}
	// An isolated, empty registry ensures that native BYOK environment settings
	// cannot be shadowed by a user's unrelated providers.json.
	if err := writeProfileFile(filepath.Join(profile, "providers.json"), []byte(`{"providers":[],"models":[]}`)); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(installed.profile, "mcp-oauth.json")); err == nil {
		data, err := json.Marshal(installed.mcpConfig())
		if err != nil {
			return err
		}
		if err := writeProfileFile(filepath.Join(profile, "mcp-config.json"), data); err != nil {
			return err
		}
	}
	providerType, wireAPI := "openai", "responses"
	if !nativeAPI(models[0], gatewayapi.Responses) {
		providerType, wireAPI = "anthropic", "completions"
	}
	environment := copilotEnvironment(os.Environ())
	baseURL := installed.address + "/v1"
	if providerType == "anthropic" {
		baseURL = installed.address
	}
	environment = append(environment,
		"COPILOT_HOME="+profile, "COPILOT_PROVIDERS_CONFIG="+filepath.Join(profile, "providers.json"),
		"COPILOT_PROVIDER_TYPE="+providerType, "COPILOT_PROVIDER_WIRE_API="+wireAPI, "COPILOT_PROVIDER_TRANSPORT=http",
		"COPILOT_PROVIDER_BASE_URL="+baseURL,
		"COPILOT_PROVIDER_API_KEY="+installed.clientKey(),
		"COPILOT_MODEL="+models[0].Id,
		"COPILOT_PROVIDER_MODEL_ID="+models[0].Model, "COPILOT_PROVIDER_WIRE_MODEL="+models[0].Id,
	)
	child := exec.CommandContext(ctx, "copilot", append([]string{"--disable-builtin-mcps"}, args...)...)
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

func copilotEnvironment(environment []string) []string {
	return slices.DeleteFunc(slices.Clone(environment), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		return strings.HasPrefix(name, "COPILOT_PROVIDER_") || name == "COPILOT_PROVIDERS_CONFIG" || name == "COPILOT_HOME" || name == "COPILOT_MODEL"
	})
}

func (installed *installation) mcpConfig() map[string]any {
	return map[string]any{"mcpServers": map[string]any{"agentz": map[string]any{
		"type": "http", "url": installed.address + "/mcp", "headers": map[string]string{"Authorization": "Bearer " + installed.clientKey()}, "tools": []string{"*"},
	}}}
}

// Desktop setup exports native provider settings without modifying an existing
// application's account, machine policy, or preferences. The app's supported
// import/provider UI applies the connection; the relay retains OAuth refresh.
func (installed *installation) desktop(ctx context.Context, command *cli.Command, args []string) error {
	if command.Name == "login" {
		resource, err := adapterResource(args)
		if err != nil {
			return err
		}
		return installed.loginAdapter(ctx, command.Writer, resource)
	}
	if len(args) > 0 {
		return errors.New("desktop setup takes no native flags; configure the exported connection in your desktop app")
	}
	if _, err := os.Stat(filepath.Join(installed.profile, "inference-oauth.json")); errors.Is(err, os.ErrNotExist) {
		if err := installed.loginAdapter(ctx, command.Writer, "inference"); err != nil {
			return err
		}
	}
	catalog, err := installed.adapterCatalog(ctx)
	if err != nil {
		return err
	}
	api := gatewayapi.ChatCompletions
	if installed.Provider == "claude-desktop" {
		api = gatewayapi.Messages
	}
	models := compatibleModels(catalog, api, installed.Provider == "claude-desktop")
	if installed.Provider == "github-copilot-desktop" {
		models = copilotModels(catalog)
	}
	if len(models) == 0 {
		return errors.New("no approved model supports this desktop client; reconnect and select a tool-capable model for its API")
	}
	if err := installed.ensureRelay(ctx); err != nil {
		return err
	}
	var config any
	if installed.Provider == "claude-desktop" {
		lineup := []map[string]string{}
		for _, model := range models {
			lineup = append(lineup, map[string]string{"name": model.Id, "labelOverride": model.ModelDisplayName, "behavesAs": model.Model})
		}
		config = map[string]any{
			"$schemaVersion": 2,
			"inference": map[string]any{
				"provider": "gateway", "baseUrl": installed.address, "autoModeServerChecks": false,
				"credential": map[string]string{"kind": "static", "apiKey": installed.clientKey(), "authScheme": "bearer"},
			},
			"models":    map[string]any{"discoveryEnabled": false, "list": lineup},
			"workspace": map[string]bool{"autoModeEnabled": false},
		}
		if _, err := os.Stat(filepath.Join(installed.profile, "mcp-oauth.json")); err == nil {
			executable, err := os.Executable()
			if err != nil {
				return err
			}
			profile, err := filepath.Abs(installed.profile)
			if err != nil {
				return err
			}
			config.(map[string]any)["mcp"] = map[string]any{"managedServers": []map[string]any{{
				"name": "AgentZ", "transport": "http", "url": installed.address + "/mcp",
				"headersHelper":     executable,
				"headersHelperArgs": []string{"relay", "headers", "--profile-directory", profile},
			}}}
		}
	} else {
		providerType, wireAPI, baseURL := "openai", "responses", installed.address+"/v1"
		if !nativeAPI(models[0], gatewayapi.Responses) {
			providerType, wireAPI, baseURL = "anthropic", "messages", installed.address
		}
		config = map[string]any{"name": "AgentZ", "type": providerType, "wireApi": wireAPI, "baseUrl": baseURL, "apiKey": installed.clientKey(), "models": models}
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(installed.profile, "desktop-connection.json")
	if err := writeProfileFile(path, data); err != nil {
		return err
	}
	mcp, err := json.MarshalIndent(installed.mcpConfig(), "", "  ")
	if err != nil {
		return err
	}
	mcpPath := filepath.Join(installed.profile, "desktop-mcp.json")
	if err := writeProfileFile(mcpPath, mcp); err != nil {
		return err
	}
	fmt.Fprintf(command.Writer, "Desktop connection saved to %s\nMCP connection saved to %s\n", path, mcpPath)
	if installed.Provider == "claude-desktop" {
		fmt.Fprintln(command.Writer, "In Claude Desktop: Help > Troubleshooting > Enable Developer Mode, then Developer > Configure Third-Party Inference. Import desktop-connection.json, confirm its name, and Apply Changes. If MCP sign-in is complete, this file also configures AgentZ MCP using the native headers helper. After agentz login with -- --mcp, export and import again to add MCP.")
	} else {
		fmt.Fprintln(command.Writer, "In GitHub Copilot desktop: Settings > Model providers > Add provider. Choose the provider type and wire API in desktop-connection.json, then enter its base URL, local API key, and model. This file is a connection guide, not a native import format. Add the AgentZ MCP connection from desktop-mcp.json after agentz login with -- --mcp. GitHub account sign-in is required by the desktop app.")
	}
	fmt.Fprintln(command.Writer, "The local relay must remain running. Use agentz relay status/stop with the same --profile to manage it. Treat exported local API keys as credentials.")
	return nil
}

func nativeAPI(model gatewayapi.DelegationModel, api gatewayapi.InferenceModelAPI) bool {
	return model.ApiCompatibility != nil && slices.ContainsFunc(*model.ApiCompatibility, func(item gatewayapi.DelegationAPICompatibility) bool {
		return item.Api == api && item.Support == gatewayapi.DelegationAPICompatibilitySupportNative
	})
}

func copilotModels(catalog *gatewayapi.DelegationCatalog) []gatewayapi.DelegationModel {
	models := []gatewayapi.DelegationModel{}
	for _, model := range catalog.Models {
		if model.ModelInfo != nil && model.ModelInfo.Capabilities.ToolCall && (nativeAPI(model, gatewayapi.Responses) || nativeAPI(model, gatewayapi.Messages)) {
			models = append(models, model)
		}
	}
	return models
}
