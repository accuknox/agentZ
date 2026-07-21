package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	baoapi "github.com/openbao/openbao/api/v2"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const providerUpdatedAtAnnotation = "agentz.accuknox.com/inference-provider-updated-at"

type providerInput struct {
	DisplayName     string
	CatalogProvider string
	Kind            gatewayapi.InferenceProviderKind
	OpenAI          *gatewayapi.OpenAIProviderConfig
	Anthropic       *gatewayapi.AnthropicProviderConfig
	Gemini          *gatewayapi.GeminiProviderConfig
	VertexAI        *gatewayapi.VertexAIProviderConfig
	Bedrock         *gatewayapi.BedrockProviderConfig
	Azure           *gatewayapi.AzureProviderConfig
	Compatible      *gatewayapi.CompatibleProviderConfig
	Models          []gatewayapi.InferenceModel
	Credentials     inference.CredentialValues
}

type providerWriter interface {
	Discriminator() (string, error)
	AsOpenAIInferenceProviderWrite() (gatewayapi.OpenAIInferenceProviderWrite, error)
	AsAnthropicInferenceProviderWrite() (gatewayapi.AnthropicInferenceProviderWrite, error)
	AsGeminiInferenceProviderWrite() (gatewayapi.GeminiInferenceProviderWrite, error)
	AsVertexAIInferenceProviderWrite() (gatewayapi.VertexAIInferenceProviderWrite, error)
	AsBedrockInferenceProviderWrite() (gatewayapi.BedrockInferenceProviderWrite, error)
	AsAzureInferenceProviderWrite() (gatewayapi.AzureInferenceProviderWrite, error)
	AsOpenAICompatibleInferenceProviderWrite() (gatewayapi.OpenAICompatibleInferenceProviderWrite, error)
	AsAnthropicCompatibleInferenceProviderWrite() (gatewayapi.AnthropicCompatibleInferenceProviderWrite, error)
}

// ListInferenceProviders handles GET /api/inference-provider.
func (s *Service) ListInferenceProviders(w http.ResponseWriter, r *http.Request, params gatewayapi.ListInferenceProvidersParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}
	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	items, err := s.listInferenceProviderItems(r.Context(), ns, nil)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	start := min(offset, len(items))
	end := min(start+limit, len(items))
	next := ""
	if end < len(items) {
		next = encodeOffsetToken(end)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListInferenceProvidersResponse{
		Providers: items[start:end], NextPageToken: next,
	})
}

// WatchInferenceProviders handles POST /api/inference-provider/watch.
func (s *Service) WatchInferenceProviders(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	var req gatewayapi.WatchInferenceProvidersRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}
	var filter map[string]struct{}
	if req.ProviderIds != nil {
		filter = make(map[string]struct{}, len(*req.ProviderIds))
		for _, name := range *req.ProviderIds {
			filter[name] = struct{}{}
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"streaming is unavailable",
			nil,
		))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	var previous []gatewayapi.InferenceProvider
	writeChanges := func() bool {
		items, err := s.listInferenceProviderItems(r.Context(), ns, filter)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				recordRequestError(w, "internal_error", err)
			}
			return false
		}
		if reflect.DeepEqual(previous, items) {
			return true
		}
		previous = items
		raw, err := json.Marshal(gatewayapi.WatchInferenceProvidersEvent{Providers: items})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !writeChanges() {
		return
	}
	providers, err := s.agentz.AgentzV1alpha1().InferenceProviders(ns).Watch(
		r.Context(),
		metav1.ListOptions{},
	)
	if err != nil {
		recordRequestError(w, "internal_error", fmt.Errorf("watch inference providers: %w", err))
		return
	}
	defer providers.Stop()
	sandboxes, err := s.agentz.AgentzV1alpha1().Sandboxes(ns).Watch(
		r.Context(),
		metav1.ListOptions{},
	)
	if err != nil {
		recordRequestError(w, "internal_error", fmt.Errorf("watch provider usage: %w", err))
		return
	}
	defer sandboxes.Stop()
	// Close the list-to-watch gap after both watches are established. Any
	// subsequent change is retained by its watch until the loop consumes it.
	if !writeChanges() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case _, ok := <-providers.ResultChan():
			if !ok || !writeChanges() {
				return
			}
		case _, ok := <-sandboxes.ResultChan():
			if !ok || !writeChanges() {
				return
			}
		}
	}
}

