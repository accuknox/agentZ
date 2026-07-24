// Package inference owns provider validation, credential shapes, and runtime
// rendering for the tenant inference plane.
package inference

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	credentialAPIKey             = "apiKey"
	credentialBearerToken        = "bearerToken"
	credentialServiceAccountJSON = "serviceAccountJSON"
	credentialAccessKey          = "accessKey"
	credentialSecretKey          = "secretKey"
	credentialSessionToken       = "sessionToken"
	credentialClientID           = "clientID"
	credentialTenantID           = "tenantID"
	credentialClientSecret       = "clientSecret"

	// SandboxByProviderIndex indexes Sandboxes by referenced provider ID.
	SandboxByProviderIndex = "spec.inference.models.provider"
	// SandboxByProviderModelIndex indexes Sandboxes by provider and model ID.
	SandboxByProviderModelIndex = "spec.inference.models.providerModel"
)

var gatewayControlledHeaders = map[string]struct{}{
	"connection":          {},
	"content-encoding":    {},
	"content-length":      {},
	"content-type":        {},
	"cookie":              {},
	"forwarded":           {},
	"host":                {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"proxy-connection":    {},
	"set-cookie":          {},
	"te":                  {},
	"trailer":             {},
	"transfer-encoding":   {},
	"upgrade":             {},
	"x-forwarded-for":     {},
	"x-forwarded-host":    {},
	"x-forwarded-proto":   {},
}

var credentialHeaders = map[string]struct{}{
	"api-key":              {},
	"authorization":        {},
	"x-amz-security-token": {},
	"x-api-key":            {},
	"x-goog-api-key":       {},
}

var (
	headerNamePattern    = regexp.MustCompile(`^[a-z0-9!#$%&'*+.^_|~-]+$`)
	bedrockRegionPattern = regexp.MustCompile(`^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$`)
	providerPathPattern  = regexp.MustCompile(`^/[^?#]*$`)
)

// Issue identifies one invalid provider input field.
type Issue struct {
	Field   string
	Message string
}

// CredentialValues is the complete typed write-only credential input surface.
type CredentialValues struct {
	APIKey             string
	BearerToken        string
	ServiceAccountJSON string
	AccessKey          string
	SecretKey          string
	SessionToken       string
	ClientID           string
	TenantID           string
	ClientSecret       string
}

// InputError reports one invalid write-only credential field without its value.
type InputError struct {
	Field   string
	Message string
}

// Error returns a safe credential validation error.
func (e *InputError) Error() string {
	return e.Field + ": " + e.Message
}

type serviceAccount struct {
	Type        string `json:"type"`
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

// ValidateProvider defensively validates the provider union and safe endpoint
// controls before admission or rendering.
func ValidateProvider(spec agentzv1alpha1.InferenceProviderSpec) []Issue {
	issues := []Issue{}
	if strings.TrimSpace(spec.CatalogProvider) == "" {
		issues = append(issues, Issue{Field: "catalog_provider", Message: "field is required"})
	}
	isCompatible := spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICompatible || spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible
	isCatalogEntry := spec.CatalogProvider == "custom" && isCompatible
	for _, entry := range catalogEntries {
		if entry.ProviderID == spec.CatalogProvider && entry.Kind == spec.Kind {
			isCatalogEntry = true
			break
		}
	}
	if !isCatalogEntry {
		issues = append(issues, Issue{
			Field:   "catalog_provider",
			Message: "provider and kind are not supported together",
		})
	}
	if strings.TrimSpace(spec.DisplayName) == "" {
		issues = append(issues, Issue{Field: "display_name", Message: "field is required"})
	}
	if len(spec.Models) == 0 {
		issues = append(issues, Issue{Field: "models", Message: "at least one model is required"})
	}

	var arms int
	if spec.OpenAI != nil {
		arms++
	}
	if spec.Anthropic != nil {
		arms++
	}
	if spec.Gemini != nil {
		arms++
	}
	if spec.VertexAI != nil {
		arms++
	}
	if spec.Bedrock != nil {
		arms++
	}
	if spec.Azure != nil {
		arms++
	}
	if spec.OpenAICompatible != nil {
		arms++
	}
	if spec.AnthropicCompatible != nil {
		arms++
	}
	isSubscription := spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex ||
		spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	expectedArms := 1
	if isSubscription {
		expectedArms = 0
	}
	if arms != expectedArms {
		issues = append(issues, Issue{
			Field:   "kind",
			Message: "provider configuration does not match kind",
		})
	}

	switch spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAICodex:
		if spec.CatalogProvider != "openai" {
			issues = append(issues, Issue{
				Field:   "catalog_provider",
				Message: "openai codex requires the openai catalog",
			})
		}
	case agentzv1alpha1.InferenceProviderKindGitHubCopilot:
		if spec.CatalogProvider != "github-copilot" {
			issues = append(issues, Issue{
				Field:   "catalog_provider",
				Message: "github copilot requires the github-copilot catalog",
			})
		}
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		if spec.OpenAI == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "openai",
				Message: "configuration must match kind",
			})
			break
		}
		if spec.OpenAI.BaseURL != "" {
			issues = append(issues, validateEndpoint("openai.base_url", spec.OpenAI.BaseURL, false, false)...)
		}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		if spec.Anthropic == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "anthropic",
				Message: "configuration must match kind",
			})
			break
		}
		if spec.Anthropic.BaseURL != "" {
			issues = append(issues, validateEndpoint("anthropic.base_url", spec.Anthropic.BaseURL, false, false)...)
		}
	case agentzv1alpha1.InferenceProviderKindGemini:
		if spec.Gemini == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "gemini",
				Message: "configuration must match kind",
			})
			break
		}
		if spec.Gemini.BaseURL != "" {
			issues = append(issues, validateEndpoint("gemini.base_url", spec.Gemini.BaseURL, false, false)...)
		}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		if spec.VertexAI == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "vertex_ai",
				Message: "configuration must match kind",
			})
			break
		}
		if strings.TrimSpace(spec.VertexAI.Project) == "" {
			issues = append(issues, Issue{
				Field:   "vertex_ai.project",
				Message: "field is required",
			})
		}
		if strings.TrimSpace(spec.VertexAI.Region) == "" {
			issues = append(issues, Issue{
				Field:   "vertex_ai.region",
				Message: "field is required",
			})
		}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		if spec.Bedrock == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "bedrock",
				Message: "configuration must match kind",
			})
			break
		}
		if !bedrockRegionPattern.MatchString(spec.Bedrock.Region) {
			issues = append(issues, Issue{
				Field:   "bedrock.region",
				Message: "must be a valid AWS region",
			})
		}
		usesAccessKey := spec.Bedrock.AuthMode == agentzv1alpha1.BedrockAuthModeAccessKey
		usesBearerToken := spec.Bedrock.AuthMode == agentzv1alpha1.BedrockAuthModeBearerToken
		if !usesAccessKey && !usesBearerToken {
			issues = append(issues, Issue{
				Field:   "bedrock.auth_mode",
				Message: "unsupported authentication mode",
			})
		}
	case agentzv1alpha1.InferenceProviderKindAzure:
		if spec.Azure == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   "azure",
				Message: "configuration must match kind",
			})
			break
		}
		if strings.TrimSpace(spec.Azure.ResourceName) == "" {
			issues = append(issues, Issue{
				Field:   "azure.resource_name",
				Message: "field is required",
			})
		}
		if spec.Azure.ResourceType == agentzv1alpha1.AzureResourceTypeFoundry && strings.TrimSpace(spec.Azure.Project) == "" {
			issues = append(issues, Issue{
				Field:   "azure.project",
				Message: "field is required for Foundry",
			})
		}
		if spec.Azure.ResourceType == agentzv1alpha1.AzureResourceTypeOpenAI && spec.Azure.Project != "" {
			issues = append(issues, Issue{
				Field:   "azure.project",
				Message: "field is valid only for Foundry",
			})
		}
	case agentzv1alpha1.InferenceProviderKindOpenAICompatible,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		cfg := spec.OpenAICompatible
		field := "openai_compatible"
		if spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible {
			cfg = spec.AnthropicCompatible
			field = "anthropic_compatible"
		}
		if cfg == nil || arms != 1 {
			issues = append(issues, Issue{
				Field:   field,
				Message: "configuration must match kind",
			})
			break
		}
		issues = append(issues, validateEndpoint(field+".base_url", cfg.BaseURL, cfg.AllowPrivateEndpoint, cfg.SkipTLSVerify)...)
		if cfg.Path != "" && cfg.PathPrefix != "" {
			issues = append(issues, Issue{
				Field:   field + ".path_prefix",
				Message: "path and path prefix are mutually exclusive",
			})
		}
		if cfg.Path != "" && !providerPathPattern.MatchString(cfg.Path) {
			issues = append(issues, Issue{
				Field:   field + ".path",
				Message: "must be an absolute path without query or fragment",
			})
		}
		if cfg.PathPrefix != "" && !providerPathPattern.MatchString(cfg.PathPrefix) {
			issues = append(issues, Issue{
				Field:   field + ".path_prefix",
				Message: "must be an absolute path without query or fragment",
			})
		}
		if cfg.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeAPIKey && cfg.AuthHeader == "" {
			issues = append(issues, Issue{
				Field:   field + ".auth_header",
				Message: "field is required",
			})
		}
		authDisabled := cfg.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeNone
		hasAuthSettings := cfg.AuthHeader != "" || cfg.AuthPrefix != ""
		if authDisabled && hasAuthSettings {
			issues = append(issues, Issue{
				Field:   field + ".auth_mode",
				Message: "authentication settings require api-key authentication",
			})
		}
		invalidAuthPrefix := strings.IndexFunc(cfg.AuthPrefix, func(r rune) bool { return r == 0x7f || (r < 0x20 && r != '\t') }) >= 0
		if invalidAuthPrefix {
			issues = append(issues, Issue{
				Field:   field + ".auth_prefix",
				Message: "must not contain invalid header control characters",
			})
		}
		if cfg.AuthHeader != "" {
			if cfg.AuthHeader != strings.ToLower(cfg.AuthHeader) || !headerNamePattern.MatchString(cfg.AuthHeader) {
				issues = append(issues, Issue{
					Field:   field + ".auth_header",
					Message: "must be a valid lowercase header name",
				})
			}
			if _, forbidden := gatewayControlledHeaders[cfg.AuthHeader]; forbidden {
				issues = append(issues, Issue{
					Field:   field + ".auth_header",
					Message: "header is controlled by the gateway",
				})
			}
		}
		seen := make(map[string]struct{}, len(cfg.Headers))
		for i, header := range cfg.Headers {
			headerField := fmt.Sprintf("%s.headers.%d.name", field, i)
			if header.Name != strings.ToLower(header.Name) {
				issues = append(issues, Issue{
					Field:   headerField,
					Message: "header name must be lowercase",
				})
			}
			if !headerNamePattern.MatchString(header.Name) {
				issues = append(issues, Issue{
					Field:   headerField,
					Message: "must be a valid header name",
				})
			}
			if len(header.Value) < 1 || len(header.Value) > 1024 {
				issues = append(issues, Issue{
					Field:   fmt.Sprintf("%s.headers.%d.value", field, i),
					Message: "must contain between 1 and 1024 characters",
				})
			}
			invalidValue := strings.IndexFunc(header.Value, func(r rune) bool { return r == 0x7f || (r < 0x20 && r != '\t') }) >= 0
			if invalidValue {
				issues = append(issues, Issue{
					Field:   fmt.Sprintf("%s.headers.%d.value", field, i),
					Message: "must not contain invalid header control characters",
				})
			}
			if _, exists := seen[header.Name]; exists {
				issues = append(issues, Issue{Field: headerField, Message: "header name must be unique"})
			}
			seen[header.Name] = struct{}{}
			_, controlled := gatewayControlledHeaders[header.Name]
			_, credential := credentialHeaders[header.Name]
			if header.Name == cfg.AuthHeader {
				issues = append(issues, Issue{
					Field:   headerField,
					Message: "header conflicts with authentication",
				})
				continue
			}
			if controlled || credential {
				issues = append(issues, Issue{
					Field:   headerField,
					Message: "header is controlled by the gateway",
				})
			}
		}
	default:
		issues = append(issues, Issue{
			Field:   "kind",
			Message: "unsupported provider kind",
		})
	}

	seenModels := make(map[string]struct{}, len(spec.Models))
	for i, model := range spec.Models {
		field := fmt.Sprintf("models.%d", i)
		if strings.TrimSpace(model.ID) == "" {
			issues = append(issues, Issue{
				Field:   field + ".id",
				Message: "field is required",
			})
		}
		if _, exists := seenModels[model.ID]; exists {
			issues = append(issues, Issue{
				Field:   field + ".id",
				Message: "model id must be unique",
			})
		}
		seenModels[model.ID] = struct{}{}
		if strings.TrimSpace(model.DisplayName) == "" {
			issues = append(issues, Issue{
				Field:   field + ".display_name",
				Message: "field is required",
			})
		}
		if len(model.Modalities.Input) == 0 || len(model.Modalities.Output) == 0 {
			issues = append(issues, Issue{
				Field:   field + ".modalities",
				Message: "input and output are required",
			})
		}
		if model.Limits.Context < 1 || model.Limits.Output < 1 {
			issues = append(issues, Issue{
				Field:   field + ".limits",
				Message: "context and output must be positive",
			})
		}
		if model.Limits.Output > model.Limits.Context {
			issues = append(issues, Issue{
				Field:   field + ".limits.output",
				Message: "cannot exceed context",
			})
		}
		if model.Limits.Input != nil && *model.Limits.Input > model.Limits.Context {
			issues = append(issues, Issue{
				Field:   field + ".limits.input",
				Message: "cannot exceed context",
			})
		}
		if model.Limits.Input != nil && *model.Limits.Input < 1 {
			issues = append(issues, Issue{
				Field:   field + ".limits.input",
				Message: "must be positive",
			})
		}
		if model.Catalog != nil && model.Catalog.Provider != spec.CatalogProvider {
			issues = append(issues, Issue{
				Field:   field + ".catalog_provider",
				Message: "must match the provider catalog",
			})
		}
		if isSubscription && model.API == nil {
			issues = append(issues, Issue{
				Field:   field + ".api",
				Message: "subscription models require a discovered api",
			})
		}
		if !isSubscription && model.API != nil {
			issues = append(issues, Issue{
				Field:   field + ".api",
				Message: "api is managed only for subscription models",
			})
		}
	}
	return issues
}

