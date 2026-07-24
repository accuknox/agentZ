package inference

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	modelsDevURL       = "https://models.dev/api.json"
	modelsDevMaxBytes  = 8 << 20
	catalogLifetime    = 24 * time.Hour
	openAICodexVersion = "0.145.0"
)

// CatalogProvenance identifies the source of model suggestions.
type CatalogProvenance string

const (
	// CatalogProvenanceLive identifies a successful Models.dev response.
	CatalogProvenanceLive CatalogProvenance = "live"
	// CatalogProvenanceCache identifies the last successful parsed response.
	CatalogProvenanceCache CatalogProvenance = "cache"
	// CatalogProvenanceSnapshot identifies the reviewed embedded fallback.
	CatalogProvenanceSnapshot CatalogProvenance = "snapshot"
)

type catalogProvider struct {
	ID     string                  `json:"id"`
	Name   string                  `json:"name"`
	NPM    string                  `json:"npm"`
	API    string                  `json:"api"`
	Doc    string                  `json:"doc"`
	Models map[string]catalogModel `json:"models"`
}

type catalogModel struct {
	ID          string                              `json:"id"`
	Name        string                              `json:"name"`
	Attachment  bool                                `json:"attachment"`
	Reasoning   bool                                `json:"reasoning"`
	ToolCall    bool                                `json:"tool_call"`
	Temperature bool                                `json:"temperature"`
	Modalities  catalogModelModalities              `json:"modalities"`
	Limit       agentzv1alpha1.InferenceModelLimits `json:"limit"`
	Provider    *catalogModelProvider               `json:"provider"`
}

type catalogModelProvider struct {
	NPM string `json:"npm"`
}

type catalogModelModalities struct {
	Input  []agentzv1alpha1.InferenceModelModality `json:"input"`
	Output []agentzv1alpha1.InferenceModelModality `json:"output"`
}

type copilotModelsResponse struct {
	Data []copilotModel `json:"data"`
}

type codexModelsResponse struct {
	Models []codexModel `json:"models"`
}

type codexModel struct {
	Slug             string                                  `json:"slug"`
	DisplayName      string                                  `json:"display_name"`
	Visibility       string                                  `json:"visibility"`
	Priority         int                                     `json:"priority"`
	ContextWindow    *int32                                  `json:"context_window"`
	MaxContextWindow *int32                                  `json:"max_context_window"`
	InputModalities  []agentzv1alpha1.InferenceModelModality `json:"input_modalities"`
}

type copilotModel struct {
	ID                 string                   `json:"id"`
	Name               string                   `json:"name"`
	SupportedEndpoints []string                 `json:"supported_endpoints"`
	Policy             *copilotModelPolicy      `json:"policy"`
	Capabilities       copilotModelCapabilities `json:"capabilities"`
}

type copilotModelPolicy struct {
	State string `json:"state"`
}

type copilotModelCapabilities struct {
	Family   string               `json:"family"`
	Limits   *copilotModelLimits  `json:"limits"`
	Supports copilotModelSupports `json:"supports"`
}

type copilotModelLimits struct {
	Context *int32              `json:"max_context_window_tokens"`
	Output  *int32              `json:"max_output_tokens"`
	Prompt  *int32              `json:"max_prompt_tokens"`
	Vision  *copilotModelVision `json:"vision"`
}

type copilotModelVision struct {
	MediaTypes []string `json:"supported_media_types"`
}

type copilotModelSupports struct {
	AdaptiveThinking  bool     `json:"adaptive_thinking"`
	MaxThinkingBudget *int32   `json:"max_thinking_budget"`
	MinThinkingBudget *int32   `json:"min_thinking_budget"`
	ReasoningEffort   []string `json:"reasoning_effort"`
	ToolCalls         *bool    `json:"tool_calls"`
	Vision            bool     `json:"vision"`
}

// Catalog fetches and retains a parsed Models.dev projection.
type Catalog struct {
	client       *http.Client
	url          string
	mu           sync.Mutex
	providers    map[string]catalogProvider
	fetchedAt    time.Time
	etag         string
	lastModified string
}

// CatalogEntry is one selectable provider and configuration kind.
type CatalogEntry struct {
	ProviderID      string
	Name            string
	Kind            agentzv1alpha1.InferenceProviderKind
	BaseURL         string
	BaseURLTemplate string
	AuthHeader      string
	AuthPrefix      string
	Doc             string
}