func (s *Service) listInferenceProviderItems(ctx context.Context, namespace string, filter map[string]struct{}) ([]gatewayapi.InferenceProvider, error) {
	providers := &agentzv1alpha1.InferenceProviderList{}
	if err := s.k8sClient.List(ctx, providers, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list inference providers: %w", err)
	}
	slices.SortFunc(providers.Items, func(a, b agentzv1alpha1.InferenceProvider) int {
		return strings.Compare(a.Name, b.Name)
	})
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := s.usageReader.List(ctx, sandboxes, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list inference provider usage: %w", err)
	}
	usage := make(map[string]int)
	for i := range sandboxes.Items {
		seen := make(map[string]struct{}, len(sandboxes.Items[i].Spec.Inference.Models))
		for _, model := range sandboxes.Items[i].Spec.Inference.Models {
			if _, ok := seen[model.Provider]; ok {
				continue
			}
			seen[model.Provider] = struct{}{}
			usage[model.Provider]++
		}
	}
	items := make([]gatewayapi.InferenceProvider, 0, len(providers.Items))
	for i := range providers.Items {
		if filter != nil {
			if _, ok := filter[providers.Items[i].Name]; !ok {
				continue
			}
		}
		item, err := providerToAPI(&providers.Items[i], usage[providers.Items[i].Name])
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

// CreateInferenceProvider handles POST /api/inference-provider.
func (s *Service) CreateInferenceProvider(w http.ResponseWriter, r *http.Request) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	var req gatewayapi.CreateInferenceProviderRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	input, err := providerInputFromWrite(req)
	if err != nil {
		writeProviderInputError(w, r, err)
		return
	}
	name := "ip-" + strings.ReplaceAll(uuid.NewString()[:13], "-", "")
	provider := providerFromInput(ns, name, input)
	fields := inference.ValidateProvider(provider.Spec)
	if len(fields) > 0 {
		writeProviderIssues(w, r, fields)
		return
	}
	record, err := inference.CredentialsForCreate(
		provider.Spec,
		input.Credentials,
	)
	if err != nil {
		writeProviderInputError(w, r, err)
		return
	}
	path := ns + "/" + inference.CredentialPathDir + "/" + name
	if record != nil {
		if _, err := s.baoKV.Put(r.Context(), path, record); err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	}
	provider.OwnerReferences = []metav1.OwnerReference{
		*metav1.NewControllerRef(
			tenant,
			agentzv1alpha1.SchemeGroupVersion.WithKind("Tenant"),
		),
	}
	if err := s.k8sClient.Create(r.Context(), provider); err != nil {
		if record != nil {
			cleanupErr := s.baoKV.DeleteMetadata(r.Context(), path)
			if cleanupErr != nil && !errors.Is(cleanupErr, baoapi.ErrSecretNotFound) {
				writeError(w, r, newAPIError(
					http.StatusInternalServerError,
					"compensation_failed",
					"provider creation failed and credential cleanup also failed",
					errors.Join(err, cleanupErr),
				))
				return
			}
		}
		writeError(w, r, mapKubeHTTPError("create inference provider", err))
		return
	}
	item, err := providerToAPI(provider, 0)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

// GetInferenceProvider handles GET /api/inference-provider/{providerName}.
func (s *Service) GetInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath) {
	provider, usage, ok := s.providerAndUsage(w, r, providerName)
	if !ok {
		return
	}
	item, err := providerToAPI(provider, len(usage))
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// UpdateInferenceProvider handles PUT /api/inference-provider/{providerName}.
func (s *Service) UpdateInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	var req gatewayapi.UpdateInferenceProviderRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	input, err := providerInputFromWrite(req.Provider)
	if err != nil {
		writeProviderInputError(w, r, err)
		return
	}
	current := &agentzv1alpha1.InferenceProvider{}
	key := ctrlclient.ObjectKey{Namespace: ns, Name: providerName}
	if err := s.k8sClient.Get(r.Context(), key, current); err != nil {
		writeError(w, r, mapKubeHTTPError("get inference provider", err))
		return
	}
	if current.ResourceVersion != req.ResourceVersion {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"conflict",
			"provider changed since it was loaded",
			apierrors.NewConflict(
				agentzv1alpha1.Resource("inferenceproviders"),
				current.Name,
				fmt.Errorf("resource version does not match"),
			),
		))
		return
	}
	desired := providerFromInput(ns, current.Name, input)
	if desired.Spec.Kind != current.Spec.Kind {
		writeProviderIssues(w, r, []inference.Issue{{
			Field: "kind", Message: "provider kind is immutable",
		}})
		return
	}
	if desired.Spec.CatalogProvider != current.Spec.CatalogProvider {
		writeProviderIssues(w, r, []inference.Issue{{
			Field: "catalog_provider", Message: "catalog provider is immutable",
		}})
		return
	}
	if fields := inference.ValidateProvider(desired.Spec); len(fields) > 0 {
		writeProviderIssues(w, r, fields)
		return
	}
	modelIssues, err := inference.ValidateModelRemoval(
		r.Context(), s.usageReader, current, desired,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(modelIssues) > 0 {
		writeProviderIssues(w, r, modelIssues)
		return
	}
	record, rotate, err := inference.CredentialsForUpdate(
		desired.Spec,
		input.Credentials,
	)
	if err != nil {
		writeProviderInputError(w, r, err)
		return
	}
	oldCompatible := current.Spec.OpenAICompatible
	if oldCompatible == nil {
		oldCompatible = current.Spec.AnthropicCompatible
	}
	newCompatible := desired.Spec.OpenAICompatible
	if newCompatible == nil {
		newCompatible = desired.Spec.AnthropicCompatible
	}
	oldNoAuth := oldCompatible != nil && oldCompatible.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeNone
	newNoAuth := newCompatible != nil && newCompatible.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeNone
	azureAuthChanged := current.Spec.Azure != nil && desired.Spec.Azure != nil && current.Spec.Azure.AuthMode != desired.Spec.Azure.AuthMode
	bedrockAuthChanged := current.Spec.Bedrock != nil && desired.Spec.Bedrock != nil && current.Spec.Bedrock.AuthMode != desired.Spec.Bedrock.AuthMode
	if (azureAuthChanged || bedrockAuthChanged) && !rotate {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials", Message: "complete credentials are required when changing authentication mode",
		})
		return
	}
	if oldNoAuth && !newNoAuth && !rotate {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials.api_key", Message: "field is required when enabling authentication",
		})
		return
	}
	path := ns + "/" + inference.CredentialPathDir + "/" + current.Name
	credentialChanged := rotate || (!oldNoAuth && newNoAuth)
	if rotate {
		if _, err := s.baoKV.Put(r.Context(), path, record); err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	}
	if !rotate && !oldNoAuth && newNoAuth {
		err := s.baoKV.DeleteMetadata(r.Context(), path)
		if err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	}
	current.Spec = desired.Spec
	if current.Annotations == nil {
		current.Annotations = map[string]string{}
	}
	current.Annotations[providerUpdatedAtAnnotation] = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.k8sClient.Update(r.Context(), current); err != nil {
		if credentialChanged {
			status := http.StatusInternalServerError
			code := "credentials_changed_provider_update_failed"
			message := "credentials changed but provider configuration update failed; inspect current state before retrying"
			if apierrors.IsConflict(err) {
				status = http.StatusConflict
				code = "credentials_rotated_provider_conflict"
				message = "credentials changed but provider configuration conflicted; reload before retrying"
			}
			writeError(w, r, newAPIError(status, code, message, err))
			return
		}
		writeError(w, r, mapKubeHTTPError("update inference provider", err))
		return
	}
	_, usage, ok := s.providerAndUsage(w, r, current.Name)
	if !ok {
		return
	}
	item, err := providerToAPI(current, len(usage))
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// DeleteInferenceProvider handles DELETE /api/inference-provider/{providerName}.
func (s *Service) DeleteInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath) {
	provider, usage, ok := s.providerAndUsage(w, r, providerName)
	if !ok {
		return
	}
	if len(usage) > 0 {
		fields := make([]gatewayapi.FieldError, 0, len(usage))
		for _, sandbox := range usage {
			fields = append(fields, gatewayapi.FieldError{
				Field: "sandboxes", Message: sandbox,
			})
		}
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"provider_referenced",
			"provider is referenced by one or more sandboxes",
			errBadRequest,
			fields...,
		))
		return
	}
	if err := s.k8sClient.Delete(r.Context(), provider); err != nil {
		writeError(w, r, mapKubeHTTPError("delete inference provider", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetInferenceProviderUsage handles GET /api/inference-provider/{providerName}/usage.
func (s *Service) GetInferenceProviderUsage(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath) {
	_, usage, ok := s.providerAndUsage(w, r, providerName)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferenceProviderUsage{
		Provider: providerName, Sandboxes: usage,
	})
}

// ListInferenceProviderCatalog handles GET /api/inference-provider/catalog.
func (s *Service) ListInferenceProviderCatalog(w http.ResponseWriter, r *http.Request, params gatewayapi.ListInferenceProviderCatalogParams) {
	query := ""
	if params.Q != nil {
		query = *params.Q
	}
	commit, entries := s.catalog.Entries(query)
	providers := make([]gatewayapi.InferenceProviderCatalogEntry, 0, len(entries))
	for _, entry := range entries {
		provider := gatewayapi.InferenceProviderCatalogEntry{
			Name: entry.Name, ProviderId: entry.ProviderID,
			ProviderKind: gatewayapi.InferenceProviderKind(entry.Kind),
		}
		if entry.BaseURL != "" {
			provider.BaseUrl = &entry.BaseURL
		}
		if entry.BaseURLTemplate != "" {
			provider.BaseUrlTemplate = &entry.BaseURLTemplate
		}
		if entry.AuthHeader != "" {
			provider.AuthHeader = &entry.AuthHeader
		}
		if entry.AuthPrefix != "" {
			provider.AuthPrefix = &entry.AuthPrefix
		}
		if entry.Doc != "" {
			provider.DocumentationUrl = &entry.Doc
		}
		providers = append(providers, provider)
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferenceProviderCatalog{
		Commit: commit, Providers: providers,
	})
}

// ListInferenceModelSuggestions handles the provider model-catalog endpoint.
func (s *Service) ListInferenceModelSuggestions(w http.ResponseWriter, r *http.Request, catalogProvider string, params gatewayapi.ListInferenceModelSuggestionsParams) {
	models, provenance, err := s.catalog.Suggestions(
		r.Context(),
		catalogProvider,
		agentzv1alpha1.InferenceProviderKind(params.ProviderKind),
	)
	if err != nil {
		slog.WarnContext(
			r.Context(),
			"using embedded inference model catalog",
			slog.String("catalogProvider", catalogProvider),
			slog.String("providerKind", string(params.ProviderKind)),
			slog.Any("err", err),
		)
	}
	if models == nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"unsupported catalog provider and provider kind",
			errBadRequest,
		))
		return
	}
	values := modelsToAPI(models)
	suggestions := make([]gatewayapi.InferenceModelSuggestion, 0, len(values))
	for _, model := range values {
		catalogProvider := ""
		if model.CatalogProvider != nil {
			catalogProvider = *model.CatalogProvider
		}
		suggestions = append(suggestions, gatewayapi.InferenceModelSuggestion{
			Id:              model.Id,
			DisplayName:     model.DisplayName,
			Capabilities:    model.Capabilities,
			Modalities:      model.Modalities,
			Limits:          model.Limits,
			CatalogProvider: catalogProvider,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferenceModelSuggestions{
		Models:     suggestions,
		Provenance: gatewayapi.InferenceModelSuggestionsProvenance(provenance),
	})
}

func (s *Service) providerAndUsage(w http.ResponseWriter, r *http.Request, providerName string) (*agentzv1alpha1.InferenceProvider, []string, bool) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return nil, nil, false
	}
	provider := &agentzv1alpha1.InferenceProvider{}
	key := ctrlclient.ObjectKey{Namespace: ns, Name: strings.TrimSpace(providerName)}
	if err := s.k8sClient.Get(r.Context(), key, provider); err != nil {
		writeError(w, r, mapKubeHTTPError("get inference provider", err))
		return nil, nil, false
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	err = s.usageReader.List(
		r.Context(),
		sandboxes,
		ctrlclient.InNamespace(ns),
		ctrlclient.MatchingFields{inference.SandboxByProviderIndex: provider.Name},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list inference provider usage: %w", err))
		return nil, nil, false
	}
	usage := make([]string, 0)
	for _, sandbox := range sandboxes.Items {
		usage = append(usage, sandbox.Name)
	}
	slices.Sort(usage)
	return provider, usage, true
}

