package extauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	baoapi "github.com/openbao/openbao/api/v2"
	"google.golang.org/grpc/codes"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/oauth"
	"github.com/accuknox/agentz/internal/scoperesolver"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) evaluateInference(ctx context.Context, checkAttrs *authv3.AttributeContext, attrs requestAttrs) (checkDecision, requestAttrs) {
	if ns := strings.TrimSpace(checkAttrs.GetContextExtensions()[contextNamespaceKey]); ns != "" {
		attrs.namespace = ns
	}
	request := checkAttrs.GetRequest()
	if request == nil || request.GetHttp() == nil {
		return denyDecision(
			codes.InvalidArgument,
			typev3.StatusCode_BadRequest,
			"invalid ext auth request",
			"missing_http_request",
			slog.LevelWarn,
		), attrs
	}
	attrs.sandbox = strings.TrimSpace(
		request.GetHttp().GetHeaders()[inference.SandboxHeader],
	)
	if attrs.sandbox == "" {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"inference provider is unavailable",
			"missing_sandbox_context",
			slog.LevelError,
		), attrs
	}
	attrs.sandboxNamespace = strings.TrimSpace(
		request.GetHttp().GetHeaders()[inference.SandboxNamespaceHeader],
	)
	if attrs.sandboxNamespace == "" {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"inference provider is unavailable",
			"missing_sandbox_namespace_context",
			slog.LevelError,
		), attrs
	}
	attrs.sessionID = strings.TrimSpace(
		request.GetHttp().GetHeaders()[sessionHeaderName],
	)
	sourceIP, err := peerAddress(checkAttrs.GetSource())
	if err != nil {
		return denyDecision(
			codes.PermissionDenied,
			typev3.StatusCode_Forbidden,
			"request source is not allowed",
			"missing_source_ip",
			slog.LevelWarn,
		), attrs
	}
	attrs.sourceIP = sourceIP
	err = s.authorizeInferenceTarget(
		ctx, attrs.namespace, attrs.sandboxNamespace, attrs.sandbox,
		attrs.provider, attrs.pool,
	)
	if err != nil {
		code := codes.PermissionDenied
		httpCode := typev3.StatusCode_Forbidden
		level := slog.LevelWarn
		reason := "agent_not_authorized"
		if errors.Is(err, errCredentialUnavailable) {
			code = codes.Unavailable
			httpCode = typev3.StatusCode_ServiceUnavailable
			level = slog.LevelError
			reason = "authorization_lookup_failed"
		}
		return denyDecision(
			code,
			httpCode,
			"inference provider is unavailable",
			reason,
			level,
		), attrs
	}
	provider := &agentzv1alpha1.InferenceProvider{}
	key := ctrlclient.ObjectKey{Namespace: attrs.namespace, Name: attrs.provider}
	if err := s.kube.Get(ctx, key, provider); err != nil {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"inference provider is unavailable",
			"provider_lookup_failed",
			slog.LevelError,
		), attrs
	}
	isSubscription := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex || provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	if !isSubscription {
		if attrs.pool == "" {
			return denyDecision(
				codes.Unavailable,
				typev3.StatusCode_ServiceUnavailable,
				"inference provider is unavailable",
				"provider_not_subscription_backed",
				slog.LevelError,
			), attrs
		}
		return allowDecision(injectedRequest{
			headersToRemove: []string{
				inference.SandboxHeader,
				inference.SandboxNamespaceHeader,
			},
		}), attrs
	}
	record, refreshed, err := s.resolveInferenceSubscription(ctx, provider)
	attrs.refreshAttempted = refreshed
	attrs.refreshSucceeded = refreshed && err == nil
	if err != nil {
		return denyDecision(
			codes.Unavailable,
			typev3.StatusCode_ServiceUnavailable,
			"inference provider is unavailable",
			"credential_resolution_failed",
			slog.LevelError,
		), attrs
	}
	return allowDecision(inferenceInjection(record)), attrs
}

func (s *Service) authorizeInferenceTarget(ctx context.Context, providerNamespace, sandboxNamespace, sandboxName, providerName, poolName string) error {
	// Cilium authorizes the originating Agent against the controller-owned
	// route path before AgentGateway. The L7 proxy then SNATs the connection,
	// so extAuth binds the backend context to the route-overwritten sandbox
	// header instead of treating the observed peer IP as workload identity.
	sandbox := &agentzv1alpha1.Sandbox{}
	key := ctrlclient.ObjectKey{Namespace: sandboxNamespace, Name: sandboxName}
	if err := s.kube.Get(ctx, key, sandbox); err != nil {
		return fmt.Errorf("get inference target sandbox: %w: %w", err, errCredentialUnavailable)
	}
	if poolName == "" {
		for _, model := range sandbox.Spec.Inference.Models {
			if model.Provider != providerName {
				continue
			}
			ns, err := scoperesolver.SelectedNamespace(ctx, s.kube, sandboxNamespace, scoperesolver.Selection{
				Scope: model.Scope,
				Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
				Name:  model.Provider,
			})
			if err == nil && ns == providerNamespace {
				return nil
			}
		}
		return fmt.Errorf("sandbox %q does not include provider %q", sandboxName, providerName)
	}
	var hasPool bool
	for _, model := range sandbox.Spec.Inference.Models {
		if model.Provider == agentzv1alpha1.InferencePoolProvider && model.Model == poolName {
			hasPool = true
			break
		}
	}
	if !hasPool {
		return fmt.Errorf("sandbox %q does not include pool %q", sandboxName, poolName)
	}
	pool := &agentzv1alpha1.InferencePool{}
	key.Namespace = sandboxNamespace
	key.Name = poolName
	if err := s.kube.Get(ctx, key, pool); err != nil {
		return fmt.Errorf("get inference pool: %w: %w", err, errCredentialUnavailable)
	}
	for _, member := range pool.Spec.Members {
		if member.Provider != providerName {
			continue
		}
		ns, err := scoperesolver.SelectedNamespace(ctx, s.kube, sandboxNamespace, scoperesolver.Selection{
			Scope: member.Scope,
			Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
			Name:  member.Provider,
		})
		if err == nil && ns == providerNamespace {
			return nil
		}
	}
	return fmt.Errorf("pool %q does not include provider %q", poolName, providerName)
}