// NewCatalog creates a bounded Models.dev catalog client. A nil client uses a
// five-second HTTP timeout.
func NewCatalog(client *http.Client) *Catalog {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &Catalog{client: client, url: modelsDevURL}
}

// Entries returns the pinned supported catalog variants matching query.
func (c *Catalog) Entries(query string) (string, []CatalogEntry) {
	query = strings.ToLower(strings.TrimSpace(query))
	entries := make([]CatalogEntry, 0, len(catalogEntries)+2)
	custom := []CatalogEntry{
		{
			ProviderID: "custom", Name: "Custom OpenAI-compatible",
			Kind:       agentzv1alpha1.InferenceProviderKindOpenAICompatible,
			AuthHeader: "authorization", AuthPrefix: "Bearer ",
		},
		{
			ProviderID: "custom", Name: "Custom Anthropic-compatible",
			Kind:       agentzv1alpha1.InferenceProviderKindAnthropicCompatible,
			AuthHeader: "x-api-key",
		},
	}
	for _, entry := range custom {
		nameMatches := strings.Contains(strings.ToLower(entry.Name), query)
		providerMatches := strings.Contains(entry.ProviderID, query)
		if query == "" || nameMatches || providerMatches {
			entries = append(entries, entry)
		}
	}
	for _, entry := range catalogEntries {
		nameMatches := strings.Contains(strings.ToLower(entry.Name), query)
		providerMatches := strings.Contains(entry.ProviderID, query)
		if query != "" && !nameMatches && !providerMatches {
			continue
		}
		entries = append(entries, entry)
	}
	return catalogCommit, entries
}

// Suggestions returns models for one pinned provider/runtime variant and
// reports whether they came from the live response, cache, or snapshot.
func (c *Catalog) Suggestions(ctx context.Context, providerID string, providerKind agentzv1alpha1.InferenceProviderKind) ([]agentzv1alpha1.InferenceModel, CatalogProvenance, error) {
	isCustom := providerID == "custom"
	isCompatible := providerKind == agentzv1alpha1.InferenceProviderKindOpenAICompatible || providerKind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible
	isSupported := isCustom && isCompatible
	for _, entry := range catalogEntries {
		if entry.ProviderID == providerID && entry.Kind == providerKind {
			isSupported = true
			break
		}
	}
	if !isSupported {
		return nil, "", fmt.Errorf("unsupported provider %q with kind %q", providerID, providerKind)
	}
	if providerID == "custom" {
		return []agentzv1alpha1.InferenceModel{}, CatalogProvenanceSnapshot, nil
	}

	c.mu.Lock()
	if c.providers != nil && time.Since(c.fetchedAt) < catalogLifetime {
		models := modelsFromCatalog(c.providers[providerID], providerID, providerKind)
		c.mu.Unlock()
		return models, CatalogProvenanceCache, nil
	}
	etag := c.etag
	lastModified := c.lastModified
	c.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return nil, "", fmt.Errorf("create models.dev request: %w", err)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastModified != "" {
		req.Header.Set("If-Modified-Since", lastModified)
	}
	resp, err := c.client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusNotModified:
			c.mu.Lock()
			if c.providers != nil {
				c.fetchedAt = time.Now()
				models := modelsFromCatalog(c.providers[providerID], providerID, providerKind)
				c.mu.Unlock()
				return models, CatalogProvenanceCache, nil
			}
			c.mu.Unlock()
			err = errors.New("models.dev returned not modified without a cached catalog")
		case http.StatusOK:
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, modelsDevMaxBytes+1))
			switch {
			case readErr != nil:
				err = fmt.Errorf("read models.dev response: %w", readErr)
			case len(body) > modelsDevMaxBytes:
				err = fmt.Errorf("models.dev response exceeds %d bytes", modelsDevMaxBytes)
			default:
				providers := map[string]catalogProvider{}
				decodeErr := json.Unmarshal(body, &providers)
				if decodeErr != nil {
					err = fmt.Errorf("decode models.dev response: %w", decodeErr)
					break
				}
				c.mu.Lock()
				c.providers = providers
				c.fetchedAt = time.Now()
				c.etag = resp.Header.Get("ETag")
				c.lastModified = resp.Header.Get("Last-Modified")
				c.mu.Unlock()
				return modelsFromCatalog(providers[providerID], providerID, providerKind), CatalogProvenanceLive, nil
			}
		default:
			err = fmt.Errorf("models.dev returned %s", resp.Status)
		}
	}
	c.mu.Lock()
	if c.providers != nil && time.Since(c.fetchedAt) < catalogLifetime {
		models := modelsFromCatalog(c.providers[providerID], providerID, providerKind)
		c.mu.Unlock()
		return models, CatalogProvenanceCache, nil
	}
	c.mu.Unlock()
	models := slices.Clone(catalogSnapshot[providerID])
	if models == nil {
		models = []agentzv1alpha1.InferenceModel{}
	}
	for i := range models {
		models[i] = *models[i].DeepCopy()
	}
	return models, CatalogProvenanceSnapshot, err
}

