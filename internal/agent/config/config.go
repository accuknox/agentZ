package config

import (
	"fmt"
	"os"

	"sigs.k8s.io/yaml"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

const (
	// DefaultHomeDir is the runtime home directory for the agent user.
	DefaultHomeDir = "/home/clawarmor"

	defaultContextCompactionThresholdRatio              = 0.85
	defaultContextCompactionToolResultMaxRatio          = 0.008
	defaultContextCompactionKeepRecentRequests          = 2
	defaultContextCompactionOversizedToolResultMaxRatio = 0.064
	defaultSessionSummaryMode                           = "auto"
	defaultSessionSummaryEventThreshold                 = 20
	defaultWebFetchTimeoutMS                            = 30000
	defaultMCPReconnectMaxAttempt                       = 3
	defaultTelemetryTraceEndpoint                       = "localhost:4317"
)

// Load reads YAML config from path and applies defaults.
func Load(path string) (clawarmorv1alpha1.AgentSpec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return clawarmorv1alpha1.AgentSpec{}, fmt.Errorf("load config failed: %w", err)
	}

	var cfg clawarmorv1alpha1.AgentSpec
	err = yaml.Unmarshal(data, &cfg)
	if err != nil {
		return clawarmorv1alpha1.AgentSpec{}, fmt.Errorf("decode config failed: %w", err)
	}

	ApplyDefaults(&cfg)
	err = Validate(cfg)
	if err != nil {
		return clawarmorv1alpha1.AgentSpec{}, err
	}
	return cfg, nil
}

// ApplyDefaults normalizes implicit runtime defaults into the config value.
func ApplyDefaults(c *clawarmorv1alpha1.AgentSpec) {
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
	if c.SummaryModel.BaseURL == "" {
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
	if c.Telemetry.Enabled && c.Telemetry.TraceEndpoint == "" {
		c.Telemetry.TraceEndpoint = defaultTelemetryTraceEndpoint
	}
	if c.Tools.WebFetch.TimeoutMs <= 0 {
		c.Tools.WebFetch.TimeoutMs = defaultWebFetchTimeoutMS
	}
	if c.Tools.HostExec.BaseDir == "" {
		c.Tools.HostExec.BaseDir = DefaultHomeDir
	}
	if c.Tools.File.BaseDir == "" {
		c.Tools.File.BaseDir = DefaultHomeDir
	}
	for i := range c.Tools.MCP {
		if c.Tools.MCP[i].Reconnect && c.Tools.MCP[i].ReconnectMaxAttempt <= 0 {
			c.Tools.MCP[i].ReconnectMaxAttempt = defaultMCPReconnectMaxAttempt
		}
	}
}

// Validate checks whether the configuration is internally consistent.
func Validate(c clawarmorv1alpha1.AgentSpec) error {
	if c.Model.Name == "" {
		return fmt.Errorf("model.name is required")
	}
	if c.Model.ContextWindow < 0 {
		return fmt.Errorf("model.contextWindow must be >= 0")
	}
	if c.Model.ThinkingTokens < 0 {
		return fmt.Errorf("model.thinkingTokens must be >= 0")
	}
	if c.SummaryModel.ContextWindow < 0 {
		return fmt.Errorf("summaryModel.contextWindow must be >= 0")
	}
	if c.Server.GracefulShutdownTimeout.Duration < 0 {
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
		if c.Session.ID == "" {
			return fmt.Errorf("session.id is required when session is enabled")
		}
	}
	if c.Telemetry.Enabled && c.Telemetry.TraceEndpoint == "" {
		return fmt.Errorf("telemetry.traceEndpoint is required when telemetry is enabled")
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