func (s *Service) resolveInferenceSubscription(ctx context.Context, provider *agentzv1alpha1.InferenceProvider) (inference.SubscriptionRecord, bool, error) {
	path := inference.CredentialPath(
		provider.Namespace,
		provider.Name,
		provider.Spec.Kind,
	)
	secret, err := s.kv.Get(ctx, path)
	if err != nil {
		return inference.SubscriptionRecord{}, false, fmt.Errorf("read inference credentials: %w", err)
	}
	record, err := inference.DecodeSubscriptionRecord(secret.Data)
	if err != nil {
		return inference.SubscriptionRecord{}, false, err
	}
	if record.Kind != provider.Spec.Kind {
		return inference.SubscriptionRecord{}, false, fmt.Errorf("inference credential kind does not match provider")
	}
	if oauth.TokenUsable(record.Token, time.Now().UTC()) {
		return record, false, nil
	}

	s.inferenceRefreshMu.Lock()
	defer s.inferenceRefreshMu.Unlock()

	current, err := s.kv.Get(ctx, path)
	if err != nil {
		return inference.SubscriptionRecord{}, true, fmt.Errorf("reread inference credentials: %w", err)
	}
	record, err = inference.DecodeSubscriptionRecord(current.Data)
	if err != nil {
		return inference.SubscriptionRecord{}, true, err
	}
	if record.Kind != provider.Spec.Kind {
		return inference.SubscriptionRecord{}, true, fmt.Errorf("inference credential kind does not match provider")
	}
	record, changed, err := inference.RefreshSubscription(ctx, s.http, record)
	if err != nil {
		return inference.SubscriptionRecord{}, true, err
	}
	if !changed {
		return record, true, nil
	}
	if current.VersionMetadata == nil {
		return inference.SubscriptionRecord{}, true, fmt.Errorf("inference credential version is missing")
	}
	data, err := inference.SubscriptionRecordData(record)
	if err != nil {
		return inference.SubscriptionRecord{}, true, err
	}
	_, writeErr := s.kv.Put(
		ctx,
		path,
		data,
		baoapi.WithCheckAndSet(current.VersionMetadata.Version),
	)
	if writeErr == nil {
		return record, true, nil
	}

	latest, readErr := s.kv.Get(ctx, path)
	if readErr != nil {
		return inference.SubscriptionRecord{}, true, errors.Join(writeErr, readErr)
	}
	if latest.VersionMetadata == nil {
		return inference.SubscriptionRecord{}, true, writeErr
	}
	if latest.VersionMetadata.Version <= current.VersionMetadata.Version {
		return inference.SubscriptionRecord{}, true, writeErr
	}
	record, err = inference.DecodeSubscriptionRecord(latest.Data)
	if err != nil {
		return inference.SubscriptionRecord{}, true, errors.Join(writeErr, err)
	}
	kindChanged := record.Kind != provider.Spec.Kind
	if kindChanged || !oauth.TokenUsable(record.Token, time.Now().UTC()) {
		return inference.SubscriptionRecord{}, true, writeErr
	}
	return record, true, nil
}

func inferenceInjection(record inference.SubscriptionRecord) injectedRequest {
	headers := []*corev3.HeaderValueOption{
		overwriteHeader("authorization", "Bearer "+record.Token.AccessToken),
	}
	if record.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex {
		headers = append(headers, overwriteHeader("chatgpt-account-id", record.AccountID))
	}
	if record.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot {
		headers = append(
			headers,
			overwriteHeader("user-agent", "opencode/1.17.18"),
			overwriteHeader("x-github-api-version", inference.GitHubCopilotAPIVersion),
			overwriteHeader("openai-intent", "conversation-edits"),
		)
	}
	return injectedRequest{
		headers: headers,
		headersToRemove: []string{
			inference.SandboxHeader,
			inference.SandboxNamespaceHeader,
		},
	}
}

func overwriteHeader(name, value string) *corev3.HeaderValueOption {
	return &corev3.HeaderValueOption{
		Header:       &corev3.HeaderValue{Key: name, Value: value},
		AppendAction: corev3.HeaderValueOption_OVERWRITE_IF_EXISTS_OR_ADD,
	}
}
