package config

import (
	"fmt"

	"github.com/knadh/koanf/parsers/yaml"
	koanffile "github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

// Config stores the full local agent runtime configuration.
type Config struct {
	Agent  AgentConfig  `koanf:"agent"`
	Model  ModelConfig  `koanf:"model"`
	Memory MemoryConfig `koanf:"memory"`
	Tools  ToolsConfig  `koanf:"tools"`
}

// AgentConfig defines agent identity and prompt settings.
type AgentConfig struct {
	Instruction  string `koanf:"instruction"`
	SystemPrompt string `koanf:"systemPrompt"`
}

// ModelConfig defines the LLM backend and generation settings.
type ModelConfig struct {
	Name        string  `koanf:"name"`
	APIKey      string  `koanf:"apiKey"`
	BaseURL     string  `koanf:"baseURL"`
	Temperature float64 `koanf:"temperature"`
	MaxTokens   int     `koanf:"maxTokens"`
	Stream      bool    `koanf:"stream"`
}

// MemoryConfig configures in-memory recall behavior and tool exposure.
type MemoryConfig struct {
	Enabled bool              `koanf:"enabled"`
	Limit   int               `koanf:"limit"`
	Tools   MemoryToolsConfig `koanf:"tools"`
}

// MemoryToolsConfig controls which memory tools are enabled and exposed.
type MemoryToolsConfig struct {
	Search bool `koanf:"search"`
	Load   bool `koanf:"load"`
	Add    bool `koanf:"add"`
	Update bool `koanf:"update"`
	Delete bool `koanf:"delete"`
	Clear  bool `koanf:"clear"`
}

// ToolsConfig defines tool and toolset configuration.
type ToolsConfig struct {
	HostExec HostExecConfig  `koanf:"hostExec"`
	WebFetch WebFetchConfig  `koanf:"webFetch"`
	File     FileConfig      `koanf:"file"`
	Arxiv    ArxivConfig     `koanf:"arxiv"`
	OpenAPI  []OpenAPIConfig `koanf:"openAPI"`
	MCP      []MCPConfig     `koanf:"mcp"`
}

// HostExecConfig defines host command execution limits.
type HostExecConfig struct {
	Enabled bool              `koanf:"enabled"`
	BaseDir string            `koanf:"baseDir"`
	BaseEnv map[string]string `koanf:"baseEnv"`
}

// WebFetchConfig defines fetch policy and response size limits.
type WebFetchConfig struct {
	Enabled               bool `koanf:"enabled"`
	TimeoutMs             int  `koanf:"timeoutMs"`
	MaxContentLength      int  `koanf:"maxContentLength"`
	MaxTotalContentLength int  `koanf:"maxTotalContentLength"`
}

// FileConfig defines file tool access boundaries.
type FileConfig struct {
	Enabled bool   `koanf:"enabled"`
	BaseDir string `koanf:"baseDir"`
}

// ArxivConfig defines arXiv client behavior.
type ArxivConfig struct {
	Enabled    bool   `koanf:"enabled"`
	BaseURL    string `koanf:"baseURL"`
	PageSize   int    `koanf:"pageSize"`
	DelayMS    int    `koanf:"delayMs"`
	NumRetries int    `koanf:"numRetries"`
}

// OpenAPIConfig defines one OpenAPI-backed toolset entry.
type OpenAPIConfig struct {
	Enabled  bool   `koanf:"enabled"`
	Name     string `koanf:"name"`
	SpecFile string `koanf:"specFile"`
	SpecURL  string `koanf:"specUrl"`
}

// MCPConfig defines one MCP toolset connection.
type MCPConfig struct {
	Enabled             bool              `koanf:"enabled"`
	Name                string            `koanf:"name"`
	Transport           string            `koanf:"transport"`
	ServerURL           string            `koanf:"serverUrl"`
	Command             string            `koanf:"command"`
	Args                []string          `koanf:"args"`
	Headers             map[string]string `koanf:"headers"`
	TimeoutMs           int               `koanf:"timeoutMs"`
	Reconnect           bool              `koanf:"reconnect"`
	ReconnectMaxAttempt int               `koanf:"reconnectMaxAttempts"`
}

// Load reads YAML config from path and applies defaults.
func Load(path string) (Config, error) {
	k := koanf.New(".")
	err := k.Load(koanffile.Provider(path), yaml.Parser())
	if err != nil {
		return Config{}, fmt.Errorf("load config failed: %w", err)
	}

	var cfg Config
	err = k.Unmarshal("", &cfg)
	if err != nil {
		return Config{}, fmt.Errorf("decode config failed: %w", err)
	}

	err = cfg.Validate()
	if err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate checks whether the configuration is internally consistent.
func (c Config) Validate() error {
	if c.Model.Name == "" {
		return fmt.Errorf("model.name is required")
	}

	err := c.validateOpenAPI()
	if err != nil {
		return err
	}

	err = c.validateMCP()
	if err != nil {
		return err
	}
	return nil
}

func (c Config) validateOpenAPI() error {
	for i := range c.Tools.OpenAPI {
		entry := c.Tools.OpenAPI[i]
		if !entry.Enabled {
			continue
		}
		if entry.SpecFile != "" {
			continue
		}
		if entry.SpecURL != "" {
			continue
		}
		return fmt.Errorf("openApi[%d] requires specFile or specUrl", i)
	}
	return nil
}

func (c Config) validateMCP() error {
	for i := range c.Tools.MCP {
		entry := c.Tools.MCP[i]
		if !entry.Enabled {
			continue
		}
		if entry.Transport != "" {
			continue
		}
		return fmt.Errorf("mcp[%d] transport is required", i)
	}
	return nil
}
