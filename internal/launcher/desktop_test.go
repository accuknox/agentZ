package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestDesktopCodexConfigPreservesPreferences(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	original := `theme="dark"
[model_providers.other]
name="Other"
[mcp_servers.other]
url="https://example.invalid/mcp"
`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	values := []string{`model_provider="agentz"`, `model="approved"`, `model_providers.agentz={name="AgentZ",base_url="https://gateway.invalid/api/inference/v1"}`, `mcp_servers.agentz={
		url="https://gateway.invalid/api/mcp",
		oauth={client_id="test",callback_port=8767}
	}`}
	for range 2 {
		if err := saveDesktopCodexConfig(path, values); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := toml.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config["theme"] != "dark" || config["model_provider"] != "agentz" {
		t.Fatal("preferences or managed provider lost")
	}
	for _, key := range []string{"mcp_servers", "model_providers"} {
		entries := config[key].(map[string]any)
		if len(entries) != 2 || entries["other"] == nil || entries["agentz"] == nil {
			t.Fatalf("lost %s entries", key)
		}
	}
	if strings.Count(string(data), "[model_providers.agentz]") != 1 {
		t.Fatal("non-idempotent config")
	}
}

func TestDesktopCodexConfigRefusesMalformedExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("not valid TOML"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveDesktopCodexConfig(path, []string{`model="approved"`}); err == nil {
		t.Fatal("overwrote malformed existing configuration")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "not valid TOML" {
		t.Fatal("existing configuration changed")
	}
}