// SubscriptionModels returns models available to one authenticated
// subscription. Provider endpoints determine entitlement; Models.dev only
// supplies capability metadata that subscription endpoints omit.
func (c *Catalog) SubscriptionModels(ctx context.Context, record SubscriptionRecord) ([]agentzv1alpha1.InferenceModel, CatalogProvenance, error) {
	if record.Token == nil || strings.TrimSpace(record.Token.AccessToken) == "" {
		return nil, "", fmt.Errorf("subscription access token is unavailable")
	}
	switch record.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAICodex:
		return c.codexModels(ctx, record)
	case agentzv1alpha1.InferenceProviderKindGitHubCopilot:
		return c.copilotModels(ctx, record.Token.AccessToken)
	default:
		return nil, "", fmt.Errorf("provider kind %q is not subscription-backed", record.Kind)
	}
}

func (c *Catalog) codexModels(ctx context.Context, record SubscriptionRecord) ([]agentzv1alpha1.InferenceModel, CatalogProvenance, error) {
	if strings.TrimSpace(record.AccountID) == "" {
		return nil, "", fmt.Errorf("openai codex account id is unavailable")
	}
	baseline, provenance, catalogErr := c.Suggestions(
		ctx,
		"openai",
		agentzv1alpha1.InferenceProviderKindOpenAICodex,
	)
	endpoint := OpenAICodexModelsEndpoint + "?client_version=" + openAICodexVersion
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", fmt.Errorf("create openai codex models request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+record.Token.AccessToken)
	req.Header.Set("ChatGPT-Account-ID", record.AccountID)
	req.Header.Set("Version", openAICodexVersion)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("fetch openai codex models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, "", fmt.Errorf("fetch openai codex models: upstream returned %s", resp.Status)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, modelsDevMaxBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("read openai codex models: %w", err)
	}
	if len(payload) > modelsDevMaxBytes {
		return nil, "", fmt.Errorf("read openai codex models: response exceeds %d bytes", modelsDevMaxBytes)
	}
	var response codexModelsResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, "", fmt.Errorf("decode openai codex models: %w", err)
	}

	known := make(map[string]agentzv1alpha1.InferenceModel, len(baseline))
	for _, model := range baseline {
		known[model.ID] = model
	}
	slices.SortFunc(response.Models, func(a, b codexModel) int {
		return cmp.Compare(a.Priority, b.Priority)
	})
	models := make([]agentzv1alpha1.InferenceModel, 0, len(response.Models))
	for _, remote := range response.Models {
		model, ok := known[remote.Slug]
		if !ok || remote.Visibility != "list" || remote.DisplayName == "" {
			continue
		}
		contextLimit := remote.ContextWindow
		if contextLimit == nil {
			contextLimit = remote.MaxContextWindow
		}
		if contextLimit == nil || *contextLimit < 1 || model.Limits.Output > *contextLimit {
			continue
		}
		input := make([]agentzv1alpha1.InferenceModelModality, 0, len(model.Modalities.Input))
		for _, modality := range model.Modalities.Input {
			if slices.Contains(remote.InputModalities, modality) {
				input = append(input, modality)
			}
		}
		if len(input) == 0 {
			continue
		}
		model.DisplayName = remote.DisplayName
		model.Modalities.Input = input
		model.Limits.Context = *contextLimit
		model.Limits.Input = nil
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil, "", fmt.Errorf("openai codex returned no eligible models")
	}
	return models, provenance, catalogErr
}

