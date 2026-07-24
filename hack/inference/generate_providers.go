package main

import (
	"encoding/json"
	"fmt"
	"go/format"
	"io"
	"log"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
)

const (
	opencodeCommit = "a19b52e85bf2630b86157030e2cf7c9fc20ce552"
	catalogURL     = "https://raw.githubusercontent.com/anomalyco/opencode/" + opencodeCommit + "/packages/opencode/test/tool/fixtures/models-api.json"
	catalogOutput  = "internal/inference/providers.go"
)

type provider struct {
	ID     string           `json:"id"`
	Name   string           `json:"name"`
	NPM    string           `json:"npm"`
	API    string           `json:"api"`
	Doc    string           `json:"doc"`
	Models map[string]model `json:"models"`
}

type model struct {
	Provider *modelProvider `json:"provider"`
}

type modelProvider struct {
	NPM string `json:"npm"`
}

type entry struct {
	ProviderID      string
	Name            string
	Kind            string
	BaseURL         string
	BaseURLTemplate string
	AuthHeader      string
	AuthPrefix      string
	Doc             string
}

var excluded = map[string]string{
	"gitlab":      "GitLab Duo uses a provider-specific agentic protocol",
	"sap-ai-core": "SAP AI Core requires service-key token and deployment discovery",
}

var npmKinds = map[string]string{
	"@ai-sdk/amazon-bedrock":          "Bedrock",
	"@ai-sdk/anthropic":               "AnthropicCompatible",
	"@ai-sdk/azure":                   "Azure",
	"@ai-sdk/cerebras":                "OpenAICompatible",
	"@ai-sdk/cohere":                  "OpenAICompatible",
	"@ai-sdk/deepinfra":               "OpenAICompatible",
	"@ai-sdk/gateway":                 "OpenAICompatible",
	"@ai-sdk/google":                  "Gemini",
	"@ai-sdk/google-vertex":           "VertexAI",
	"@ai-sdk/google-vertex/anthropic": "VertexAI",
	"@ai-sdk/groq":                    "OpenAICompatible",
	"@ai-sdk/mistral":                 "OpenAICompatible",
	"@ai-sdk/openai":                  "OpenAICompatible",
	"@ai-sdk/openai-compatible":       "OpenAICompatible",
	"@ai-sdk/perplexity":              "OpenAICompatible",
	"@ai-sdk/togetherai":              "OpenAICompatible",
	"@ai-sdk/vercel":                  "OpenAICompatible",
	"@ai-sdk/xai":                     "OpenAICompatible",
	"@aihubmix/ai-sdk-provider":       "OpenAICompatible",
	"@openrouter/ai-sdk-provider":     "OpenAICompatible",
	"ai-gateway-provider":             "OpenAICompatible",
	"merge-gateway-ai-sdk-provider":   "OpenAICompatible",
	"venice-ai-sdk-provider":          "OpenAICompatible",
}

var providerKinds = map[string]string{
	"amazon-bedrock":           "Bedrock",
	"anthropic":                "Anthropic",
	"azure":                    "Azure",
	"azure-cognitive-services": "Azure",
	"cloudflare-ai-gateway":    "OpenAICompatible",
	"google":                   "Gemini",
	"google-vertex":            "VertexAI",
	"google-vertex-anthropic":  "VertexAI",
	"github-copilot":           "GitHubCopilot",
	"openai":                   "OpenAI",
}

var baseURLs = map[string]string{
	"aihubmix":              "https://aihubmix.com/v1",
	"cerebras":              "https://api.cerebras.ai/v1",
	"cloudflare-ai-gateway": "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat",
	"cohere":                "https://api.cohere.ai/compatibility/v1",
	"deepinfra":             "https://api.deepinfra.com/v1/openai",
	"groq":                  "https://api.groq.com/openai/v1",
	"merge-gateway":         "https://api-gateway.merge.dev/v1/openai",
	"mistral":               "https://api.mistral.ai/v1",
	"perplexity":            "https://api.perplexity.ai",
	"togetherai":            "https://api.together.xyz/v1",
	"v0":                    "https://api.v0.dev/v1",
	"venice":                "https://api.venice.ai/api/v1",
	"vercel":                "https://ai-gateway.vercel.sh/v1",
	"xai":                   "https://api.x.ai/v1",
}

