package agent

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	agentsummary "trpc.group/trpc-go/trpc-agent-go/session/summary"
)

const (
	summaryToolResultMaxRunes = 2000
	sessionstoreSummaryName   = "clawarmor"
	sessionSummaryModeAuto    = "auto"
	sessionSummaryModeManual  = "manual"
	openAIAPIKeyEnv           = "OPENAI_API_KEY"
)

type modelBackend struct {
	name    string
	baseURL string
}

type generationDefaultsModel struct {
	base model.Model
	gen  model.GenerationConfig
}

func registerModelContextWindows(cfg clawarmorv1alpha1.AgentSpec) string {
	modelName := cfg.Model.Name
	if cfg.Model.ContextWindow > 0 {
		model.RegisterModelContextWindow(modelName, cfg.Model.ContextWindow)
	}

	summaryName := cfg.SummaryModel.Name
	summaryWindow := cfg.SummaryModel.ContextWindow
	if summaryWindow <= 0 && summaryName == modelName {
		summaryWindow = cfg.Model.ContextWindow
	}
	if summaryWindow > 0 {
		model.RegisterModelContextWindow(summaryName, summaryWindow)
	}

	if _, ok := model.LookupModelContextWindow(modelName); !ok {
		return unknownContextWindowMessage("model.contextWindow", modelName)
	}

	if !*cfg.Session.Summary.Enabled ||
		strings.ToLower(cfg.Session.Summary.Mode) != sessionSummaryModeAuto {
		return ""
	}

	if _, ok := model.LookupModelContextWindow(summaryName); ok {
		return ""
	}

	return unknownContextWindowMessage("summaryModel.contextWindow", summaryName)
}

func unknownContextWindowMessage(path string, modelName string) string {
	return fmt.Sprintf(
		"context window for model %q is unknown; set %s before chatting",
		modelName,
		path,
	)
}

func buildChatModel(cfg clawarmorv1alpha1.AgentSpec) model.Model {
	return openAIModel(modelBackend{
		name:    cfg.Model.Name,
		baseURL: cfg.Model.BaseURL,
	})
}

func buildSummaryModel(cfg clawarmorv1alpha1.AgentSpec) model.Model {
	return withGenerationDefaults(
		openAIModel(modelBackend{
			name:    cfg.SummaryModel.Name,
			baseURL: cfg.SummaryModel.BaseURL,
		}),
		generationConfig(
			cfg.SummaryModel.Temperature,
			cfg.SummaryModel.MaxTokens,
			false,
			nil,
			0,
		),
	)
}

func openAIModel(backend modelBackend) model.Model {
	opts := []openai.Option{}
	if backend.baseURL != "" {
		opts = append(opts, openai.WithBaseURL(backend.baseURL))
	}
	apiKey := strings.TrimSpace(os.Getenv(openAIAPIKeyEnv))
	if apiKey != "" {
		opts = append(opts, openai.WithAPIKey(apiKey))
	}
	opts = append(opts, openai.WithEnableTokenTailoring(true))
	return openai.New(backend.name, opts...)
}

func generationConfig(temp float64, maxTokens int, stream bool, thinkingEnabled *bool, thinkingTokens int) model.GenerationConfig {
	gen := model.GenerationConfig{Stream: stream}
	if temp > 0 {
		gen.Temperature = &temp
	}
	if maxTokens > 0 {
		gen.MaxTokens = &maxTokens
	}
	if thinkingEnabled != nil {
		gen.ThinkingEnabled = new(*thinkingEnabled)
	}
	if thinkingTokens > 0 {
		gen.ThinkingTokens = new(thinkingTokens)
	}
	return gen
}

func withGenerationDefaults(base model.Model, gen model.GenerationConfig) model.Model {
	if base == nil {
		return nil
	}
	return &generationDefaultsModel{base: base, gen: gen}
}

func (m *generationDefaultsModel) Info() model.Info {
	return m.base.Info()
}

func (m *generationDefaultsModel) GenerateContent(ctx context.Context, req *model.Request) (<-chan *model.Response, error) {
	if req == nil {
		return m.base.GenerateContent(ctx, req)
	}
	cloned := *req
	applyGenerationDefaults(&cloned, m.gen)
	return m.base.GenerateContent(ctx, &cloned)
}

