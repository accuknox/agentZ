package launcher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/urfave/cli/v3"
)

type desktopConnection struct {
	SchemaVersion int              `json:"$schemaVersion"`
	Inference     desktopInference `json:"inference"`
	Models        desktopModels    `json:"models"`
	Workspace     desktopWorkspace `json:"workspace"`
	MCP           *desktopMCP      `json:"mcp,omitempty"`
}

type desktopInference struct {
	Provider             string            `json:"provider"`
	BaseURL              string            `json:"baseUrl"`
	AutoModeServerChecks bool              `json:"autoModeServerChecks"`
	Credential           desktopCredential `json:"credential"`
}

type desktopCredential struct {
	Kind       string `json:"kind"`
	APIKey     string `json:"apiKey"`
	AuthScheme string `json:"authScheme"`
}

type desktopModels struct {
	DiscoveryEnabled bool           `json:"discoveryEnabled"`
	List             []desktopModel `json:"list"`
}

type desktopModel struct {
	Name          string `json:"name"`
	LabelOverride string `json:"labelOverride"`
	BehavesAs     string `json:"behavesAs"`
}

type desktopWorkspace struct {
	AutoModeEnabled bool `json:"autoModeEnabled"`
}

type desktopMCP struct {
	ManagedServers []desktopServer `json:"managedServers"`
}

type desktopServer struct {
	Name              string   `json:"name"`
	Transport         string   `json:"transport"`
	URL               string   `json:"url"`
	HeadersHelper     string   `json:"headersHelper"`
	HeadersHelperArgs []string `json:"headersHelperArgs"`
}

func (installed *installation) claudeDesktop(ctx context.Context, command *cli.Command, args []string) error {
	if command.Name == "login" {
		resource := "inference"
		if slices.Equal(args, []string{"--mcp"}) {
			resource, args = "mcp", nil
		}
		if len(args) != 0 {
			return errors.New("desktop login accepts only --mcp")
		}
		return installed.loginDevice(ctx, command, resource)
	}
	if len(args) != 0 {
		return errors.New("desktop setup takes no native flags; import the exported connection in the app")
	}
	token, err := installed.accessToken(ctx, "inference")
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	api, err := gatewayapi.NewClientWithResponses(installed.upstream.String(), gatewayapi.WithHTTPClient(client))
	if err != nil {
		return err
	}
	catalog, err := api.GetDelegatedCatalogWithResponse(ctx, func(_ context.Context, r *http.Request) error {
		r.Header.Set("Authorization", "Bearer "+token)
		return nil
	})
	if err != nil {
		return errors.New("AgentZ model catalog is unavailable")
	}
	if catalog.JSON200 == nil {
		return errors.New("reconnect this profile to approve models")
	}
	config := desktopConnection{
		SchemaVersion: 2,
		Inference: desktopInference{
			Provider: "gateway", BaseURL: installed.address,
			Credential: desktopCredential{
				Kind: "static", APIKey: installed.clientKey, AuthScheme: "bearer",
			},
		},
		Models: desktopModels{List: []desktopModel{}},
	}
	for _, model := range catalog.JSON200.Models {
		if model.ModelInfo == nil || model.ApiCompatibility == nil {
			continue
		}
		if !model.ModelInfo.Capabilities.ToolCall || !strings.HasPrefix(model.Model, "claude-") {
			continue
		}
		for _, compatibility := range *model.ApiCompatibility {
			if compatibility.Api != gatewayapi.Messages || compatibility.Support == gatewayapi.DelegationAPICompatibilitySupportUnsupported {
				continue
			}
			config.Models.List = append(config.Models.List, desktopModel{
				Name: model.Id, LabelOverride: model.ModelDisplayName, BehavesAs: model.Model,
			})
			break
		}
	}
	if len(config.Models.List) == 0 {
		return errors.New("approve a tool-capable Claude model with Messages API support, then reconnect")
	}
	_, err = os.Stat(filepath.Join(installed.profile, "mcp-oauth.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if _, err := installed.accessToken(ctx, "mcp"); err != nil {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		profile, err := filepath.Abs(installed.profile)
		if err != nil {
			return err
		}
		// Claude rejects these characters in helper arguments on every platform.
		if strings.ContainsAny(profile, "\"%") || strings.IndexFunc(profile, unicode.IsControl) >= 0 {
			return errors.New("profile paths for Claude Desktop cannot contain quotes, percent signs or control characters")
		}
		config.MCP = &desktopMCP{ManagedServers: []desktopServer{{
			Name: "AgentZ", Transport: "http", URL: installed.address + "/mcp",
			HeadersHelper:     executable,
			HeadersHelperArgs: []string{"relay", "headers", "--profile-directory", profile},
		}}}
	}
	if err := installed.ensureRelay(ctx); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(installed.profile, "desktop-connection.json")
	if err := writeProfileFile(path, data); err != nil {
		return err
	}
	fmt.Fprintf(command.Writer, "Connection saved to %s\n", path)
	fmt.Fprintln(command.Writer, "In Claude Desktop: Help > Troubleshooting > Enable Developer Mode, then Developer > Configure Third-Party Inference. Import the connection, confirm its name, and Apply Changes.")
	if config.MCP == nil {
		fmt.Fprintln(command.Writer, "For MCP, run agentz login claude-desktop --profile NAME --mcp, then export and import again.")
	}
	fmt.Fprintln(command.Writer, "Keep the relay running. Use agentz relay status/stop with the same profile. The exported file contains a local credential.")
	return nil
}

func writeDesktopHeaders(writer io.Writer, profile string) error {
	if !filepath.IsAbs(profile) {
		return errors.New("--profile-directory must be an absolute AgentZ profile directory")
	}
	key, err := os.ReadFile(filepath.Join(profile, "relay.key"))
	if err != nil {
		return err
	}
	if len(key) < 32 {
		return errors.New("invalid AgentZ relay key")
	}
	capability := sha256.Sum256(append([]byte("agentz-local-client\x00"), key...))
	return json.NewEncoder(writer).Encode(map[string]string{"Authorization": "Bearer " + hex.EncodeToString(capability[:])})
}
