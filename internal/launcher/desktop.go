package launcher

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

func (installed *installation) chatGPTExecutable() (string, error) {
	if installed.DesktopExecutable != "" {
		binary, err := exec.LookPath(installed.DesktopExecutable)
		if err != nil {
			return "", fmt.Errorf("desktopExecutable is unavailable: %w", err)
		}
		return binary, nil
	}
	if binary, err := exec.LookPath("chatgpt"); err == nil {
		return binary, nil
	}
	if runtime.GOOS == "darwin" {
		for _, path := range []string{"/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", filepath.Join(os.Getenv("HOME"), "Applications/ChatGPT.app/Contents/MacOS/ChatGPT")} {
			if _, err := os.Stat(path); err == nil {
				return path, nil
			}
		}
	}
	return "", errors.New("install ChatGPT desktop and set desktopExecutable to its executable path in this AgentZ profile")
}

// Desktop cannot consume the CLI's -c overrides. Merge the managed connection
// into its isolated native config while preserving user preferences and other
// MCP/provider entries. Invalid existing TOML is never silently replaced.
func saveDesktopCodexConfig(path string, values []string) error {
	config := map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err := toml.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("read ChatGPT desktop configuration: %w", err)
		}
	}
	for _, value := range values {
		update := map[string]any{}
		// CLI overrides allow multiline inline tables; a TOML 1.0 file does not.
		// All values here are generated with JSON-escaped strings, so literal
		// newlines and tabs are formatting, never string content.
		value = strings.NewReplacer("\n", " ", "\t", " ").Replace(value)
		if err := toml.Unmarshal([]byte(value), &update); err != nil {
			return fmt.Errorf("prepare ChatGPT desktop configuration: %w", err)
		}
		for key, v := range update {
			if key == "mcp_servers" || key == "model_providers" {
				old, ok := config[key].(map[string]any)
				if !ok {
					old = map[string]any{}
				}
				for name, entry := range v.(map[string]any) {
					old[name] = entry
				}
				config[key] = old
			} else {
				config[key] = v
			}
		}
	}
	data, err = toml.Marshal(config)
	if err != nil {
		return err
	}
	return writeProfileFile(path, data)
}