func main() {
	resp, err := http.Get(catalogURL)
	if err != nil {
		log.Fatal(fmt.Errorf("fetch catalog: %w", err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("fetch catalog: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		log.Fatal(fmt.Errorf("read catalog: %w", err))
	}
	providers := map[string]provider{}
	if err := json.Unmarshal(body, &providers); err != nil {
		log.Fatal(fmt.Errorf("decode catalog: %w", err))
	}
	if len(providers) != 159 {
		log.Fatalf("catalog has %d providers, want 159", len(providers))
	}

	entries := make([]entry, 0, len(providers))
	supported := 0
	for id, provider := range providers {
		if reason := excluded[id]; reason != "" {
			continue
		}
		supported++
		kinds := map[string]struct{}{}
		forced := providerKinds[id]
		if forced != "" {
			kinds[forced] = struct{}{}
		}
		if forced == "" {
			for _, model := range provider.Models {
				npm := provider.NPM
				if model.Provider != nil && model.Provider.NPM != "" {
					npm = model.Provider.NPM
				}
				providerKind, ok := npmKinds[npm]
				if !ok {
					log.Fatalf("provider %q uses unsupported npm package %q", id, npm)
				}
				kinds[providerKind] = struct{}{}
			}
		}
		if len(kinds) == 0 {
			log.Fatalf("provider %q has no runtime kind", id)
		}
		baseURL := provider.API
		if baseURL == "" {
			baseURL = baseURLs[id]
		}
		baseURLTemplate := ""
		if strings.Contains(baseURL, "${") {
			baseURLTemplate = baseURL
			baseURL = ""
		}
		for providerKind := range kinds {
			profile := entry{
				ProviderID:      id,
				Name:            provider.Name,
				Kind:            providerKind,
				BaseURL:         strings.TrimSuffix(baseURL, "/"),
				BaseURLTemplate: baseURLTemplate,
				Doc:             provider.Doc,
			}
			if providerKind == "OpenAICompatible" {
				profile.AuthHeader = "authorization"
				profile.AuthPrefix = "Bearer "
			}
			if providerKind == "AnthropicCompatible" {
				profile.AuthHeader = "x-api-key"
			}
			if id == "cloudflare-ai-gateway" {
				profile.AuthHeader = "cf-aig-authorization"
				profile.AuthPrefix = "Bearer "
			}
			entries = append(entries, profile)
		}
		if id == "openai" {
			entries = append(entries, entry{
				ProviderID: id,
				Name:       "OpenAI Codex",
				Kind:       "OpenAICodex",
				Doc:        provider.Doc,
			})
		}
	}
	if supported != 157 {
		log.Fatalf("catalog has %d supported providers, want 157", supported)
	}
	slices.SortFunc(entries, func(a, b entry) int {
		if order := strings.Compare(a.Name, b.Name); order != 0 {
			return order
		}
		if order := strings.Compare(a.ProviderID, b.ProviderID); order != 0 {
			return order
		}
		return strings.Compare(a.Kind, b.Kind)
	})

	var output strings.Builder
	output.WriteString("// Code generated by hack/inference/generate_providers.go; DO NOT EDIT.\n\n")
	output.WriteString("package inference\n\n")
	output.WriteString("import agentzv1alpha1 \"github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1\"\n\n")
	output.WriteString("const catalogCommit = ")
	output.WriteString(strconv.Quote(opencodeCommit))
	output.WriteString("\n\nvar catalogEntries = []CatalogEntry{\n")
	for _, entry := range entries {
		fmt.Fprintf(
			&output,
			"\t{\n\t\tProviderID: %q,\n\t\tName: %q,\n\t\tKind: agentzv1alpha1.InferenceProviderKind%s,\n\t\tBaseURL: %q,\n\t\tBaseURLTemplate: %q,\n\t\tAuthHeader: %q,\n\t\tAuthPrefix: %q,\n\t\tDoc: %q,\n\t},\n",
			entry.ProviderID,
			entry.Name,
			entry.Kind,
			entry.BaseURL,
			entry.BaseURLTemplate,
			entry.AuthHeader,
			entry.AuthPrefix,
			entry.Doc,
		)
	}
	output.WriteString("}\n\nvar catalogNPMKinds = map[string]agentzv1alpha1.InferenceProviderKind{\n")
	npms := make([]string, 0, len(npmKinds))
	for npm := range npmKinds {
		npms = append(npms, npm)
	}
	slices.Sort(npms)
	for _, npm := range npms {
		fmt.Fprintf(&output, "\t%q: agentzv1alpha1.InferenceProviderKind%s,\n", npm, npmKinds[npm])
	}
	output.WriteString("}\n\nvar catalogProviderKinds = map[string]agentzv1alpha1.InferenceProviderKind{\n")
	ids := make([]string, 0, len(providerKinds))
	for id := range providerKinds {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		fmt.Fprintf(&output, "\t%q: agentzv1alpha1.InferenceProviderKind%s,\n", id, providerKinds[id])
	}
	output.WriteString("}\n")

	raw := output.String()
	formatted, err := format.Source([]byte(raw))
	if err != nil {
		log.Fatal(fmt.Errorf("format catalog: %w", err))
	}
	if err := os.WriteFile(catalogOutput, formatted, 0o644); err != nil {
		log.Fatal(fmt.Errorf("write catalog: %w", err))
	}
}