// ValidateModelRemoval rejects removal of models referenced by Pools or Sandboxes.
func ValidateModelRemoval(ctx context.Context, reader client.Reader, current, desired *agentzv1alpha1.InferenceProvider) ([]Issue, error) {
	desiredModels := make(map[string]struct{}, len(desired.Spec.Models))
	for _, model := range desired.Spec.Models {
		desiredModels[model.ID] = struct{}{}
	}
	issues := []Issue{}
	for _, model := range current.Spec.Models {
		if _, exists := desiredModels[model.ID]; exists {
			continue
		}
		pools := &agentzv1alpha1.InferencePoolList{}
		err := reader.List(
			ctx,
			pools,
			client.InNamespace(desired.Namespace),
			client.MatchingFields{PoolByProviderIndex: desired.Name},
		)
		if err != nil {
			return nil, fmt.Errorf("list pools referencing provider model: %w", err)
		}
		poolNames := []string{}
		for _, pool := range pools.Items {
			for _, member := range pool.Spec.Members {
				if member.Provider == desired.Name && member.Model == model.ID {
					poolNames = append(poolNames, pool.Name)
					break
				}
			}
		}
		if len(poolNames) > 0 {
			slices.Sort(poolNames)
			issues = append(issues, Issue{
				Field: "models",
				Message: fmt.Sprintf(
					"model %q is referenced by pools %v", model.ID, poolNames,
				),
			})
			continue
		}
		sandboxes := &agentzv1alpha1.SandboxList{}
		err = reader.List(
			ctx,
			sandboxes,
			client.InNamespace(desired.Namespace),
			client.MatchingFields{
				SandboxByProviderModelIndex: desired.Name + "\x00" + model.ID,
			},
		)
		if err != nil {
			return nil, fmt.Errorf("list sandboxes referencing provider model: %w", err)
		}
		if len(sandboxes.Items) == 0 {
			continue
		}
		names := make([]string, 0, len(sandboxes.Items))
		for _, sandbox := range sandboxes.Items {
			names = append(names, sandbox.Name)
		}
		slices.Sort(names)
		issues = append(issues, Issue{
			Field: "models",
			Message: fmt.Sprintf(
				"model %q is referenced by sandboxes %v", model.ID, names,
			),
		})
	}
	return issues, nil
}

