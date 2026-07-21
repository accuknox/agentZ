package inference

import (
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
	modelsDevURL      = "https://models.dev/api.json"
	modelsDevMaxBytes = 8 << 20
	catalogLifetime   = 24 * time.Hour
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
		if query == "" || strings.Contains(strings.ToLower(entry.Name), query) ||
			strings.Contains(entry.ProviderID, query) {
			entries = append(entries, entry)
		}
	}
	for _, entry := range catalogEntries {
		if query != "" && !strings.Contains(strings.ToLower(entry.Name), query) &&
			!strings.Contains(entry.ProviderID, query) {
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

func modelsFromCatalog(provider catalogProvider, providerID string, providerKind agentzv1alpha1.InferenceProviderKind) []agentzv1alpha1.InferenceModel {
	models := make([]agentzv1alpha1.InferenceModel, 0, len(provider.Models))
	for key, model := range provider.Models {
		modelKind := catalogProviderKinds[providerID]
		if modelKind == "" {
			npm := provider.NPM
			if model.Provider != nil && model.Provider.NPM != "" {
				npm = model.Provider.NPM
			}
			modelKind = catalogNPMKinds[npm]
		}
		if modelKind != providerKind {
			continue
		}
		id := strings.TrimSpace(model.ID)
		if id == "" {
			id = key
		}
		if id == "" || strings.TrimSpace(model.Name) == "" ||
			len(model.Modalities.Input) == 0 || len(model.Modalities.Output) == 0 ||
			model.Limit.Context < 1 || model.Limit.Output < 1 {
			continue
		}
		models = append(models, agentzv1alpha1.InferenceModel{
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
		})
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
