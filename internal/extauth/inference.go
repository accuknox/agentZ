package extauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/grpc/codes"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/scope"
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
		ctx,
		attrs.namespace,
		attrs.sandboxNamespace,
		attrs.sandbox,
		attrs.provider,
		attrs.pool,
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
	if provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindClaudeSubscription {
		return denyDecision(
			codes.PermissionDenied, typev3.StatusCode_Forbidden,
			"Claude subscriptions require an external Claude agent", "external_claude_required", slog.LevelWarn,
		), attrs
	}
	if provider.Spec.Kind != agentzv1alpha1.InferenceProviderKindOpenAICodex {
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
	record, refreshed, err := inference.ResolveSubscription(ctx, s.http, s.kv, provider)
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
	return allowDecision(injectedRequest{
		headers: []*corev3.HeaderValueOption{
			overwriteHeader("authorization", "Bearer "+record.Token.AccessToken),
			overwriteHeader("chatgpt-account-id", record.AccountID),
		},
		headersToRemove: []string{
			inference.SandboxHeader,
			inference.SandboxNamespaceHeader,
		},
	}), attrs
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
			ns, err := scope.SelectedNamespace(
				ctx,
				s.kube,
				sandboxNamespace,
				scope.Selection{
					Scope: model.Scope,
					Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
					Name:  model.Provider,
				},
			)
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
		ns, err := scope.SelectedNamespace(
			ctx,
			s.kube,
			sandboxNamespace,
			scope.Selection{
				Scope: member.Scope,
				Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
				Name:  member.Provider,
			},
		)
		if err == nil && ns == providerNamespace {
			return nil
		}
	}
	return fmt.Errorf("pool %q does not include provider %q", poolName, providerName)
}

func overwriteHeader(name, value string) *corev3.HeaderValueOption {
	return &corev3.HeaderValueOption{
		Header:       &corev3.HeaderValue{Key: name, Value: value},
		AppendAction: corev3.HeaderValueOption_OVERWRITE_IF_EXISTS_OR_ADD,
	}
}