func validateEndpoint(field, value string, allowPrivateEndpoint, skipTLSVerify bool) []Issue {
	issues := []Issue{}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" {
		return []Issue{{Field: field, Message: "must be an absolute endpoint url"}}
	}
	if parsed.User != nil {
		issues = append(issues, Issue{
			Field:   field,
			Message: "embedded credentials are forbidden",
		})
	}
	if parsed.Port() != "" {
		port, err := strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			issues = append(issues, Issue{
				Field:   field,
				Message: "port must be between 1 and 65535",
			})
		}
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		issues = append(issues, Issue{
			Field:   field,
			Message: "query and fragment are forbidden",
		})
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		issues = append(issues, Issue{
			Field:   field,
			Message: "scheme must be https or explicitly allowed http",
		})
	}
	if parsed.Scheme == "http" && !allowPrivateEndpoint {
		issues = append(issues, Issue{
			Field:   field,
			Message: "http requires private endpoint access",
		})
	}
	if parsed.Scheme == "https" && isPrivateHost(parsed.Hostname()) && !allowPrivateEndpoint {
		issues = append(issues, Issue{
			Field:   field,
			Message: "private endpoints require private endpoint access",
		})
	}
	if parsed.Scheme == "http" && skipTLSVerify {
		issues = append(issues, Issue{
			Field:   field,
			Message: "tls verification does not apply to http",
		})
	}
	return issues
}

func isPrivateHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	isLocalhost := host == "localhost" || strings.HasSuffix(host, ".localhost")
	isLocalName := strings.HasSuffix(host, ".local") || !strings.Contains(host, ".")
	if isLocalhost || isLocalName {
		return true
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// CredentialsForCreate validates and returns the complete OpenBao record for a
// newly created provider. A nil record means credentials are not required.
func CredentialsForCreate(spec agentzv1alpha1.InferenceProviderSpec, values CredentialValues) (map[string]any, error) {
	record, changed, err := CredentialsForUpdate(spec, values)
	if err != nil {
		return nil, err
	}
	isCompatible := spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICompatible ||
		spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible
	if !changed && !isCompatible {
		return nil, &InputError{Field: "credentials", Message: "complete credentials are required"}
	}
	cfg := spec.OpenAICompatible
	if spec.AnthropicCompatible != nil {
		cfg = spec.AnthropicCompatible
	}
	if !changed && cfg != nil && cfg.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeAPIKey {
		return nil, &InputError{Field: "credentials.api_key", Message: "field is required"}
	}
	return record, nil
}

// CredentialsForUpdate validates complete replacement semantics. A nil record
// and false changed result means the stored record must remain untouched.
func CredentialsForUpdate(spec agentzv1alpha1.InferenceProviderSpec, values CredentialValues) (map[string]any, bool, error) {
	hasAPIKey := strings.TrimSpace(values.APIKey) != ""
	hasBearerToken := strings.TrimSpace(values.BearerToken) != ""
	hasServiceAccount := strings.TrimSpace(values.ServiceAccountJSON) != ""
	hasAWS := strings.TrimSpace(values.AccessKey) != "" || strings.TrimSpace(values.SecretKey) != "" ||
		strings.TrimSpace(values.SessionToken) != ""
	hasAzure := strings.TrimSpace(values.ClientID) != "" || strings.TrimSpace(values.TenantID) != "" ||
		strings.TrimSpace(values.ClientSecret) != ""

	switch spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAICodex,
		agentzv1alpha1.InferenceProviderKindGitHubCopilot:
		if hasAPIKey || hasBearerToken || hasServiceAccount || hasAWS || hasAzure {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "subscription credentials require an oauth ticket",
			}
		}
		return nil, false, nil
	case agentzv1alpha1.InferenceProviderKindOpenAI,
		agentzv1alpha1.InferenceProviderKindAnthropic,
		agentzv1alpha1.InferenceProviderKindGemini:
		if hasBearerToken || hasServiceAccount || hasAWS || hasAzure {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match provider kind",
			}
		}
		if !hasAPIKey {
			return nil, false, nil
		}
		return map[string]any{credentialAPIKey: values.APIKey}, true, nil
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		if hasAPIKey || hasBearerToken || hasAWS || hasAzure {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match provider kind",
			}
		}
		if !hasServiceAccount {
			return nil, false, nil
		}
		var account serviceAccount
		if err := json.Unmarshal([]byte(values.ServiceAccountJSON), &account); err != nil {
			return nil, false, &InputError{
				Field:   "credentials.service_account_json",
				Message: "must be valid json",
			}
		}
		isComplete := account.Type == "service_account" && account.ProjectID != "" &&
			account.PrivateKey != "" && account.ClientEmail != "" && account.TokenURI != ""
		if !isComplete {
			return nil, false, &InputError{
				Field:   "credentials.service_account_json",
				Message: "must be a complete service-account document",
			}
		}
		return map[string]any{credentialServiceAccountJSON: values.ServiceAccountJSON}, true, nil
	case agentzv1alpha1.InferenceProviderKindBedrock:
		if hasAPIKey || hasServiceAccount || hasAzure {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match provider kind",
			}
		}
		if spec.Bedrock == nil {
			return nil, false, &InputError{
				Field:   "bedrock",
				Message: "configuration must match provider kind",
			}
		}
		if spec.Bedrock.AuthMode == agentzv1alpha1.BedrockAuthModeBearerToken {
			if hasAWS {
				return nil, false, &InputError{
					Field:   "credentials",
					Message: "credential shape does not match authentication mode",
				}
			}
			if !hasBearerToken {
				return nil, false, nil
			}
			return map[string]any{credentialBearerToken: values.BearerToken}, true, nil
		}
		if hasBearerToken {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match authentication mode",
			}
		}
		if !hasAWS {
			return nil, false, nil
		}
		if strings.TrimSpace(values.AccessKey) == "" || strings.TrimSpace(values.SecretKey) == "" {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "access key and secret key are required together",
			}
		}
		record := map[string]any{
			credentialAccessKey: values.AccessKey,
			credentialSecretKey: values.SecretKey,
		}
		if values.SessionToken != "" {
			record[credentialSessionToken] = values.SessionToken
		}
		return record, true, nil
	case agentzv1alpha1.InferenceProviderKindAzure:
		if spec.Azure == nil {
			return nil, false, &InputError{
				Field:   "azure",
				Message: "configuration must match provider kind",
			}
		}
		if spec.Azure.AuthMode == agentzv1alpha1.AzureAuthModeAPIKey {
			if hasBearerToken || hasServiceAccount || hasAWS || hasAzure {
				return nil, false, &InputError{
					Field:   "credentials",
					Message: "credential shape does not match authentication mode",
				}
			}
			if !hasAPIKey {
				return nil, false, nil
			}
			return map[string]any{credentialAPIKey: values.APIKey}, true, nil
		}
		if hasAPIKey || hasBearerToken || hasServiceAccount || hasAWS {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match authentication mode",
			}
		}
		if !hasAzure {
			return nil, false, nil
		}
		isComplete := strings.TrimSpace(values.ClientID) != "" && strings.TrimSpace(values.TenantID) != "" && strings.TrimSpace(values.ClientSecret) != ""
		if !isComplete {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "client id, tenant id, and client secret are required together",
			}
		}
		return map[string]any{
			credentialClientID: values.ClientID, credentialTenantID: values.TenantID,
			credentialClientSecret: values.ClientSecret,
		}, true, nil
	case agentzv1alpha1.InferenceProviderKindOpenAICompatible,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		cfg := spec.OpenAICompatible
		field := "openai_compatible"
		if spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible {
			cfg = spec.AnthropicCompatible
			field = "anthropic_compatible"
		}
		if cfg == nil {
			return nil, false, &InputError{
				Field:   field,
				Message: "configuration must match provider kind",
			}
		}
		if hasBearerToken || hasServiceAccount || hasAWS || hasAzure {
			return nil, false, &InputError{
				Field:   "credentials",
				Message: "credential shape does not match provider kind",
			}
		}
		if cfg.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeNone {
			if hasAPIKey {
				return nil, false, &InputError{
					Field:   "credentials",
					Message: "credentials are forbidden for no-auth providers",
				}
			}
			return nil, false, nil
		}
		if !hasAPIKey {
			return nil, false, nil
		}
		return map[string]any{credentialAPIKey: values.APIKey}, true, nil
	default:
		return nil, false, &InputError{Field: "kind", Message: "unsupported provider kind"}
	}
}

