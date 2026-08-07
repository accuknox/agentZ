package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
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
	"golang.org/x/oauth2"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/oauth"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const providerUpdatedAtAnnotation = "agentz.accuknox.com/inference-provider-updated-at"

const (
	oauthTicketPathDir  = "inference-provider-oauth-tickets"
	oauthTicketLifetime = 15 * time.Minute
)

type inferenceOAuthTicketRecord struct {
	SecretHash   string                          `json:"secretHash"`
	TenantID     string                          `json:"tenantId"`
	UserID       string                          `json:"userId"`
	ExpiresAt    time.Time                       `json:"expiresAt"`
	Models       []agentzv1alpha1.InferenceModel `json:"models"`
	Subscription inference.SubscriptionRecord    `json:"subscription"`
}

type inferenceOAuthTicketClaim struct {
	ConsumedAt time.Time `json:"consumedAt"`
}

type openAIJWTClaims struct {
	AccountID     string               `json:"chatgpt_account_id"`
	Organizations []openAIOrganization `json:"organizations"`
	Auth          openAIAuthClaims     `json:"https://api.openai.com/auth"`
}

type openAIOrganization struct {
	ID string `json:"id"`
}

type openAIAuthClaims struct {
	AccountID string `json:"chatgpt_account_id"`
}

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
	AsOpenAICodexInferenceProviderWrite() (gatewayapi.OpenAICodexInferenceProviderWrite, error)
	AsAnthropicInferenceProviderWrite() (gatewayapi.AnthropicInferenceProviderWrite, error)
	AsGeminiInferenceProviderWrite() (gatewayapi.GeminiInferenceProviderWrite, error)
	AsGitHubCopilotInferenceProviderWrite() (gatewayapi.GitHubCopilotInferenceProviderWrite, error)
	AsVertexAIInferenceProviderWrite() (gatewayapi.VertexAIInferenceProviderWrite, error)
	AsBedrockInferenceProviderWrite() (gatewayapi.BedrockInferenceProviderWrite, error)
	AsAzureInferenceProviderWrite() (gatewayapi.AzureInferenceProviderWrite, error)
	AsOpenAICompatibleInferenceProviderWrite() (gatewayapi.OpenAICompatibleInferenceProviderWrite, error)
	AsAnthropicCompatibleInferenceProviderWrite() (gatewayapi.AnthropicCompatibleInferenceProviderWrite, error)
}

type providerUsage struct {
	pools     []string
	sandboxes []string
}

func (s *Service) resolveInferenceProviderAccess(ctx context.Context, workspaceID, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	req := resourceAccessRequest{
		resource: "Inference Provider", workspaceID: workspaceID, operation: operation,
	}
	if name != "" && (operation == authorization.OperationUpdateInferenceProvider || operation == authorization.OperationDeleteInferenceProvider) {
		req.creatorFallback = authorization.OperationCreateInferenceProvider
		req.isCreator = func(ctx context.Context, namespace, userID string) (bool, error) {
			item := &agentzv1alpha1.InferenceProvider{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name, Namespace: namespace}, item)
			return item.Spec.CreatorUserID == userID, err
		}
	}
	return s.resolveResourceAccess(ctx, req)
}

func (s *Service) createInferenceProviderAudit(ctx context.Context, r *http.Request, access resourceAccess, name string, result gatewaydb.AuditResult) error {
	action := "unmapped"
	switch access.operation {
	case authorization.OperationCreateInferenceProvider:
		action = "create"
	case authorization.OperationCreateInferenceProviderOAuthTicket:
		action = "create_oauth_ticket"
	case authorization.OperationUpdateInferenceProvider:
		action = "modify"
	case authorization.OperationDeleteInferenceProvider:
		action = "delete"
	}
	return s.createResourceAudit(
		ctx, r, access, gatewaydb.AuditTargetInferenceProvider, name,
		"inference_provider", action, result,
	)
}

// ListInferenceProviders handles GET /api/inference/provider.
func (s *Service) ListInferenceProviders(w http.ResponseWriter, r *http.Request, params gatewayapi.ListInferenceProvidersParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationListInferenceProviders,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
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
	items, err := s.listInferenceProviderItems(r.Context(), ns, nil, access)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if workspaceID != "" {
		inherited, err := s.listInheritedInferenceProviders(r.Context(), access)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		items = append(items, inherited...)
	}
	slices.SortFunc(items, func(a, b gatewayapi.InferenceProvider) int {
		if a.Id != b.Id {
			return strings.Compare(a.Id, b.Id)
		}
		return strings.Compare(string(a.Scope), string(b.Scope))
	})
	start := min(offset, len(items))
	end := min(start+limit, len(items))
	var next string
	if end < len(items) {
		next = encodeOffsetToken(end)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListInferenceProvidersResponse{
		Providers: items[start:end], NextPageToken: next,
	})
}

