package agent

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	agentconfig "github.com/accuknox/clawarmor/internal/agent/config"
	"github.com/accuknox/clawarmor/internal/agent/log"
	sessionstore "github.com/accuknox/clawarmor/internal/session"
	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/memory"
	meminmemory "trpc.group/trpc-go/trpc-agent-go/memory/inmemory"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/runner"
	agentsession "trpc.group/trpc-go/trpc-agent-go/session"
	sessioninmemory "trpc.group/trpc-go/trpc-agent-go/session/inmemory"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/arxivsearch"
	filetool "trpc.group/trpc-go/trpc-agent-go/tool/file"
	"trpc.group/trpc-go/trpc-agent-go/tool/hostexec"
	"trpc.group/trpc-go/trpc-agent-go/tool/mcp"
	"trpc.group/trpc-go/trpc-agent-go/tool/openapi"
	"trpc.group/trpc-go/trpc-agent-go/tool/webfetch/httpfetch"
)

// Options configures the local agent runtime and REPL identity.
type Options struct {
	ConfigPath string
}

// Runtime holds the runnable agent system for REPL use.
type Runtime struct {
	runner     runner.Runner
	memorySvc  memory.Service
	sessionSvc agentsession.Service
	sessionCl  io.Closer
	sessionID  string
	toolSets   []tool.ToolSet
	stream     bool
}

// NewRuntime constructs a local in-memory agent runtime from YAML config.
func NewRuntime(ctx context.Context, opts Options) (*Runtime, error) {
	log.SetupTRPCAgentLogger()

	configPath, err := agentconfig.ResolvePath(opts.ConfigPath)
	if err != nil {
		return nil, err
	}

	cfg, err := agentconfig.Load(configPath)
	if err != nil {
		return nil, err
	}

	modelOpts := make([]openai.Option, 0, 2)
	if cfg.Model.APIKey != "" {
		modelOpts = append(modelOpts, openai.WithAPIKey(cfg.Model.APIKey))
	}
	if cfg.Model.BaseURL != "" {
		modelOpts = append(modelOpts, openai.WithBaseURL(cfg.Model.BaseURL))
	}
	mdl := openai.New(cfg.Model.Name, modelOpts...)

	memorySvc := buildMemoryService(cfg)

	tools, toolSets, err := buildTools(ctx, cfg)
	if err != nil {
		if memorySvc != nil {
			memorySvc.Close()
		}
		return nil, err
	}
	if memorySvc != nil {
		tools = append(tools, memorySvc.Tools()...)
	}

	genConfig := model.GenerationConfig{Stream: cfg.Model.Stream}
	if cfg.Model.Temperature > 0 {
		genConfig.Temperature = new(cfg.Model.Temperature)
	}
	if cfg.Model.MaxTokens > 0 {
		genConfig.MaxTokens = new(cfg.Model.MaxTokens)
	}

	agentOpts := []llmagent.Option{
		llmagent.WithModel(mdl),
		llmagent.WithInstruction(cfg.Agent.Instruction),
		llmagent.WithGenerationConfig(genConfig),
		llmagent.WithGlobalInstruction(cfg.Agent.SystemPrompt),
	}
	if len(tools) > 0 {
		agentOpts = append(agentOpts, llmagent.WithTools(tools))
	}
	if len(toolSets) > 0 {
		agentOpts = append(agentOpts, llmagent.WithToolSets(toolSets))
	}
	agt := llmagent.New("clawarmor", agentOpts...)

	sessionSvc, sessionCl, runSessionID, err := buildSessionService(ctx, cfg)
	if err != nil {
		memorySvc.Close()
		for _, toolSet := range toolSets {
			if toolSet == nil {
				continue
			}
			toolSet.Close()
		}
		return nil, err
	}

	runnerOpts := []runner.Option{
		runner.WithSessionService(sessionSvc),
	}
	if memorySvc != nil {
		runnerOpts = append(runnerOpts, runner.WithMemoryService(memorySvc))
	}
	rnr := runner.NewRunner(sessionstore.DefaultAppName, agt, runnerOpts...)

	return &Runtime{
		runner:     rnr,
		memorySvc:  memorySvc,
		sessionSvc: sessionSvc,
		sessionCl:  sessionCl,
		sessionID:  runSessionID,
		toolSets:   toolSets,
		stream:     cfg.Model.Stream,
	}, nil
}