func providerInputFromWrite(req providerWriter) (providerInput, error) {
	input := providerInput{}
	providerKind, err := req.Discriminator()
	if err != nil {
		return input, &inference.InputError{Field: "kind", Message: "provider kind is required"}
	}
	switch providerKind {
	case "OpenAI":
		value, err := req.AsOpenAIInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "openai configuration does not match provider kind"}
		}
		input.DisplayName, input.CatalogProvider = value.DisplayName, value.CatalogProvider
		input.Kind, input.Models = gatewayapi.InferenceProviderKindOpenAI, value.Models
		input.OpenAI = &value.Openai
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
	case "Anthropic":
		value, err := req.AsAnthropicInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "anthropic configuration does not match provider kind"}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = value.CatalogProvider
		input.Kind = gatewayapi.InferenceProviderKindAnthropic
		input.Models = value.Models
		input.Anthropic = &value.Anthropic
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
	case "Gemini":
		value, err := req.AsGeminiInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "gemini configuration does not match provider kind"}
		}
		input.DisplayName, input.CatalogProvider = value.DisplayName, value.CatalogProvider
		input.Kind, input.Models = gatewayapi.InferenceProviderKindGemini, value.Models
		input.Gemini = &value.Gemini
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
	case "VertexAI":
		value, err := req.AsVertexAIInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "vertex ai configuration does not match provider kind"}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = value.CatalogProvider
		input.Kind = gatewayapi.InferenceProviderKindVertexAI
		input.Models = value.Models
		input.VertexAI = &value.VertexAi
		if value.Credentials.ServiceAccountJson != nil {
			input.Credentials.ServiceAccountJSON = *value.Credentials.ServiceAccountJson
		}
	case "Bedrock":
		value, err := req.AsBedrockInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "bedrock configuration does not match provider kind"}
		}
		input.DisplayName, input.CatalogProvider = value.DisplayName, value.CatalogProvider
		input.Kind, input.Models = gatewayapi.InferenceProviderKindBedrock, value.Models
		input.Bedrock = &value.Bedrock
		if value.Credentials.AccessKey != nil {
			input.Credentials.AccessKey = *value.Credentials.AccessKey
		}
		if value.Credentials.SecretKey != nil {
			input.Credentials.SecretKey = *value.Credentials.SecretKey
		}
		if value.Credentials.SessionToken != nil {
			input.Credentials.SessionToken = *value.Credentials.SessionToken
		}
		if value.Credentials.BearerToken != nil {
			input.Credentials.BearerToken = *value.Credentials.BearerToken
		}
	case "Azure":
		value, err := req.AsAzureInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "azure configuration does not match provider kind"}
		}
		input.DisplayName, input.CatalogProvider = value.DisplayName, value.CatalogProvider
		input.Kind, input.Models = gatewayapi.InferenceProviderKindAzure, value.Models
		input.Azure = &value.Azure
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
		if value.Credentials.ClientId != nil {
			input.Credentials.ClientID = *value.Credentials.ClientId
		}
		if value.Credentials.TenantId != nil {
			input.Credentials.TenantID = *value.Credentials.TenantId
		}
		if value.Credentials.ClientSecret != nil {
			input.Credentials.ClientSecret = *value.Credentials.ClientSecret
		}
	case "OpenAICompatible":
		value, err := req.AsOpenAICompatibleInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{Field: "kind", Message: "custom configuration does not match provider kind"}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = value.CatalogProvider
		input.Kind = gatewayapi.InferenceProviderKindOpenAICompatible
		input.Models = value.Models
		input.Compatible = &value.OpenaiCompatible
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
	case "AnthropicCompatible":
		value, err := req.AsAnthropicCompatibleInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{
				Field:   "kind",
				Message: "anthropic-compatible configuration does not match provider kind",
			}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = value.CatalogProvider
		input.Kind = gatewayapi.InferenceProviderKindAnthropicCompatible
		input.Models = value.Models
		input.Compatible = &value.AnthropicCompatible
		if value.Credentials.ApiKey != nil {
			input.Credentials.APIKey = *value.Credentials.ApiKey
		}
	default:
		return input, &inference.InputError{Field: "kind", Message: "unsupported provider kind"}
	}
	return input, nil
}

