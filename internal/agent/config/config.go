package config

import (
	"fmt"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	koanffile "github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

const (
	defaultContextCompactionThresholdRatio              = 0.85
	defaultContextCompactionToolResultMaxRatio          = 0.008
	defaultContextCompactionKeepRecentRequests          = 2
	defaultContextCompactionOversizedToolResultMaxRatio = 0.064
	defaultSessionSummaryMode                           = "auto"
	defaultSessionSummaryEventThreshold                 = 20
	defaultWebFetchTimeoutMS                            = 30000
	defaultMCPReconnectMaxAttempt                       = 3
)

// Config stores the full local agent runtime configuration.
type Config struct {
	Server       ServerConfig       `koanf:"server"`
	Agent        AgentConfig        `koanf:"agent"`
	Model        ModelConfig        `koanf:"model"`
	SummaryModel SummaryModelConfig `koanf:"summaryModel"`
	Memory       MemoryConfig       `koanf:"memory"`
	Session      SessionConfig      `koanf:"session"`
	Tools        ToolsConfig        `koanf:"tools"`
}

// ServerConfig defines the agent gRPC server settings.
type ServerConfig struct {
	Address                 string        `koanf:"address"`
	GracefulShutdownTimeout time.Duration `koanf:"gracefulShutdownTimeout"`
}

// AgentConfig defines agent identity and prompt settings.
type AgentConfig struct {
	Instruction                                  string  `koanf:"instruction"`
	SystemPrompt                                 string  `koanf:"systemPrompt"`
	AddSessionSummary                            *bool   `koanf:"addSessionSummary"`
	EnableContextCompaction                      *bool   `koanf:"enableContextCompaction"`
	ContextCompactionThresholdRatio              float64 `koanf:"contextCompactionThresholdRatio"`
	ContextCompactionToolResultMaxRatio          float64 `koanf:"contextCompactionToolResultMaxRatio"`
	ContextCompactionKeepRecentRequests          int     `koanf:"contextCompactionKeepRecentRequests"`
	ContextCompactionOversizedToolResultMaxRatio float64 `koanf:"contextCompactionOversizedToolResultMaxRatio"`
	MaxHistoryRuns                               int     `koanf:"maxHistoryRuns"`
}

// ModelConfig defines the LLM backend and generation settings.
type ModelConfig struct {
	Name          string  `koanf:"name"`
	APIKey        string  `koanf:"apiKey"`
	BaseURL       string  `koanf:"baseURL"`
	ContextWindow int     `koanf:"contextWindow"`
	Temperature   float64 `koanf:"temperature"`
	MaxTokens     int     `koanf:"maxTokens"`
	Stream        bool    `koanf:"stream"`
}

// SummaryModelConfig defines the summarization LLM backend.
type SummaryModelConfig struct {
	Name          string  `koanf:"name"`
	APIKey        string  `koanf:"apiKey"`
	BaseURL       string  `koanf:"baseURL"`
	ContextWindow int     `koanf:"contextWindow"`
	Temperature   float64 `koanf:"temperature"`
	MaxTokens     int     `koanf:"maxTokens"`
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

// SessionConfig defines the external session service connection.
type SessionConfig struct {
	Enabled   bool                 `koanf:"enabled"`
	Target    string               `koanf:"target"`
	Insecure  bool                 `koanf:"insecure"`
	TimeoutMs int                  `koanf:"timeoutMs"`
	SessionID string               `koanf:"sessionID"`
	Summary   SessionSummaryConfig `koanf:"summary"`
}

// SessionSummaryConfig defines how session summaries are produced.
type SessionSummaryConfig struct {
	Enabled             *bool   `koanf:"enabled"`
	Mode                string  `koanf:"mode"`
	EventThreshold      int     `koanf:"eventThreshold"`
	TokenThreshold      int     `koanf:"tokenThreshold"`
	IdleThreshold       string  `koanf:"idleThreshold"`
	MaxWords            int     `koanf:"maxWords"`
	ApproxRunesPerToken float64 `koanf:"approxRunesPerToken"`
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

	cfg.applyDefaults()
	err = cfg.Validate()
	if err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// applyDefaults normalizes implicit runtime defaults into the config value.
func (c *Config) applyDefaults() {
	if c.Server.Address == "" {
		c.Server.Address = "localhost:8080"
	}
	if c.Agent.AddSessionSummary == nil {
		c.Agent.AddSessionSummary = new(true)
	}
	if c.Agent.EnableContextCompaction == nil {
		c.Agent.EnableContextCompaction = new(true)
	}
	if c.Agent.ContextCompactionThresholdRatio <= 0 || c.Agent.ContextCompactionThresholdRatio > 1 {
		c.Agent.ContextCompactionThresholdRatio = defaultContextCompactionThresholdRatio
	}
	if c.Agent.ContextCompactionToolResultMaxRatio < 0 || c.Agent.ContextCompactionToolResultMaxRatio > 1 {
		c.Agent.ContextCompactionToolResultMaxRatio = defaultContextCompactionToolResultMaxRatio
	}
	if c.Agent.ContextCompactionKeepRecentRequests < 0 {
		c.Agent.ContextCompactionKeepRecentRequests = defaultContextCompactionKeepRecentRequests
	}
	if c.Agent.ContextCompactionOversizedToolResultMaxRatio < 0 || c.Agent.ContextCompactionOversizedToolResultMaxRatio > 1 {
		c.Agent.ContextCompactionOversizedToolResultMaxRatio = defaultContextCompactionOversizedToolResultMaxRatio
	}
	if c.SummaryModel.Name == "" {
		c.SummaryModel.Name = c.Model.Name
	}
	if c.SummaryModel.APIKey == "" && c.SummaryModel.BaseURL == "" {
		c.SummaryModel.APIKey = c.Model.APIKey
		c.SummaryModel.BaseURL = c.Model.BaseURL
	}
	if c.SummaryModel.Temperature == 0 {
		c.SummaryModel.Temperature = c.Model.Temperature
	}
	if c.SummaryModel.MaxTokens == 0 {
		c.SummaryModel.MaxTokens = c.Model.MaxTokens
	}
	if c.Session.Summary.Enabled == nil {
		c.Session.Summary.Enabled = new(true)
	}
	if c.Session.Summary.Mode == "" {
		c.Session.Summary.Mode = defaultSessionSummaryMode
	}
	if c.Session.Summary.EventThreshold <= 0 && c.Session.Summary.TokenThreshold <= 0 && c.Session.Summary.IdleThreshold == "" {
		c.Session.Summary.EventThreshold = defaultSessionSummaryEventThreshold
	}
	if c.Tools.WebFetch.TimeoutMs <= 0 {
		c.Tools.WebFetch.TimeoutMs = defaultWebFetchTimeoutMS
	}
	for i := range c.Tools.MCP {
		if c.Tools.MCP[i].Reconnect && c.Tools.MCP[i].ReconnectMaxAttempt <= 0 {
			c.Tools.MCP[i].ReconnectMaxAttempt = defaultMCPReconnectMaxAttempt
		}
	}
}

// Validate checks whether the configuration is internally consistent.
func (c Config) Validate() error {
	if c.Model.Name == "" {
		return fmt.Errorf("model.name is required")
	}
	if c.Model.ContextWindow < 0 {
		return fmt.Errorf("model.contextWindow must be >= 0")
	}
	if c.SummaryModel.ContextWindow < 0 {
		return fmt.Errorf("summaryModel.contextWindow must be >= 0")
	}
	if c.Server.GracefulShutdownTimeout < 0 {
		return fmt.Errorf("server.gracefulShutdownTimeout must be >= 0")
	}
	if c.Agent.ContextCompactionToolResultMaxRatio < 0 || c.Agent.ContextCompactionToolResultMaxRatio > 1 {
		return fmt.Errorf("agent.contextCompactionToolResultMaxRatio must be between 0 and 1")
	}
	if c.Agent.ContextCompactionOversizedToolResultMaxRatio < 0 || c.Agent.ContextCompactionOversizedToolResultMaxRatio > 1 {
		return fmt.Errorf("agent.contextCompactionOversizedToolResultMaxRatio must be between 0 and 1")
	}
	if c.Session.Enabled {
		if c.Session.Target == "" {
			return fmt.Errorf("session.target is required when session is enabled")
		}
		if c.Session.SessionID == "" {
			return fmt.Errorf("session.sessionID is required when session is enabled")
		}
	}
	if mode := c.Session.Summary.Mode; mode != "" && mode != "auto" && mode != "manual" {
		return fmt.Errorf("session.summary.mode must be auto or manual")
	}
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