func (s *Service) listInheritedInferenceProviders(ctx context.Context, access resourceAccess) ([]gatewayapi.InferenceProvider, error) {
	selected, err := s.selectedOrganizationResourceNames(
		ctx,
		access.workspaceID,
		access.claims.TenantID,
		agentzv1alpha1.OrganizationResourceKindInferenceProvider,
	)
	if err != nil {
		return nil, err
	}
	if len(selected) == 0 {
		return []gatewayapi.InferenceProvider{}, nil
	}
	organizationAccess := access
	organizationAccess.workspaceID = ""
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		access.claims.TenantID,
	)
	items, err := s.listInferenceProviderItems(ctx, organizationNamespace, selected, organizationAccess)
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i].CanModify = false
		items[i].CanDelete = false
	}
	return items, nil
}

// WatchInferenceProviders handles POST /api/inference/provider/watch.
func (s *Service) WatchInferenceProviders(w http.ResponseWriter, r *http.Request, params gatewayapi.WatchInferenceProvidersParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationWatchInferenceProviders,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	ns := access.namespace
	var req gatewayapi.WatchInferenceProvidersRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}
	var filter map[string]struct{}
	if req.Providers != nil {
		filter = make(map[string]struct{}, len(*req.Providers))
		for _, ref := range *req.Providers {
			filter[ref.Name] = struct{}{}
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
		items, err := s.listInferenceProviderItems(r.Context(), ns, filter, access)
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
	pools, err := s.agentz.AgentzV1alpha1().InferencePools(ns).Watch(
		r.Context(),
		metav1.ListOptions{},
	)
	if err != nil {
		recordRequestError(w, "internal_error", fmt.Errorf("watch dependent inference pools: %w", err))
		return
	}
	defer pools.Stop()
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
		case _, ok := <-pools.ResultChan():
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

func (s *Service) listInferenceProviderItems(ctx context.Context, namespace string, filter map[string]struct{}, access resourceAccess) ([]gatewayapi.InferenceProvider, error) {
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
	pools := &agentzv1alpha1.InferencePoolList{}
	if err := s.usageReader.List(ctx, pools, ctrlclient.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list inference pools: %w", err)
	}
	poolProviders := make(map[string][]string, len(pools.Items))
	for i := range pools.Items {
		seen := make(map[string]struct{}, len(pools.Items[i].Spec.Members))
		for _, member := range pools.Items[i].Spec.Members {
			if _, exists := seen[member.Provider]; exists {
				continue
			}
			seen[member.Provider] = struct{}{}
			poolProviders[pools.Items[i].Name] = append(
				poolProviders[pools.Items[i].Name], member.Provider,
			)
		}
	}
	usage := make(map[string]map[string]struct{})
	addUsage := func(provider, sandbox string) {
		if usage[provider] == nil {
			usage[provider] = make(map[string]struct{})
		}
		usage[provider][sandbox] = struct{}{}
	}
	for i := range sandboxes.Items {
		seenProviders := make(map[string]struct{}, len(sandboxes.Items[i].Spec.Inference.Models))
		seenPools := make(map[string]struct{}, len(sandboxes.Items[i].Spec.Inference.Models))
		for _, model := range sandboxes.Items[i].Spec.Inference.Models {
			if model.Provider == agentzv1alpha1.InferencePoolProvider {
				if _, exists := seenPools[model.Model]; exists {
					continue
				}
				seenPools[model.Model] = struct{}{}
				for _, provider := range poolProviders[model.Model] {
					addUsage(provider, sandboxes.Items[i].Name)
				}
				continue
			}
			if _, exists := seenProviders[model.Provider]; exists {
				continue
			}
			seenProviders[model.Provider] = struct{}{}
			addUsage(model.Provider, sandboxes.Items[i].Name)
		}
	}
	items := make([]gatewayapi.InferenceProvider, 0, len(providers.Items))
	for i := range providers.Items {
		if filter != nil {
			if _, ok := filter[providers.Items[i].Name]; !ok {
				continue
			}
		}
		item, err := providerToAPI(&providers.Items[i], len(usage[providers.Items[i].Name]), access)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

// CreateInferenceProviderOAuthTicket handles POST
// /api/inference/provider/oauth-ticket.
func (s *Service) CreateInferenceProviderOAuthTicket(w http.ResponseWriter, r *http.Request, params gatewayapi.CreateInferenceProviderOAuthTicketParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationCreateInferenceProviderOAuthTicket,
	)
	if apiErr != nil {
		if access.claims.TenantID != "" {
			err := s.createInferenceProviderAudit(
				r.Context(), r, access, "oauth-ticket", access.failureResult(),
			)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	persistenceAudited := false
	defer func() {
		if persistenceAudited {
			return
		}
		err := s.createInferenceProviderAudit(
			context.WithoutCancel(r.Context()), r, access, "oauth-ticket",
			gatewaydb.AuditResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "audit failed Inference Provider OAuth ticket", slog.Any("err", err))
		}
	}()
	ns := access.namespace
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.claims == nil {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"oauth tickets require user authentication",
			errors.New("missing bearer claims"),
		))
		return
	}
	var req gatewayapi.CreateInferenceProviderOAuthTicketRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	kind := agentzv1alpha1.InferenceProviderKind(req.Kind)
	isCodex := kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
	isCopilot := kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	if !isCodex && !isCopilot {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "kind", Message: "provider kind is not subscription-backed",
		})
		return
	}
	if req.Credentials.AccessToken == nil {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials.access_token", Message: "field is required",
		})
		return
	}
	if strings.TrimSpace(*req.Credentials.AccessToken) == "" {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials.access_token", Message: "field is required",
		})
		return
	}
	accessToken := strings.TrimSpace(*req.Credentials.AccessToken)
	var refreshToken string
	if req.Credentials.RefreshToken != nil {
		refreshToken = strings.TrimSpace(*req.Credentials.RefreshToken)
	}
	if isCodex && refreshToken == "" {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials.refresh_token", Message: "field is required",
		})
		return
	}
	token := &oauth2.Token{
		AccessToken: accessToken, RefreshToken: refreshToken, TokenType: "Bearer",
	}
	if req.Credentials.ExpiresAt != nil {
		token.Expiry = req.Credentials.ExpiresAt.UTC()
	}
	if isCodex && !token.Expiry.After(time.Now().UTC()) {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "credentials.expires_at", Message: "must be in the future",
		})
		return
	}
	record := inference.SubscriptionRecord{
		Kind: kind, Token: token, UpdatedAt: time.Now().UTC(),
	}
	if kind == agentzv1alpha1.InferenceProviderKindOpenAICodex {
		record.ClientID = inference.OpenAICodexClientID
		var idToken string
		if req.Credentials.IdToken != nil {
			idToken = *req.Credentials.IdToken
		}
		record.AccountID = openAIAccountID(idToken, accessToken)
		if record.AccountID == "" {
			writeProviderInputError(w, r, &inference.InputError{
				Field: "credentials.id_token", Message: "account id claim is required",
			})
			return
		}
	}
	models, provenance, discoveryErr := s.catalog.SubscriptionModels(
		r.Context(), record,
	)
	if len(models) == 0 {
		writeError(w, r, newAPIError(
			http.StatusBadGateway,
			"model_discovery_failed",
			"subscription model discovery failed",
			discoveryErr,
		))
		return
	}
	if discoveryErr != nil {
		slog.WarnContext(
			r.Context(),
			"using embedded inference model metadata with authenticated entitlement",
			slog.String("providerKind", string(kind)),
			slog.Any("err", discoveryErr),
		)
	}
	idBytes := make([]byte, 18)
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		writeInternalError(w, r, fmt.Errorf("create oauth ticket id: %w", err))
		return
	}
	if _, err := rand.Read(secretBytes); err != nil {
		writeInternalError(w, r, fmt.Errorf("create oauth ticket secret: %w", err))
		return
	}
	id := base64.RawURLEncoding.EncodeToString(idBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	digest := sha256.Sum256(secretBytes)
	expiresAt := time.Now().UTC().Add(oauthTicketLifetime)
	ticket := inferenceOAuthTicketRecord{
		SecretHash: base64.RawURLEncoding.EncodeToString(digest[:]),
		TenantID:   auth.claims.TenantID, UserID: auth.claims.UserID,
		ExpiresAt: expiresAt, Models: models, Subscription: record,
	}
	data, err := inferenceOAuthTicketData(ticket)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	path := ns + "/" + oauthTicketPathDir + "/" + id
	persistenceAudited = true
	err = s.baoKV.PutMetadata(r.Context(), path, baoapi.KVMetadataPutInput{
		CASRequired:        true,
		DeleteVersionAfter: oauthTicketLifetime,
		MaxVersions:        1,
	})
	if err != nil {
		auditErr := s.createInferenceProviderAudit(
			r.Context(), r, access, id, gatewaydb.AuditResultFailed,
		)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapOpenBaoError(err))
		return
	}
	_, err = s.baoKV.Put(r.Context(), path, data, baoapi.WithCheckAndSet(0))
	if err != nil {
		cleanupErr := s.baoKV.DeleteMetadata(r.Context(), path)
		if cleanupErr != nil && !errors.Is(cleanupErr, baoapi.ErrSecretNotFound) {
			err = errors.Join(err, fmt.Errorf("clean up oauth ticket metadata: %w", cleanupErr))
		}
		auditErr := s.createInferenceProviderAudit(
			r.Context(), r, access, id, gatewaydb.AuditResultFailed,
		)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapOpenBaoError(err))
		return
	}
	if err := s.createInferenceProviderAudit(
		r.Context(), r, access, id, gatewaydb.AuditResultSucceeded,
	); err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, gatewayapi.CreateInferenceProviderOAuthTicketResponse{
		Ticket:     id + "." + secret,
		ExpiresAt:  expiresAt,
		Models:     modelSuggestionsToAPI(models),
		Provenance: gatewayapi.InferenceModelSuggestionsProvenance(provenance),
	})
}