// Close releases runtime resources.
func (r *Runtime) Close() error {
	if r == nil {
		return nil
	}
	var firstErr error
	for _, toolSet := range r.toolSets {
		if toolSet == nil {
			continue
		}
		err := toolSet.Close()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if r.memorySvc != nil {
		err := r.memorySvc.Close()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if r.runner != nil {
		err := r.runner.Close()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if r.sessionCl != nil {
		err := r.sessionCl.Close()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func buildSessionService(ctx context.Context, cfg agentconfig.Config) (agentsession.Service, io.Closer, string, error) {
	if !cfg.Session.Enabled {
		return sessioninmemory.NewSessionService(), nil, sessionstore.DefaultSessionID, nil
	}

	svc, err := sessionstore.NewSessionServiceClient(sessionstore.ClientConfig{
		Target:    cfg.Session.Target,
		Insecure:  cfg.Session.Insecure,
		Timeout:   time.Duration(cfg.Session.TimeoutMs) * time.Millisecond,
		SessionID: cfg.Session.SessionID,
	})
	if err != nil {
		return nil, nil, "", err
	}

	err = svc.EnsureSessionExists(ctx, cfg.Session.SessionID)
	if err != nil {
		svc.Close()
		return nil, nil, "", fmt.Errorf("session %q not found: %w", cfg.Session.SessionID, err)
	}

	return svc, svc, cfg.Session.SessionID, nil
}

func buildMemoryService(cfg agentconfig.Config) memory.Service {
	if !cfg.Memory.Enabled {
		return nil
	}

	opts := make([]meminmemory.ServiceOpt, 0, 16)
	if cfg.Memory.Limit > 0 {
		opts = append(opts, meminmemory.WithMemoryLimit(cfg.Memory.Limit))
	}

	setMemoryTool := func(name string, enabled bool, exposed bool) {
		opts = append(opts, meminmemory.WithToolEnabled(name, enabled))
		opts = append(opts, meminmemory.WithToolExposed(name, exposed))
	}

	setMemoryTool(memory.SearchToolName, cfg.Memory.Tools.Search, cfg.Memory.Tools.Search)
	setMemoryTool(memory.LoadToolName, cfg.Memory.Tools.Load, cfg.Memory.Tools.Load)
	setMemoryTool(memory.AddToolName, cfg.Memory.Tools.Add, cfg.Memory.Tools.Add)
	setMemoryTool(memory.UpdateToolName, cfg.Memory.Tools.Update, cfg.Memory.Tools.Update)
	setMemoryTool(memory.DeleteToolName, cfg.Memory.Tools.Delete, cfg.Memory.Tools.Delete)
	setMemoryTool(memory.ClearToolName, cfg.Memory.Tools.Clear, cfg.Memory.Tools.Clear)

	return meminmemory.NewMemoryService(opts...)
}

//nolint:gocyclo
func buildTools(ctx context.Context, cfg agentconfig.Config) ([]tool.Tool, []tool.ToolSet, error) {
	tools := make([]tool.Tool, 0, 32)
	toolSets := make([]tool.ToolSet, 0, 16)

	if cfg.Tools.HostExec.Enabled {
		hostOpts := make([]hostexec.Option, 0, 3)
		if cfg.Tools.HostExec.BaseDir != "" {
			hostOpts = append(hostOpts, hostexec.WithBaseDir(cfg.Tools.HostExec.BaseDir))
		}
		if len(cfg.Tools.HostExec.BaseEnv) > 0 {
			hostOpts = append(hostOpts, hostexec.WithBaseEnv(cfg.Tools.HostExec.BaseEnv))
		}
		ts, err := hostexec.NewToolSet(hostOpts...)
		if err != nil {
			return nil, nil, fmt.Errorf("create hostexec toolset failed: %w", err)
		}
		toolSets = append(toolSets, ts)
	}

	if cfg.Tools.WebFetch.Enabled {
		client := &http.Client{Timeout: 30 * time.Second}
		if cfg.Tools.WebFetch.TimeoutMs > 0 {
			client.Timeout = time.Duration(cfg.Tools.WebFetch.TimeoutMs) *
				time.Millisecond
		}
		fetchOpts := []httpfetch.Option{httpfetch.WithHTTPClient(client)}
		if cfg.Tools.WebFetch.MaxContentLength > 0 {
			fetchOpts = append(fetchOpts, httpfetch.WithMaxContentLength(cfg.Tools.WebFetch.MaxContentLength))
		}
		if cfg.Tools.WebFetch.MaxTotalContentLength > 0 {
			fetchOpts = append(fetchOpts, httpfetch.WithMaxTotalContentLength(cfg.Tools.WebFetch.MaxTotalContentLength))
		}
		tools = append(tools, httpfetch.NewTool(fetchOpts...))
	}

	if cfg.Tools.File.Enabled {
		fileOpts := make([]filetool.Option, 0, 1)
		if cfg.Tools.File.BaseDir != "" {
			fileOpts = append(fileOpts, filetool.WithBaseDir(cfg.Tools.File.BaseDir))
		}
		ts, err := filetool.NewToolSet(fileOpts...)
		if err != nil {
			return nil, nil, fmt.Errorf("create file toolset failed: %w", err)
		}
		toolSets = append(toolSets, ts)
	}

	if cfg.Tools.Arxiv.Enabled {
		arxivOpts := make([]arxivsearch.Option, 0, 4)
		if cfg.Tools.Arxiv.BaseURL != "" {
			arxivOpts = append(arxivOpts, arxivsearch.WithBaseURL(cfg.Tools.Arxiv.BaseURL))
		}
		if cfg.Tools.Arxiv.PageSize > 0 {
			arxivOpts = append(arxivOpts, arxivsearch.WithPageSize(cfg.Tools.Arxiv.PageSize))
		}
		if cfg.Tools.Arxiv.DelayMS > 0 {
			arxivOpts = append(arxivOpts, arxivsearch.WithDelaySeconds(time.Duration(cfg.Tools.Arxiv.DelayMS)*time.Millisecond))
		}
		if cfg.Tools.Arxiv.NumRetries > 0 {
			arxivOpts = append(arxivOpts, arxivsearch.WithNumRetries(cfg.Tools.Arxiv.NumRetries))
		}
		ts, err := arxivsearch.NewToolSet(arxivOpts...)
		if err != nil {
			return nil, nil, fmt.Errorf("create arxiv toolset failed: %w", err)
		}
		toolSets = append(toolSets, ts)
	}

	for i := range cfg.Tools.OpenAPI {
		entry := cfg.Tools.OpenAPI[i]
		if !entry.Enabled {
			continue
		}
		var loader openapi.Loader
		if entry.SpecFile != "" {
			l, err := openapi.NewFileLoader(entry.SpecFile)
			if err != nil {
				return nil, nil, fmt.Errorf("create openApi[%d] file loader failed: %w", i, err)
			}
			loader = l
		} else if entry.SpecURL != "" {
			l, err := openapi.NewURILoader(entry.SpecURL)
			if err != nil {
				return nil, nil, fmt.Errorf("create openApi[%d] url loader failed: %w", i, err)
			}
			loader = l
		}
		openapiOpts := []openapi.Option{openapi.WithSpecLoader(loader)}
		if entry.Name != "" {
			openapiOpts = append(openapiOpts, openapi.WithName(entry.Name))
		}
		ts, err := openapi.NewToolSet(ctx, openapiOpts...)
		if err != nil {
			return nil, nil, fmt.Errorf("create openApi[%d] toolset failed: %w", i, err)
		}
		toolSets = append(toolSets, ts)
	}

	for i := range cfg.Tools.MCP {
		entry := cfg.Tools.MCP[i]
		if !entry.Enabled {
			continue
		}
		mcpConfig := mcp.ConnectionConfig{
			Transport: entry.Transport,
			ServerURL: entry.ServerURL,
			Headers:   entry.Headers,
			Command:   entry.Command,
			Args:      entry.Args,
		}
		if entry.TimeoutMs > 0 {
			mcpConfig.Timeout = time.Duration(entry.TimeoutMs) * time.Millisecond
		}
		mcpOpts := make([]mcp.ToolSetOption, 0, 2)
		if entry.Name != "" {
			mcpOpts = append(mcpOpts, mcp.WithName(entry.Name))
		}
		if entry.Reconnect {
			maxAttempts := entry.ReconnectMaxAttempt
			if maxAttempts <= 0 {
				maxAttempts = 3
			}
			mcpOpts = append(mcpOpts, mcp.WithSessionReconnect(maxAttempts))
		}
		ts := mcp.NewMCPToolSet(mcpConfig, mcpOpts...)
		err := ts.Init(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("init mcp[%d] toolset failed: %w", i, err)
		}
		toolSets = append(toolSets, ts)
	}

	return tools, toolSets, nil
}
