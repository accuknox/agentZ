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

	defaultCompactionMode                     = clawarmorv1alpha1.CompactionModeSummary
	defaultCompactionThresholdRatio           = 0.9
	defaultCompactionHistoryToolResultRatio   = 0.008
	defaultCompactionKeepRecentRequests       = 2
	defaultCompactionOversizedToolResultRatio = 0.065
	defaultSessionSummaryMode                 = "auto"
	defaultSessionSummaryEventThreshold       = 20
	defaultWebFetchTimeoutMS                  = 30000
	defaultMCPReconnectMaxAttempt             = 3
	defaultTelemetryTraceEndpoint             = "localhost:4317"
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
	if c.Compaction.Enabled == nil {
		c.Compaction.Enabled = new(true)
	}
	if c.Compaction.Mode == "" {
		c.Compaction.Mode = defaultCompactionMode
	}
	if c.Compaction.ThresholdRatio == 0 {
		c.Compaction.ThresholdRatio = defaultCompactionThresholdRatio
	}
	if c.Compaction.HistoryToolResultRatio == 0 {
		c.Compaction.HistoryToolResultRatio = defaultCompactionHistoryToolResultRatio
	}
	if c.Compaction.KeepRecentRequests == 0 {
		c.Compaction.KeepRecentRequests = defaultCompactionKeepRecentRequests
	}
	if c.Compaction.OversizedToolResultRatio == 0 {
		c.Compaction.OversizedToolResultRatio = defaultCompactionOversizedToolResultRatio
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
	if c.Tools.HostExec.Enabled == nil {
		enabled := true
		c.Tools.HostExec.Enabled = &enabled
	}
	if c.Tools.WebFetch.Enabled == nil {
		enabled := true
		c.Tools.WebFetch.Enabled = &enabled
	}
	if c.Tools.File.Enabled == nil {
		enabled := false
		c.Tools.File.Enabled = &enabled
	}
	if c.Tools.Arxiv.Enabled == nil {
		enabled := false
		c.Tools.Arxiv.Enabled = &enabled
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
//
//nolint:gocyclo
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
	if c.Compaction.Mode != clawarmorv1alpha1.CompactionModeSummary && c.Compaction.Mode != clawarmorv1alpha1.CompactionModeTruncate {
		return fmt.Errorf("compaction.mode must be summary or truncate")
	}
	if c.Compaction.ThresholdRatio < 0.2 || c.Compaction.ThresholdRatio > 0.95 {
		return fmt.Errorf("compaction.thresholdRatio must be between 0.2 and 0.95")
	}
	if c.Compaction.HistoryToolResultRatio < 0 || c.Compaction.HistoryToolResultRatio > 1 {
		return fmt.Errorf("compaction.historyToolResultRatio must be between 0 and 1")
	}
	if c.Compaction.OversizedToolResultRatio < 0.05 || c.Compaction.OversizedToolResultRatio > 0.1 {
		return fmt.Errorf("compaction.oversizedToolResultRatio must be between 0.05 and 0.1")
	}
	historyRatio := c.Compaction.HistoryToolResultRatio
	oversizedRatio := c.Compaction.OversizedToolResultRatio
	if (historyRatio != 0 || oversizedRatio != 0) && historyRatio >= oversizedRatio {
		return fmt.Errorf("compaction.historyToolResultRatio must be less than compaction.oversizedToolResultRatio")
	}
	if c.Compaction.Mode == clawarmorv1alpha1.CompactionModeSummary && c.SummaryModel.Name == "" {
		return fmt.Errorf("summaryModel.name is required when compaction.mode is summary")
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