func providerFromInput(namespace, name string, input providerInput) *agentzv1alpha1.InferenceProvider {
	provider := &agentzv1alpha1.InferenceProvider{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentzv1alpha1.SchemeGroupVersion.String(), Kind: "InferenceProvider",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: namespace,
			Annotations: map[string]string{
				providerUpdatedAtAnnotation: time.Now().UTC().Format(time.RFC3339Nano),
			},
		},
		Spec: agentzv1alpha1.InferenceProviderSpec{
			DisplayName:     input.DisplayName,
			CatalogProvider: input.CatalogProvider,
			Kind:            agentzv1alpha1.InferenceProviderKind(input.Kind),
			Models:          modelsFromAPI(input.Models),
		},
	}
	if input.OpenAI != nil {
		provider.Spec.OpenAI = &agentzv1alpha1.OpenAIProviderConfig{}
		if input.OpenAI.BaseUrl != nil {
			provider.Spec.OpenAI.BaseURL = *input.OpenAI.BaseUrl
		}
	}
	if input.Anthropic != nil {
		provider.Spec.Anthropic = &agentzv1alpha1.AnthropicProviderConfig{}
		if input.Anthropic.BaseUrl != nil {
			provider.Spec.Anthropic.BaseURL = *input.Anthropic.BaseUrl
		}
	}
	if input.Gemini != nil {
		provider.Spec.Gemini = &agentzv1alpha1.GeminiProviderConfig{}
		if input.Gemini.BaseUrl != nil {
			provider.Spec.Gemini.BaseURL = *input.Gemini.BaseUrl
		}
	}
	if input.VertexAI != nil {
		provider.Spec.VertexAI = &agentzv1alpha1.VertexAIProviderConfig{
			Project: input.VertexAI.Project, Region: input.VertexAI.Region,
		}
	}
	if input.Bedrock != nil {
		provider.Spec.Bedrock = &agentzv1alpha1.BedrockProviderConfig{
			Region:   input.Bedrock.Region,
			AuthMode: agentzv1alpha1.BedrockAuthMode(input.Bedrock.AuthMode),
		}
	}
	if input.Azure != nil {
		provider.Spec.Azure = &agentzv1alpha1.AzureProviderConfig{
			ResourceType: agentzv1alpha1.AzureResourceType(input.Azure.ResourceType),
			ResourceName: input.Azure.ResourceName,
			APIVersion:   input.Azure.ApiVersion,
			AuthMode:     agentzv1alpha1.AzureAuthMode(input.Azure.AuthMode),
		}
		if input.Azure.Project != nil {
			provider.Spec.Azure.Project = *input.Azure.Project
		}
	}
	if input.Compatible != nil {
		value := input.Compatible
		cfg := &agentzv1alpha1.CompatibleProviderConfig{
			BaseURL:  value.BaseUrl,
			AuthMode: agentzv1alpha1.CompatibleProviderAuthMode(value.AuthMode),
		}
		if value.Path != nil {
			cfg.Path = *value.Path
		}
		if value.PathPrefix != nil {
			cfg.PathPrefix = *value.PathPrefix
		}
		if value.AuthHeader != nil {
			cfg.AuthHeader = *value.AuthHeader
		}
		if value.AuthPrefix != nil {
			cfg.AuthPrefix = *value.AuthPrefix
		}
		if value.AllowPrivateEndpoint != nil {
			cfg.AllowPrivateEndpoint = *value.AllowPrivateEndpoint
		}
		if value.SkipTlsVerify != nil {
			cfg.SkipTLSVerify = *value.SkipTlsVerify
		}
		if value.Headers != nil {
			cfg.Headers = make(
				[]agentzv1alpha1.InferenceProviderHeader, 0, len(*value.Headers),
			)
			for _, header := range *value.Headers {
				cfg.Headers = append(
					cfg.Headers,
					agentzv1alpha1.InferenceProviderHeader{Name: header.Name, Value: header.Value},
				)
			}
		}
		target := &provider.Spec.AnthropicCompatible
		if input.Kind == gatewayapi.InferenceProviderKindOpenAICompatible {
			target = &provider.Spec.OpenAICompatible
		}
		*target = cfg
	}
	return provider
}