// CreateInferenceProvider handles POST /api/inference/provider.
func (s *Service) CreateInferenceProvider(w http.ResponseWriter, r *http.Request, params gatewayapi.CreateInferenceProviderParams) {
	var req gatewayapi.CreateInferenceProviderRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	name := "ip-" + strings.ReplaceAll(uuid.NewString()[:13], "-", "")
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationCreateInferenceProvider,
	)
	if apiErr != nil {
		if access.claims.TenantID != "" {
			err := s.createInferenceProviderAudit(
				r.Context(), r, access, name, access.failureResult(),
			)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	persistenceAudited := false
	defer func() {
		if persistenceAudited {
			return
		}
		if err := s.createInferenceProviderAudit(context.WithoutCancel(r.Context()), r, access, name, gatewaydb.AuditResultFailed); err != nil {
			slog.ErrorContext(r.Context(), "audit failed Inference Provider create", slog.Any("err", err))
		}
	}()
	ns := access.namespace
	input, err := providerInputFromWrite(req.Provider)
	if err != nil {
		writeProviderInputError(w, r, err)
		return
	}
	provider := providerFromInput(ns, name, input)
	provider.Spec.CreatorUserID = access.claims.UserID
	fields := inference.ValidateProvider(provider.Spec)
	if len(fields) > 0 {
		writeInferenceIssues(w, r, fields)
		return
	}
	isSubscription := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex ||
		provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	var record map[string]any
	var ticketPath string
	if isSubscription {
		if req.OauthTicket == nil {
			writeProviderInputError(w, r, &inference.InputError{
				Field: "oauth_ticket", Message: "field is required",
			})
			return
		}
		subscription, consumedPath, err := s.consumeInferenceOAuthTicket(
			r.Context(), ns, *req.OauthTicket, provider,
		)
		if err != nil {
			writeProviderInputError(w, r, err)
			return
		}
		record, err = inference.SubscriptionRecordData(subscription)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		ticketPath = consumedPath
	}
	if !isSubscription {
		if req.OauthTicket != nil {
			writeProviderInputError(w, r, &inference.InputError{
				Field: "oauth_ticket", Message: "field is only valid for subscription providers",
			})
			return
		}
		record, err = inference.CredentialsForCreate(provider.Spec, input.Credentials)
		if err != nil {
			writeProviderInputError(w, r, err)
			return
		}
	}
	path := inference.CredentialPath(ns, name, provider.Spec.Kind)
	if record != nil {
		_, err := s.baoKV.Put(
			r.Context(), path, record, baoapi.WithCheckAndSet(0),
		)
		if err != nil {
			writeError(w, r, mapOpenBaoError(err))
			return
		}
	}
	if ticketPath != "" {
		if err := s.baoKV.DeleteMetadata(r.Context(), ticketPath); err != nil {
			cleanupErr := s.baoKV.DeleteMetadata(r.Context(), path)
			writeError(w, r, newAPIError(
				http.StatusInternalServerError,
				"oauth_ticket_cleanup_failed",
				"oauth ticket cleanup failed",
				errors.Join(err, cleanupErr),
			))
			return
		}
	}
	provider.OwnerReferences = []metav1.OwnerReference{access.owner}
	persistenceAudited = true
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
		auditErr := s.createInferenceProviderAudit(
			r.Context(), r, access, name, gatewaydb.AuditResultFailed,
		)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("create inference provider", err))
		return
	}
	if err := s.createInferenceProviderAudit(
		r.Context(), r, access, name, gatewaydb.AuditResultSucceeded,
	); err != nil {
		writeInternalError(w, r, err)
		return
	}
	item, err := providerToAPI(provider, 0, access)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