func applyGenerationDefaults(req *model.Request, gen model.GenerationConfig) {
	if req.MaxTokens == nil && gen.MaxTokens != nil {
		value := *gen.MaxTokens
		req.MaxTokens = &value
	}
	if req.Temperature == nil && gen.Temperature != nil {
		value := *gen.Temperature
		req.Temperature = &value
	}
	if !req.Stream && gen.Stream {
		req.Stream = true
	}
}

func buildSummarizer(summaryModel model.Model, cfg clawarmorv1alpha1.AgentSpec) (agentsummary.SessionSummarizer, error) {
	if !*cfg.Session.Summary.Enabled {
		return nil, nil
	}
	if summaryModel == nil {
		return nil, fmt.Errorf("session summary requires a model")
	}

	if runesPerTkn := cfg.Session.Summary.ApproxRunesPerToken; runesPerTkn > 0 {
		agentsummary.SetTokenCounter(model.NewSimpleTokenCounter(model.WithApproxRunesPerToken(runesPerTkn)))
	}

	opts := []agentsummary.Option{
		agentsummary.WithName(sessionstoreSummaryName),
		agentsummary.WithToolResultFormatter(summaryToolResultFormatter),
	}
	if cfg.Session.Summary.MaxWords > 0 {
		opts = append(opts, agentsummary.WithMaxSummaryWords(cfg.Session.Summary.MaxWords))
	}

	mode := strings.ToLower(cfg.Session.Summary.Mode)
	switch mode {
	case sessionSummaryModeAuto:
		opts = append(opts, agentsummary.WithContextThreshold(
			agentsummary.WithContextThresholdFallbackWindow(summaryFallbackWindow(cfg)),
			agentsummary.WithContextThresholdMinTokens(0),
			agentsummary.WithContextThresholdRatio(
				cfg.Agent.ContextCompactionThresholdRatio,
			),
		))
	case sessionSummaryModeManual:
		checks, err := manualSummaryChecks(cfg)
		if err != nil {
			return nil, err
		}
		opts = append(opts, agentsummary.WithChecksAny(checks...))
	default:
		return nil, fmt.Errorf("unsupported session summary mode %q", mode)
	}

	return agentsummary.NewSummarizer(summaryModel, opts...), nil
}

func manualSummaryChecks(cfg clawarmorv1alpha1.AgentSpec) ([]agentsummary.Checker, error) {
	checks := make([]agentsummary.Checker, 0, 3)
	if cfg.Session.Summary.EventThreshold > 0 {
		checks = append(checks, agentsummary.CheckEventThreshold(cfg.Session.Summary.EventThreshold))
	}
	if cfg.Session.Summary.TokenThreshold > 0 {
		checks = append(checks, agentsummary.CheckTokenThreshold(cfg.Session.Summary.TokenThreshold))
	}
	if value := cfg.Session.Summary.IdleThreshold; value != "" {
		idle, err := time.ParseDuration(value)
		if err != nil {
			return nil, fmt.Errorf("session.summary.idleThreshold: %w", err)
		}
		if idle > 0 {
			checks = append(checks, agentsummary.CheckTimeThreshold(idle))
		}
	}
	return checks, nil
}

func summaryFallbackWindow(cfg clawarmorv1alpha1.AgentSpec) int {
	if cfg.Model.ContextWindow > 0 {
		return cfg.Model.ContextWindow
	}
	if cfg.SummaryModel.ContextWindow > 0 {
		return cfg.SummaryModel.ContextWindow
	}
	return 0
}

func ratioToTokenCount(window int, ratio float64) int {
	if window <= 0 || ratio <= 0 {
		return 0
	}
	return int(float64(window) * ratio)
}

func summaryToolResultFormatter(msg model.Message) string {
	content := strings.TrimSpace(msg.Content)
	if content == "" {
		return ""
	}
	name := strings.TrimSpace(msg.ToolName)
	if name == "" {
		name = "tool"
	}
	runes := []rune(content)
	if len(runes) > summaryToolResultMaxRunes {
		content = string(runes[:summaryToolResultMaxRunes]) + "... [truncated]"
	}
	return fmt.Sprintf("[%s returned: %s]", name, content)
}
