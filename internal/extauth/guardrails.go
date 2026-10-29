package extauth

import (
	"context"
	"errors"
	"log/slog"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/grpc/codes"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/guardrails"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) evaluateGuardrailRevision(ctx context.Context, attrs *authv3.AttributeContext, request requestAttrs) (checkDecision, requestAttrs) {
	extensions := attrs.GetContextExtensions()
	namespace := extensions["agentz.guardrail_namespace"]
	sandboxName := extensions["agentz.guardrail_sandbox"]
	request.sandboxNamespace = namespace
	request.sandbox = sandboxName
	sandbox := &api.Sandbox{}
	err := s.kube.Get(ctx, client.ObjectKey{Namespace: namespace, Name: sandboxName}, sandbox)
	if err == nil && !sandbox.DeletionTimestamp.IsZero() {
		err = errors.New("sandbox is terminating")
	}
	if err == nil {
		var bundle *guardrails.Bundle
		bundle, err = guardrails.Resolve(ctx, s.kube, namespace, sandbox.Spec.Guardrails)
		if err == nil && bundle.Revision == extensions["agentz.guardrail_revision"] {
			return allowDecision(injectedRequest{}), request
		}
	}
	if err != nil {
		slog.WarnContext(ctx, "guardrail admission unavailable", "namespace", namespace, "sandbox", sandboxName, "err", err)
	}
	return denyDecision(
		codes.Unavailable, typev3.StatusCode_ServiceUnavailable,
		"Safeguards are being updated or are temporarily unavailable. Retry shortly.",
		"guardrail_rollout_pending", slog.LevelWarn,
	), request
}