// GetInferenceProvider handles GET /api/inference/provider/{providerName}.
func (s *Service) GetInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath, params gatewayapi.GetInferenceProviderParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, providerName, authorization.OperationGetInferenceProvider,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	provider, usage, ok := s.providerAndUsage(w, r, access.namespace, providerName)
	if !ok {
		return
	}
	item, err := providerToAPI(provider, len(usage.sandboxes), access)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// RefreshInferenceProviderModels handles GET
// /api/inference/provider/{providerName}/models.
func (s *Service) RefreshInferenceProviderModels(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath, params gatewayapi.RefreshInferenceProviderModelsParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, providerName,
		authorization.OperationRefreshInferenceProviderModels,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	provider, _, ok := s.providerAndUsage(w, r, access.namespace, providerName)
	if !ok {
		return
	}
	isCodex := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
	isCopilot := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	if !isCodex && !isCopilot {
		writeProviderInputError(w, r, &inference.InputError{
			Field: "providerName", Message: "provider is not subscription-backed",
		})
		return
	}
	path := inference.CredentialPath(
		provider.Namespace,
		provider.Name,
		provider.Spec.Kind,
	)
	secretRecord, err := s.baoKV.Get(r.Context(), path)
	if err != nil {
		writeError(w, r, mapOpenBaoError(err))
		return
	}
	record, err := inference.DecodeSubscriptionRecord(secretRecord.Data)
	if err != nil || record.Kind != provider.Spec.Kind {
		writeError(w, r, newAPIError(
			http.StatusServiceUnavailable,
			"credentials_unavailable",
			"subscription credentials are unavailable",
			err,
		))
		return
	}
	record, changed, err := inference.RefreshSubscription(
		r.Context(), s.outboundHTTP, record,
	)
	if err != nil {
		writeError(w, r, newAPIError(
			http.StatusBadGateway,
			"oauth_refresh_failed",
			"subscription credentials could not be refreshed",
			err,
		))
		return
	}
	if changed {
		data, err := inference.SubscriptionRecordData(record)
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
		if secretRecord.VersionMetadata == nil {
			writeInternalError(w, r, errors.New("subscription credential version is missing"))
			return
		}
		_, err = s.baoKV.Put(
			r.Context(),
			path,
			data,
			baoapi.WithCheckAndSet(secretRecord.VersionMetadata.Version),
		)
		if err != nil {
			latest, readErr := s.baoKV.Get(r.Context(), path)
			if readErr != nil {
				writeError(w, r, mapOpenBaoError(errors.Join(err, readErr)))
				return
			}
			record, readErr = inference.DecodeSubscriptionRecord(latest.Data)
			if readErr != nil {
				writeError(w, r, mapOpenBaoError(errors.Join(err, readErr)))
				return
			}
			kindChanged := record.Kind != provider.Spec.Kind
			if kindChanged || !oauth.TokenUsable(record.Token, time.Now().UTC()) {
				writeError(w, r, mapOpenBaoError(errors.Join(err, readErr)))
				return
			}
		}
	}
	models, provenance, discoveryErr := s.catalog.SubscriptionModels(
		r.Context(), record,
	)
	if len(models) == 0 {
		writeError(w, r, newAPIError(
			http.StatusBadGateway,
			"model_discovery_failed",
			"subscription model discovery failed",
			discoveryErr,
		))
		return
	}
	if discoveryErr != nil {
		slog.WarnContext(
			r.Context(),
			"using embedded inference model metadata with authenticated entitlement",
			slog.String("provider", provider.Name),
			slog.Any("err", discoveryErr),
		)
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferenceModelSuggestions{
		Models:     modelSuggestionsToAPI(models),
		Provenance: gatewayapi.InferenceModelSuggestionsProvenance(provenance),
	})
}