func providerToAPI(provider *agentzv1alpha1.InferenceProvider, usage int) (gatewayapi.InferenceProvider, error) {
	state := gatewayapi.InferenceProviderState(provider.Status.State)
	if state == "" {
		state = gatewayapi.InferenceProviderStateAccepted
	}
	conditions := make([]gatewayapi.InferenceProviderCondition, 0, len(provider.Status.Conditions))
	for _, condition := range provider.Status.Conditions {
		conditions = append(conditions, gatewayapi.InferenceProviderCondition{
			Type: condition.Type, Status: gatewayapi.InferenceProviderConditionStatus(condition.Status),
			Reason: condition.Reason, Message: condition.Message,
		})
	}
	updatedAt := provider.CreationTimestamp.Time
	if raw := provider.Annotations[providerUpdatedAtAnnotation]; raw != "" {
		if value, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			updatedAt = value
		}
	}
	out := gatewayapi.InferenceProvider{
		Id: provider.Name, ResourceVersion: provider.ResourceVersion,
		DisplayName:     provider.Spec.DisplayName,
		CatalogProvider: provider.Spec.CatalogProvider,
		Models:          modelsToAPI(provider.Spec.Models),
		State:           state, Conditions: conditions,
		ModelCount: len(provider.Spec.Models), UsageCount: usage,
		CreatedAt: provider.CreationTimestamp.Time, UpdatedAt: updatedAt,
	}
	switch provider.Spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		config := gatewayapi.OpenAIProviderConfig{}
		if provider.Spec.OpenAI.BaseURL != "" {
			config.BaseUrl = &provider.Spec.OpenAI.BaseURL
		}
		err := out.FromOpenAIInferenceProviderRead(gatewayapi.OpenAIInferenceProviderRead{
			Kind: gatewayapi.OpenAIInferenceProviderReadKindOpenAI, Openai: config,
		})
		if err != nil {
			return out, fmt.Errorf("render OpenAI provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		config := gatewayapi.AnthropicProviderConfig{}
		if provider.Spec.Anthropic.BaseURL != "" {
			config.BaseUrl = &provider.Spec.Anthropic.BaseURL
		}
		err := out.FromAnthropicInferenceProviderRead(gatewayapi.AnthropicInferenceProviderRead{
			Kind: gatewayapi.AnthropicInferenceProviderReadKindAnthropic, Anthropic: config,
		})
		if err != nil {
			return out, fmt.Errorf("render Anthropic provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindGemini:
		config := gatewayapi.GeminiProviderConfig{}
		if provider.Spec.Gemini.BaseURL != "" {
			config.BaseUrl = &provider.Spec.Gemini.BaseURL
		}
		err := out.FromGeminiInferenceProviderRead(gatewayapi.GeminiInferenceProviderRead{
			Kind:   gatewayapi.GeminiInferenceProviderReadKindGemini,
			Gemini: config,
		})
		if err != nil {
			return out, fmt.Errorf("render Gemini provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		err := out.FromVertexAIInferenceProviderRead(gatewayapi.VertexAIInferenceProviderRead{
			Kind: gatewayapi.VertexAIInferenceProviderReadKindVertexAI,
			VertexAi: gatewayapi.VertexAIProviderConfig{
				Project: provider.Spec.VertexAI.Project, Region: provider.Spec.VertexAI.Region,
			},
		})
		if err != nil {
			return out, fmt.Errorf("render Vertex AI provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		err := out.FromBedrockInferenceProviderRead(gatewayapi.BedrockInferenceProviderRead{
			Kind: gatewayapi.BedrockInferenceProviderReadKindBedrock,
			Bedrock: gatewayapi.BedrockProviderConfig{
				Region:   provider.Spec.Bedrock.Region,
				AuthMode: gatewayapi.BedrockProviderConfigAuthMode(provider.Spec.Bedrock.AuthMode),
			},
		})
		if err != nil {
			return out, fmt.Errorf("render Bedrock provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindAzure:
		config := gatewayapi.AzureProviderConfig{
			ResourceType: gatewayapi.AzureProviderConfigResourceType(provider.Spec.Azure.ResourceType),
			ResourceName: provider.Spec.Azure.ResourceName,
			ApiVersion:   provider.Spec.Azure.APIVersion,
			AuthMode:     gatewayapi.AzureProviderConfigAuthMode(provider.Spec.Azure.AuthMode),
		}
		if provider.Spec.Azure.Project != "" {
			config.Project = &provider.Spec.Azure.Project
		}
		err := out.FromAzureInferenceProviderRead(gatewayapi.AzureInferenceProviderRead{
			Kind: gatewayapi.AzureInferenceProviderReadKindAzure, Azure: config,
		})
		if err != nil {
			return out, fmt.Errorf("render Azure provider response: %w", err)
		}
	case agentzv1alpha1.InferenceProviderKindOpenAICompatible,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		value := provider.Spec.OpenAICompatible
		if provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible {
			value = provider.Spec.AnthropicCompatible
		}
		config := gatewayapi.CompatibleProviderConfig{
			BaseUrl:  value.BaseURL,
			AuthMode: gatewayapi.CompatibleProviderConfigAuthMode(value.AuthMode),
		}
		if value.Path != "" {
			config.Path = &value.Path
		}
		if value.PathPrefix != "" {
			config.PathPrefix = &value.PathPrefix
		}
		if value.AuthHeader != "" {
			config.AuthHeader = &value.AuthHeader
		}
		if value.AuthPrefix != "" {
			config.AuthPrefix = &value.AuthPrefix
		}
		config.AllowPrivateEndpoint = &value.AllowPrivateEndpoint
		config.SkipTlsVerify = &value.SkipTLSVerify
		headers := make([]gatewayapi.InferenceProviderHeader, 0, len(value.Headers))
		for _, header := range value.Headers {
			headers = append(headers, gatewayapi.InferenceProviderHeader{
				Name: header.Name, Value: header.Value,
			})
		}
		config.Headers = &headers
		var err error
		switch provider.Spec.Kind {
		case agentzv1alpha1.InferenceProviderKindOpenAICompatible:
			err = out.FromOpenAICompatibleInferenceProviderRead(
				gatewayapi.OpenAICompatibleInferenceProviderRead{
					Kind:             gatewayapi.OpenAICompatibleInferenceProviderReadKindOpenAICompatible,
					OpenaiCompatible: config,
				},
			)
		case agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
			err = out.FromAnthropicCompatibleInferenceProviderRead(
				gatewayapi.AnthropicCompatibleInferenceProviderRead{
					Kind:                gatewayapi.AnthropicCompatibleInferenceProviderReadKindAnthropicCompatible,
					AnthropicCompatible: config,
				},
			)
		}
		if err != nil {
			return out, fmt.Errorf("render custom provider response: %w", err)
		}
	default:
		return out, fmt.Errorf("render unsupported provider kind %q", provider.Spec.Kind)
	}
	return out, nil
}

func modelsFromAPI(models []gatewayapi.InferenceModel) []agentzv1alpha1.InferenceModel {
	values := make([]agentzv1alpha1.InferenceModel, 0, len(models))
	for _, model := range models {
		value := agentzv1alpha1.InferenceModel{
			ID: model.Id, DisplayName: model.DisplayName,
			Capabilities: agentzv1alpha1.InferenceModelCapabilities{
				Attachment:  model.Capabilities.Attachment,
				Reasoning:   model.Capabilities.Reasoning,
				Temperature: model.Capabilities.Temperature,
				ToolCall:    model.Capabilities.ToolCall,
			},
			Modalities: agentzv1alpha1.InferenceModelModalities{
				Input:  make([]agentzv1alpha1.InferenceModelModality, len(model.Modalities.Input)),
				Output: make([]agentzv1alpha1.InferenceModelModality, len(model.Modalities.Output)),
			},
			Limits: agentzv1alpha1.InferenceModelLimits{
				Context: model.Limits.Context, Input: model.Limits.Input, Output: model.Limits.Output,
			},
		}
		for i, modality := range model.Modalities.Input {
			value.Modalities.Input[i] = agentzv1alpha1.InferenceModelModality(modality)
		}
		for i, modality := range model.Modalities.Output {
			value.Modalities.Output[i] = agentzv1alpha1.InferenceModelModality(modality)
		}
		if model.CatalogProvider != nil {
			value.Catalog = &agentzv1alpha1.InferenceModelCatalog{Provider: *model.CatalogProvider}
		}
		values = append(values, value)
	}
	return values
}

func modelsToAPI(models []agentzv1alpha1.InferenceModel) []gatewayapi.InferenceModel {
	values := make([]gatewayapi.InferenceModel, 0, len(models))
	for _, model := range models {
		value := gatewayapi.InferenceModel{
			Id: model.ID, DisplayName: model.DisplayName,
			Capabilities: gatewayapi.InferenceModelCapabilities{
				Attachment:  model.Capabilities.Attachment,
				Reasoning:   model.Capabilities.Reasoning,
				Temperature: model.Capabilities.Temperature,
				ToolCall:    model.Capabilities.ToolCall,
			},
			Modalities: gatewayapi.InferenceModelModalities{
				Input:  make([]gatewayapi.InferenceModelModality, len(model.Modalities.Input)),
				Output: make([]gatewayapi.InferenceModelModality, len(model.Modalities.Output)),
			},
			Limits: gatewayapi.InferenceModelLimits{
				Context: model.Limits.Context, Input: model.Limits.Input, Output: model.Limits.Output,
			},
		}
		for i, modality := range model.Modalities.Input {
			value.Modalities.Input[i] = gatewayapi.InferenceModelModality(modality)
		}
		for i, modality := range model.Modalities.Output {
			value.Modalities.Output[i] = gatewayapi.InferenceModelModality(modality)
		}
		if model.Catalog != nil {
			value.CatalogProvider = &model.Catalog.Provider
		}
		values = append(values, value)
	}
	return values
}

func writeProviderIssues(w http.ResponseWriter, r *http.Request, issues []inference.Issue) {
	fields := make([]gatewayapi.FieldError, 0, len(issues))
	for _, issue := range issues {
		fields = append(fields, gatewayapi.FieldError{Field: issue.Field, Message: issue.Message})
	}
	writeError(w, r, newAPIError(
		http.StatusBadRequest,
		"invalid_request",
		"request validation failed",
		errBadRequest,
		fields...,
	))
}

func writeProviderInputError(w http.ResponseWriter, r *http.Request, err error) {
	var inputErr *inference.InputError
	if !errors.As(err, &inputErr) {
		writeInternalError(w, r, err)
		return
	}
	writeProviderIssues(w, r, []inference.Issue{{
		Field: inputErr.Field, Message: inputErr.Message,
	}})
}