func (c *Catalog) copilotModels(ctx context.Context, accessToken string) ([]agentzv1alpha1.InferenceModel, CatalogProvenance, error) {
	baseline, _, catalogErr := c.Suggestions(
		ctx,
		"github-copilot",
		agentzv1alpha1.InferenceProviderKindGitHubCopilot,
	)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		GitHubCopilotAPIEndpoint+"/models",
		nil,
	)
	if err != nil {
		return nil, "", fmt.Errorf("create github copilot models request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("User-Agent", "agentz")
	req.Header.Set("X-GitHub-Api-Version", GitHubCopilotAPIVersion)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("fetch github copilot models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, "", fmt.Errorf("fetch github copilot models: upstream returned %s", resp.Status)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, modelsDevMaxBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("read github copilot models: %w", err)
	}
	if len(payload) > modelsDevMaxBytes {
		return nil, "", fmt.Errorf("read github copilot models: response exceeds %d bytes", modelsDevMaxBytes)
	}
	var response copilotModelsResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, "", fmt.Errorf("decode github copilot models: %w", err)
	}

	known := make(map[string]agentzv1alpha1.InferenceModel, len(baseline))
	for _, model := range baseline {
		known[model.ID] = model
	}
	models := make([]agentzv1alpha1.InferenceModel, 0, len(response.Data))
	for _, remote := range response.Data {
		if remote.Policy != nil && remote.Policy.State == "disabled" {
			continue
		}
		limits := remote.Capabilities.Limits
		supports := remote.Capabilities.Supports
		if limits == nil {
			continue
		}
		missingLimits := limits.Output == nil || limits.Prompt == nil
		if missingLimits || supports.ToolCalls == nil {
			continue
		}
		api := agentzv1alpha1.InferenceModelAPI("")
		switch {
		case slices.Contains(remote.SupportedEndpoints, "/v1/messages"):
			api = agentzv1alpha1.InferenceModelAPIMessages
		case slices.Contains(remote.SupportedEndpoints, "/responses"):
			api = agentzv1alpha1.InferenceModelAPIResponses
		case slices.Contains(remote.SupportedEndpoints, "/chat/completions"):
			api = agentzv1alpha1.InferenceModelAPIChatCompletions
		default:
			continue
		}
		missingIdentity := remote.ID == "" || remote.Name == ""
		invalidLimits := *limits.Output < 1 || *limits.Prompt < 1
		if missingIdentity || invalidLimits {
			continue
		}
		contextLimit := *limits.Prompt
		if limits.Context != nil {
			contextLimit = *limits.Context
		}
		if contextLimit < *limits.Prompt || contextLimit < *limits.Output {
			continue
		}
		image := supports.Vision
		if limits.Vision != nil {
			image = image || slices.ContainsFunc(
				limits.Vision.MediaTypes,
				func(mediaType string) bool { return strings.HasPrefix(mediaType, "image/") },
			)
		}
		model, ok := known[remote.ID]
		if !ok {
			model = agentzv1alpha1.InferenceModel{
				ID: remote.ID,
				Capabilities: agentzv1alpha1.InferenceModelCapabilities{
					Attachment: image, Temperature: true,
				},
				Modalities: agentzv1alpha1.InferenceModelModalities{
					Input:  []agentzv1alpha1.InferenceModelModality{agentzv1alpha1.InferenceModelModalityText},
					Output: []agentzv1alpha1.InferenceModelModality{agentzv1alpha1.InferenceModelModalityText},
				},
			}
			if image {
				model.Modalities.Input = append(
					model.Modalities.Input,
					agentzv1alpha1.InferenceModelModalityImage,
				)
			}
		}
		model.DisplayName = remote.Name
		model.Capabilities.Reasoning = model.Capabilities.Reasoning ||
			supports.AdaptiveThinking ||
			len(supports.ReasoningEffort) > 0 ||
			supports.MaxThinkingBudget != nil ||
			supports.MinThinkingBudget != nil
		model.Capabilities.ToolCall = *supports.ToolCalls
		model.Limits = agentzv1alpha1.InferenceModelLimits{
			Context: contextLimit,
			Input:   limits.Prompt,
			Output:  *limits.Output,
		}
		model.API = &api
		model.Catalog = &agentzv1alpha1.InferenceModelCatalog{Provider: "github-copilot"}
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil, "", fmt.Errorf("github copilot returned no eligible models")
	}
	slices.SortFunc(models, func(a, b agentzv1alpha1.InferenceModel) int {
		return strings.Compare(a.DisplayName, b.DisplayName)
	})
	return models, CatalogProvenanceLive, catalogErr
}