// UpdateInferenceProvider handles PUT /api/inference/provider/{providerName}.
func (s *Service) UpdateInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath, params gatewayapi.UpdateInferenceProviderParams) {
	var req gatewayapi.UpdateInferenceProviderRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, providerName,
		authorization.OperationUpdateInferenceProvider,
	)
	if apiErr != nil {
		if access.claims.TenantID != "" {
			err := s.createInferenceProviderAudit(
				r.Context(), r, access, providerName, access.failureResult(),
			)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	persistenceAudited := false
	defer func() {
		if persistenceAudited {
			return
		}
		err := s.createInferenceProviderAudit(
			context.WithoutCancel(r.Context()), r, access, providerName,
			gatewaydb.AuditResultFailed,
		)
		if err != nil {
			slog.ErrorContext(r.Context(), "audit failed Inference Provider update", slog.Any("err", err))
		}
	}()
	ns := access.namespace
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
	desired.Spec.CreatorUserID = current.Spec.CreatorUserID
	if desired.Spec.Kind != current.Spec.Kind {
		writeInferenceIssues(w, r, []inference.Issue{{
			Field: "kind", Message: "provider kind is immutable",
		}})
		return
	}
	if desired.Spec.CatalogProvider != current.Spec.CatalogProvider {
		writeInferenceIssues(w, r, []inference.Issue{{
			Field: "catalog_provider", Message: "catalog provider is immutable",
		}})
		return
	}
	if fields := inference.ValidateProvider(desired.Spec); len(fields) > 0 {
		writeInferenceIssues(w, r, fields)
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
		writeInferenceIssues(w, r, modelIssues)
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
	path := inference.CredentialPath(ns, current.Name, current.Spec.Kind)
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
	persistenceAudited = true
	if err := s.k8sClient.Update(r.Context(), current); err != nil {
		auditErr := s.createInferenceProviderAudit(
			r.Context(), r, access, providerName, gatewaydb.AuditResultFailed,
		)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
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
	if err := s.createInferenceProviderAudit(
		r.Context(), r, access, providerName, gatewaydb.AuditResultSucceeded,
	); err != nil {
		writeInternalError(w, r, err)
		return
	}
	_, usage, ok := s.providerAndUsage(w, r, ns, current.Name)
	if !ok {
		return
	}
	item, err := providerToAPI(current, len(usage.sandboxes), access)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// DeleteInferenceProvider handles DELETE /api/inference/provider/{providerName}.
func (s *Service) DeleteInferenceProvider(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath, params gatewayapi.DeleteInferenceProviderParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, providerName,
		authorization.OperationDeleteInferenceProvider,
	)
	if apiErr != nil {
		if access.claims.TenantID != "" {
			err := s.createInferenceProviderAudit(
				r.Context(), r, access, providerName, access.failureResult(),
			)
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
		}
		writeError(w, r, apiErr)
		return
	}
	persistenceAudited := false
	defer func() {
		if persistenceAudited {
			return
		}
		if err := s.createInferenceProviderAudit(context.WithoutCancel(r.Context()), r, access, providerName, gatewaydb.AuditResultFailed); err != nil {
			slog.ErrorContext(r.Context(), "audit failed Inference Provider delete", slog.Any("err", err))
		}
	}()
	provider, usage, ok := s.providerAndUsage(w, r, access.namespace, providerName)
	if !ok {
		return
	}
	conflict, err := s.selectedOrganizationResourceConflict(
		r.Context(), access,
		agentzv1alpha1.OrganizationResourceKindInferenceProvider,
		providerName,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if conflict != nil {
		writeError(w, r, conflict)
		return
	}
	if len(usage.pools) > 0 || len(usage.sandboxes) > 0 {
		fields := make([]gatewayapi.FieldError, 0, len(usage.pools)+len(usage.sandboxes))
		for _, pool := range usage.pools {
			fields = append(fields, gatewayapi.FieldError{
				Field: "pools", Message: pool,
			})
		}
		for _, sandbox := range usage.sandboxes {
			fields = append(fields, gatewayapi.FieldError{
				Field: "sandboxes", Message: sandbox,
			})
		}
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"provider_referenced",
			"provider is referenced by one or more pools or sandboxes",
			errBadRequest,
			fields...,
		))
		return
	}
	persistenceAudited = true
	if err := s.k8sClient.Delete(r.Context(), provider); err != nil {
		auditErr := s.createInferenceProviderAudit(
			r.Context(), r, access, providerName, gatewaydb.AuditResultFailed,
		)
		if auditErr != nil {
			writeInternalError(w, r, errors.Join(err, auditErr))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete inference provider", err))
		return
	}
	if err := s.createInferenceProviderAudit(
		r.Context(), r, access, providerName, gatewaydb.AuditResultSucceeded,
	); err != nil {
		writeInternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetInferenceProviderUsage handles GET /api/inference/provider/{providerName}/usage.
func (s *Service) GetInferenceProviderUsage(w http.ResponseWriter, r *http.Request, providerName gatewayapi.InferenceProviderNamePath, params gatewayapi.GetInferenceProviderUsageParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, providerName,
		authorization.OperationGetInferenceProviderUsage,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	_, usage, ok := s.providerAndUsage(w, r, access.namespace, providerName)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.InferenceProviderUsage{
		Provider: providerName, Pools: usage.pools, Sandboxes: usage.sandboxes,
	})
}

// ListInferenceProviderCatalog handles GET /api/inference/provider/catalog.
func (s *Service) ListInferenceProviderCatalog(w http.ResponseWriter, r *http.Request, params gatewayapi.ListInferenceProviderCatalogParams) {
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	_, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationListInferenceProviderCatalog,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	var query string
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
	workspaceID := ""
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	_, apiErr := s.resolveInferenceProviderAccess(
		r.Context(), workspaceID, "", authorization.OperationListInferenceModelSuggestions,
	)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
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
	writeJSON(w, http.StatusOK, gatewayapi.InferenceModelSuggestions{
		Models:     modelSuggestionsToAPI(models),
		Provenance: gatewayapi.InferenceModelSuggestionsProvenance(provenance),
	})
}

func (s *Service) providerAndUsage(w http.ResponseWriter, r *http.Request, namespace, providerName string) (*agentzv1alpha1.InferenceProvider, providerUsage, bool) {
	usage := providerUsage{
		pools:     []string{},
		sandboxes: []string{},
	}
	provider := &agentzv1alpha1.InferenceProvider{}
	key := ctrlclient.ObjectKey{Namespace: namespace, Name: strings.TrimSpace(providerName)}
	if err := s.k8sClient.Get(r.Context(), key, provider); err != nil {
		writeError(w, r, mapKubeHTTPError("get inference provider", err))
		return nil, usage, false
	}
	pools := &agentzv1alpha1.InferencePoolList{}
	err := s.usageReader.List(
		r.Context(),
		pools,
		ctrlclient.InNamespace(namespace),
		ctrlclient.MatchingFields{inference.PoolByProviderIndex: provider.Name},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list dependent inference pools: %w", err))
		return nil, usage, false
	}
	poolNames := make(map[string]struct{}, len(pools.Items))
	for _, pool := range pools.Items {
		poolNames[pool.Name] = struct{}{}
		usage.pools = append(usage.pools, pool.Name)
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	err = s.usageReader.List(r.Context(), sandboxes, ctrlclient.InNamespace(namespace))
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list inference provider usage: %w", err))
		return nil, usage, false
	}
	seen := make(map[string]struct{}, len(sandboxes.Items))
	for _, sandbox := range sandboxes.Items {
		for _, model := range sandbox.Spec.Inference.Models {
			direct := model.Provider == provider.Name
			_, transitive := poolNames[model.Model]
			if !direct && (model.Provider != agentzv1alpha1.InferencePoolProvider || !transitive) {
				continue
			}
			seen[sandbox.Name] = struct{}{}
			break
		}
	}
	for sandbox := range seen {
		usage.sandboxes = append(usage.sandboxes, sandbox)
	}
	slices.Sort(usage.pools)
	slices.Sort(usage.sandboxes)
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
	case "OpenAICodex":
		value, err := req.AsOpenAICodexInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{
				Field: "kind", Message: "openai codex configuration does not match provider kind",
			}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = string(value.CatalogProvider)
		input.Kind = gatewayapi.InferenceProviderKindOpenAICodex
		input.Models = value.Models
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
	case "GitHubCopilot":
		value, err := req.AsGitHubCopilotInferenceProviderWrite()
		if err != nil {
			return input, &inference.InputError{
				Field: "kind", Message: "github copilot configuration does not match provider kind",
			}
		}
		input.DisplayName = value.DisplayName
		input.CatalogProvider = string(value.CatalogProvider)
		input.Kind = gatewayapi.InferenceProviderKindGitHubCopilot
		input.Models = value.Models
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

func providerToAPI(provider *agentzv1alpha1.InferenceProvider, usage int, access resourceAccess) (gatewayapi.InferenceProvider, error) {
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
	scope := authorization.Scope{
		OrganizationID: access.claims.TenantID,
		WorkspaceID:    access.workspaceID,
	}
	creator := provider.Spec.CreatorUserID == access.claims.UserID &&
		access.effective.Allows(scope, authorization.OperationCreateInferenceProvider)
	out := gatewayapi.InferenceProvider{
		Scope: resourceScope(access.workspaceID),
		Id:    provider.Name, ResourceVersion: provider.ResourceVersion,
		DisplayName:     provider.Spec.DisplayName,
		CatalogProvider: provider.Spec.CatalogProvider,
		Models:          modelsToAPI(provider.Spec.Models),
		State:           state, Conditions: conditions,
		ModelCount: len(provider.Spec.Models), UsageCount: usage,
		CanModify: access.effective.Allows(
			scope, authorization.OperationUpdateInferenceProvider,
		) || creator,
		CanDelete: access.effective.Allows(
			scope, authorization.OperationDeleteInferenceProvider,
		) || creator,
		CreatedAt: provider.CreationTimestamp.Time, UpdatedAt: updatedAt,
	}
	switch provider.Spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAICodex:
		err := out.FromOpenAICodexInferenceProviderRead(
			gatewayapi.OpenAICodexInferenceProviderRead{
				Kind: gatewayapi.OpenAICodexInferenceProviderReadKindOpenAICodex,
			},
		)
		if err != nil {
			return out, fmt.Errorf("render openai codex provider response: %w", err)
		}
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
	case agentzv1alpha1.InferenceProviderKindGitHubCopilot:
		err := out.FromGitHubCopilotInferenceProviderRead(
			gatewayapi.GitHubCopilotInferenceProviderRead{
				Kind: gatewayapi.GitHubCopilotInferenceProviderReadKindGitHubCopilot,
			},
		)
		if err != nil {
			return out, fmt.Errorf("render github copilot provider response: %w", err)
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

func inferenceOAuthTicketData(ticket inferenceOAuthTicketRecord) (map[string]any, error) {
	payload, err := json.Marshal(ticket)
	if err != nil {
		return nil, fmt.Errorf("marshal inference oauth ticket: %w", err)
	}
	data := map[string]any{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, fmt.Errorf("encode inference oauth ticket: %w", err)
	}
	return data, nil
}

func decodeInferenceOAuthTicket(data map[string]any) (inferenceOAuthTicketRecord, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return inferenceOAuthTicketRecord{}, fmt.Errorf("marshal inference oauth ticket: %w", err)
	}
	var ticket inferenceOAuthTicketRecord
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ticket); err != nil {
		return inferenceOAuthTicketRecord{}, fmt.Errorf("decode inference oauth ticket: %w", err)
	}
	return ticket, nil
}

func (s *Service) consumeInferenceOAuthTicket(ctx context.Context, namespace, raw string, provider *agentzv1alpha1.InferenceProvider) (inference.SubscriptionRecord, string, error) {
	id, secret, ok := strings.Cut(strings.TrimSpace(raw), ".")
	if !ok {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	idBytes, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(idBytes) != 18 {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	secretBytes, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(secretBytes) != 32 {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	auth, ok := requestAuthState(ctx)
	if !ok || auth.claims == nil {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	path := namespace + "/" + oauthTicketPathDir + "/" + id
	secretRecord, err := s.baoKV.Get(ctx, path)
	if errors.Is(err, baoapi.ErrSecretNotFound) {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	if err != nil {
		return inference.SubscriptionRecord{}, "", fmt.Errorf(
			"read inference oauth ticket: %w", err,
		)
	}
	if secretRecord.VersionMetadata == nil {
		return inference.SubscriptionRecord{}, "", errors.New(
			"read inference oauth ticket: missing version metadata",
		)
	}
	ticket, err := decodeInferenceOAuthTicket(secretRecord.Data)
	if err != nil {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	digest := sha256.Sum256(secretBytes)
	wantDigest, err := base64.RawURLEncoding.DecodeString(ticket.SecretHash)
	if err != nil {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	secretMismatch := subtle.ConstantTimeCompare(digest[:], wantDigest) != 1
	expired := time.Now().UTC().After(ticket.ExpiresAt)
	identityMismatch := ticket.TenantID != auth.claims.TenantID || ticket.UserID != auth.claims.UserID
	kindMismatch := ticket.Subscription.Kind != provider.Spec.Kind
	if secretMismatch || expired || identityMismatch || kindMismatch {
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or expired",
		}
	}
	for _, selected := range provider.Spec.Models {
		if !slices.ContainsFunc(ticket.Models, func(available agentzv1alpha1.InferenceModel) bool {
			return reflect.DeepEqual(selected, available)
		}) {
			return inference.SubscriptionRecord{}, "", &inference.InputError{
				Field: "models", Message: "model is not available to this subscription",
			}
		}
	}
	claimPayload, err := json.Marshal(inferenceOAuthTicketClaim{ConsumedAt: time.Now().UTC()})
	if err != nil {
		return inference.SubscriptionRecord{}, "", fmt.Errorf("marshal inference oauth ticket claim: %w", err)
	}
	claim := map[string]any{}
	if err := json.Unmarshal(claimPayload, &claim); err != nil {
		return inference.SubscriptionRecord{}, "", fmt.Errorf("encode inference oauth ticket claim: %w", err)
	}
	_, err = s.baoKV.Put(
		ctx,
		path,
		claim,
		baoapi.WithCheckAndSet(secretRecord.VersionMetadata.Version),
	)
	if err != nil {
		var responseErr *baoapi.ResponseError
		isResponseError := errors.As(err, &responseErr)
		isCASMismatch := isResponseError && slices.Contains(
			responseErr.Errors,
			"check-and-set parameter did not match the current version",
		)
		if !isCASMismatch {
			return inference.SubscriptionRecord{}, "", fmt.Errorf(
				"claim inference oauth ticket: %w", err,
			)
		}
		return inference.SubscriptionRecord{}, "", &inference.InputError{
			Field: "oauth_ticket", Message: "ticket is invalid or already used",
		}
	}
	return ticket.Subscription, path, nil
}

func openAIAccountID(idToken, accessToken string) string {
	// These unverified claims are used only as routing metadata for the same
	// access token. OpenAI remains the authority that authenticates the token.
	for _, token := range []string{idToken, accessToken} {
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			continue
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			continue
		}
		var claims openAIJWTClaims
		if err := json.Unmarshal(payload, &claims); err != nil {
			continue
		}
		if claims.AccountID != "" {
			return claims.AccountID
		}
		if claims.Auth.AccountID != "" {
			return claims.Auth.AccountID
		}
		if len(claims.Organizations) > 0 {
			return claims.Organizations[0].ID
		}
	}
	return ""
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
		if model.Api != nil {
			api := agentzv1alpha1.InferenceModelAPI(*model.Api)
			value.API = &api
		}
		values = append(values, value)
	}
	return values
}

func modelSuggestionsToAPI(models []agentzv1alpha1.InferenceModel) []gatewayapi.InferenceModelSuggestion {
	values := modelsToAPI(models)
	suggestions := make([]gatewayapi.InferenceModelSuggestion, 0, len(values))
	for _, model := range values {
		var catalogProvider string
		if model.CatalogProvider != nil {
			catalogProvider = *model.CatalogProvider
		}
		suggestions = append(suggestions, gatewayapi.InferenceModelSuggestion{
			Id: model.Id, DisplayName: model.DisplayName,
			Capabilities: model.Capabilities, Modalities: model.Modalities,
			Limits: model.Limits, CatalogProvider: catalogProvider, Api: model.Api,
		})
	}
	return suggestions
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
		if model.API != nil {
			api := gatewayapi.InferenceModelAPI(*model.API)
			value.Api = &api
		}
		values = append(values, value)
	}
	return values
}

func writeInferenceIssues(w http.ResponseWriter, r *http.Request, issues []inference.Issue) {
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
	writeInferenceIssues(w, r, []inference.Issue{{
		Field: inputErr.Field, Message: inputErr.Message,
	}})
}