// IndexSandboxes registers provider and provider/model reference indexes.
func IndexSandboxes(ctx context.Context, idx client.FieldIndexer) error {
	err := idx.IndexField(
		ctx,
		&agentzv1alpha1.Sandbox{},
		SandboxByProviderIndex,
		func(obj client.Object) []string {
			sandbox := obj.(*agentzv1alpha1.Sandbox)
			values := make([]string, 0, len(sandbox.Spec.Inference.Models))
			seen := make(map[string]struct{}, len(sandbox.Spec.Inference.Models))
			for _, model := range sandbox.Spec.Inference.Models {
				if model.Provider == agentzv1alpha1.InferencePoolProvider {
					continue
				}
				if _, exists := seen[model.Provider]; exists {
					continue
				}
				seen[model.Provider] = struct{}{}
				values = append(values, model.Provider)
			}
			return values
		},
	)
	if err != nil {
		return fmt.Errorf("index sandboxes by inference provider: %w", err)
	}
	return idx.IndexField(
		ctx,
		&agentzv1alpha1.Sandbox{},
		SandboxByProviderModelIndex,
		func(obj client.Object) []string {
			sandbox := obj.(*agentzv1alpha1.Sandbox)
			values := make([]string, 0, len(sandbox.Spec.Inference.Models))
			for _, model := range sandbox.Spec.Inference.Models {
				if model.Provider == agentzv1alpha1.InferencePoolProvider {
					continue
				}
				values = append(values, model.Provider+"\x00"+model.Model)
			}
			return values
		},
	)
}