func modelsFromCatalog(provider catalogProvider, providerID string, providerKind agentzv1alpha1.InferenceProviderKind) []agentzv1alpha1.InferenceModel {
	models := make([]agentzv1alpha1.InferenceModel, 0, len(provider.Models))
	for key, model := range provider.Models {
		modelKind := catalogNPMKinds[provider.NPM]
		if catalogProviderKinds[providerID] != "" {
			modelKind = catalogProviderKinds[providerID]
		}
		if model.Provider != nil && model.Provider.NPM != "" {
			modelKind = catalogNPMKinds[model.Provider.NPM]
		}
		if providerID == "openai" && providerKind == agentzv1alpha1.InferenceProviderKindOpenAICodex {
			modelKind = providerKind
		}
		if modelKind != providerKind {
			continue
		}
		id := strings.TrimSpace(model.ID)
		if id == "" {
			id = key
		}
		if id == "" || strings.TrimSpace(model.Name) == "" || len(model.Modalities.Input) == 0 || len(model.Modalities.Output) == 0 || model.Limit.Context < 1 || model.Limit.Output < 1 {
			continue
		}
		value := agentzv1alpha1.InferenceModel{
			ID: id, DisplayName: model.Name,
			Capabilities: agentzv1alpha1.InferenceModelCapabilities{
				Attachment:  model.Attachment,
				Reasoning:   model.Reasoning,
				Temperature: model.Temperature,
				ToolCall:    model.ToolCall,
			},
			Modalities: agentzv1alpha1.InferenceModelModalities{
				Input:  slices.Clone(model.Modalities.Input),
				Output: slices.Clone(model.Modalities.Output),
			},
			Limits:  model.Limit,
			Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: providerID},
		}
		if providerKind == agentzv1alpha1.InferenceProviderKindOpenAICodex {
			api := agentzv1alpha1.InferenceModelAPIResponses
			value.API = &api
		}
		models = append(models, value)
	}
	slices.SortFunc(models, func(a, b agentzv1alpha1.InferenceModel) int {
		return strings.Compare(a.DisplayName, b.DisplayName)
	})
	return models
}

var catalogSnapshot = map[string][]agentzv1alpha1.InferenceModel{
	"openai": {{
		ID: "gpt-5-mini", DisplayName: "GPT-5 Mini",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment: true, Reasoning: true, ToolCall: true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input:  []agentzv1alpha1.InferenceModelModality{"text", "image"},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 400000, Output: 128000,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: "openai"},
	}},
	"anthropic": {{
		ID: "claude-sonnet-4-5", DisplayName: "Claude Sonnet 4.5",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment: true, Reasoning: true, Temperature: true, ToolCall: true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input: []agentzv1alpha1.InferenceModelModality{
				"text", "image", "pdf",
			},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 1000000, Output: 64000,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: "anthropic"},
	}},
	"google": {{
		ID: "gemini-2.5-pro", DisplayName: "Gemini 2.5 Pro",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment:  true,
			Reasoning:   true,
			Temperature: true,
			ToolCall:    true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input: []agentzv1alpha1.InferenceModelModality{
				"text", "image", "audio", "video", "pdf",
			},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 1048576,
			Output:  65536,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: "google"},
	}},
	"google-vertex": {{
		ID: "gemini-2.5-pro", DisplayName: "Gemini 2.5 Pro",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment:  true,
			Reasoning:   true,
			Temperature: true,
			ToolCall:    true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input: []agentzv1alpha1.InferenceModelModality{
				"text", "image", "audio", "video", "pdf",
			},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 1048576, Output: 65536,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: "google-vertex"},
	}},
	"amazon-bedrock": {{
		ID:          "anthropic.claude-sonnet-4-5-20250929-v1:0",
		DisplayName: "Claude Sonnet 4.5",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment:  true,
			Reasoning:   true,
			Temperature: true,
			ToolCall:    true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input: []agentzv1alpha1.InferenceModelModality{
				"text", "image", "pdf",
			},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 200000, Output: 64000,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{
			Provider: "amazon-bedrock",
		},
	}},
	"azure": {{
		ID: "gpt-5-mini", DisplayName: "GPT-5 Mini",
		Capabilities: agentzv1alpha1.InferenceModelCapabilities{
			Attachment: true,
			Reasoning:  true,
			ToolCall:   true,
		},
		Modalities: agentzv1alpha1.InferenceModelModalities{
			Input:  []agentzv1alpha1.InferenceModelModality{"text", "image"},
			Output: []agentzv1alpha1.InferenceModelModality{"text"},
		},
		Limits: agentzv1alpha1.InferenceModelLimits{
			Context: 400000, Output: 128000,
		},
		Catalog: &agentzv1alpha1.InferenceModelCatalog{Provider: "azure"},
	}},
}
