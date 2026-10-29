package sandbox

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/guardrails"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/networkpolicy"
	"github.com/accuknox/agentz/internal/scope"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const sandboxNamespaceLabel = "agentz.accuknox.com/sandbox-namespace"

func (r *Reconciler) reconcileInference(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) (bool, error) {
	bundle, err := guardrails.Resolve(ctx, r.Client, sandbox.Namespace, sandbox.Spec.Guardrails)
	if err != nil {
		return false, fmt.Errorf("resolve guardrails: %w", err)
	}
	providers := make(map[string]*agentzv1alpha1.InferenceProvider)
	models := make(map[string][]string)
	targets := []inference.SandboxTarget{}
	ready := len(sandbox.Spec.Inference.Models) > 0
	for _, ref := range sandbox.Spec.Inference.Models {
		ns, err := scope.Namespace(ctx, r.Client, sandbox.Namespace, ref.Scope)
		if err != nil {
			return false, fmt.Errorf("resolve inference reference scope: %w", err)
		}
		if ref.Provider == agentzv1alpha1.InferencePoolProvider {
			pool := &agentzv1alpha1.InferencePool{}
			key := client.ObjectKey{Namespace: ns, Name: ref.Model}
			if err := r.Get(ctx, key, pool); err != nil {
				return false, fmt.Errorf("get inference pool %q: %w", ref.Model, err)
			}
			if !pool.DeletionTimestamp.IsZero() {
				return false, fmt.Errorf("inference pool %q is terminating", ref.Model)
			}
			switch pool.Status.State {
			case agentzv1alpha1.InferencePoolStateReady,
				agentzv1alpha1.InferencePoolStatePartiallyDegraded:
			default:
				ready = false
			}
			targets = append(
				targets,
				inference.SandboxTarget{
					Name:             "pool-" + pool.Name,
					Backend:          pool.Name,
					BackendNamespace: pool.Namespace,
					Path:             inference.SandboxPoolPath(sandbox.Name, pool.Name),
					Models:           []string{pool.Name},
					Labels:           map[string]string{inference.PoolLabel: pool.Name},
					ExtAuth:          true,
				},
			)
			if pool.Spec.AutomaticFailover {
				targets[len(targets)-1].Retries = len(pool.Spec.Members) - 1
			}
			continue
		}
		ns, err = scope.SelectedNamespace(
			ctx,
			r.Client,
			sandbox.Namespace,
			scope.Selection{
				Scope: ref.Scope,
				Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
				Name:  ref.Provider,
			},
		)
		if err != nil {
			return false, fmt.Errorf("resolve inference provider scope: %w", err)
		}
		providerKey := ns + "/" + ref.Provider
		provider := providers[providerKey]
		if provider == nil {
			provider = &agentzv1alpha1.InferenceProvider{}
			key := client.ObjectKey{Namespace: ns, Name: ref.Provider}
			if err := r.Get(ctx, key, provider); err != nil {
				return false, fmt.Errorf("get inference provider %q: %w", ref.Provider, err)
			}
			if !provider.DeletionTimestamp.IsZero() {
				return false, fmt.Errorf("inference provider %q is terminating", ref.Provider)
			}
			providers[providerKey] = provider
			ready = ready && provider.Status.State == agentzv1alpha1.InferenceProviderStateReady
		}
		var found bool
		for _, model := range provider.Spec.Models {
			if model.ID == ref.Model {
				found = true
				break
			}
		}
		if !found {
			return false, fmt.Errorf(
				"inference provider %q does not enable model %q",
				ref.Provider,
				ref.Model,
			)
		}
		models[providerKey] = append(models[providerKey], ref.Model)
	}
	for providerKey, provider := range providers {
		kind := provider.Spec.Kind
		targets = append(
			targets,
			inference.SandboxTarget{
				Name:             provider.Name,
				Backend:          provider.Name,
				BackendNamespace: provider.Namespace,
				Path:             inference.SandboxProviderPath(sandbox.Name, provider.Name),
				Models:           models[providerKey],
				Labels:           map[string]string{inference.ProviderLabel: provider.Name},
				ExtAuth:          kind == agentzv1alpha1.InferenceProviderKindOpenAICodex,
			},
		)
	}
	slices.SortFunc(
		targets,
		func(a, b inference.SandboxTarget) int {
			return strings.Compare(a.Name, b.Name)
		},
	)
	if err := r.reconcileInferenceGateway(ctx, sandbox.Namespace); err != nil {
		return false, err
	}
	if len(sandbox.Spec.Inference.Models) == 0 {
		return false, nil
	}
	gateway := &gwv1.Gateway{}
	key := client.ObjectKey{Namespace: sandbox.Namespace, Name: inference.GatewayName}
	if err := r.Get(ctx, key, gateway); err != nil {
		return false, fmt.Errorf("get inference gateway status: %w", err)
	}
	if ready {
		ready = meta.IsStatusConditionTrue(
			gateway.Status.Conditions,
			string(gwv1.GatewayConditionProgrammed),
		)
	}
	tracePolicy := &agentgatewayv1alpha1.AgentgatewayPolicy{}
	key.Name = inferenceTracePolicyName
	if err := r.Get(ctx, key, tracePolicy); err != nil {
		return false, fmt.Errorf("get inference trace policy status: %w", err)
	}
	if ready {
		ready = inferencePolicyReady(tracePolicy)
	}
	desired := make(map[string]struct{}, len(targets))
	desiredGrants := make(map[client.ObjectKey]struct{}, len(targets))
	agents, err := r.referencingAgents(ctx, sandbox)
	if err != nil {
		return false, fmt.Errorf("find inference sandbox agents: %w", err)
	}
	if len(agents) > 128 {
		if err := r.deleteStaleInferenceRuntime(ctx, sandbox, desired); err != nil {
			return false, err
		}
		return false, fmt.Errorf("inference route has %d agent matches; maximum is 128", len(agents))
	}
	if len(agents) == 0 {
		targets = nil
	}
	for _, target := range targets {
		runtime := inference.RenderSandboxTarget(sandbox.Namespace, sandbox.Name, target, agents)
		bundle.Apply(runtime.Policy)
		runtime.Policy.Spec.Traffic.ExtAuth = &agentgatewayv1alpha1.ExtAuthOrConditional{
			ExtAuth: agentgatewayv1alpha1.ExtAuth{
				PolicyBackendEndpoint: agentgatewayv1alpha1.PolicyBackendEndpoint{
					BackendRef: &gwv1.BackendObjectReference{
						Name: gwv1.ObjectName(mcp.ExtAuthServiceName),
						Port: new(mcp.ExtAuthPort),
					},
				},
				GRPC: &agentgatewayv1alpha1.AgentExtAuthGRPC{
					ContextExtensions: map[string]string{
						"agentz.guardrail_namespace": sandbox.Namespace,
						"agentz.guardrail_sandbox":   sandbox.Name,
						"agentz.guardrail_revision":  bundle.Revision,
					},
				},
			},
		}

		desired[runtime.Route.Name] = struct{}{}
		if target.BackendNamespace != "" && target.BackendNamespace != sandbox.Namespace {
			grant := &gwv1.ReferenceGrant{
				ObjectMeta: metav1.ObjectMeta{
					Name: inference.SandboxProviderRuntimeName(
						sandbox.Namespace+"-"+sandbox.Name,
						target.Name,
					),
					Namespace: target.BackendNamespace,
				},
			}
			_, err := ctrlutil.CreateOrPatch(
				ctx,
				r.Client,
				grant,
				func() error {
					backend := gwv1.ObjectName(target.Backend)
					grant.Labels = map[string]string{
						inference.SandboxLabel: sandbox.Name,
						sandboxNamespaceLabel:  sandbox.Namespace,
					}
					grant.Spec = gwv1.ReferenceGrantSpec{
						From: []gwv1.ReferenceGrantFrom{{
							Group:     "gateway.networking.k8s.io",
							Kind:      "HTTPRoute",
							Namespace: gwv1.Namespace(sandbox.Namespace),
						}},
						To: []gwv1.ReferenceGrantTo{{
							Group: "agentgateway.dev",
							Kind:  "AgentgatewayBackend",
							Name:  &backend,
						}},
					}
					return nil
				},
			)
			if err != nil {
				return false, fmt.Errorf("reconcile inference backend reference grant: %w", err)
			}
			desiredGrants[client.ObjectKeyFromObject(grant)] = struct{}{}
		}
		currentRoute := &gwv1.HTTPRoute{
			ObjectMeta: metav1.ObjectMeta{
				Name:      runtime.Route.Name,
				Namespace: runtime.Route.Namespace,
			},
		}
		_, err := ctrlutil.CreateOrPatch(
			ctx,
			r.Client,
			currentRoute,
			func() error {
				if currentRoute.UID != "" && !metav1.IsControlledBy(currentRoute, sandbox) {
					return errors.New("inference route name is already in use")
				}
				currentRoute.Labels = runtime.Route.Labels
				currentRoute.Spec = runtime.Route.Spec
				return ctrl.SetControllerReference(sandbox, currentRoute, r.Scheme)
			},
		)
		if err != nil {
			return false, fmt.Errorf("reconcile inference route: %w", err)
		}
		if ready {
			ready = inferenceRouteReady(currentRoute)
		}
		currentPolicy := &agentgatewayv1alpha1.AgentgatewayPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name:      runtime.Policy.Name,
				Namespace: runtime.Policy.Namespace,
			},
		}
		_, err = ctrlutil.CreateOrPatch(
			ctx,
			r.Client,
			currentPolicy,
			func() error {
				if currentPolicy.UID != "" && !metav1.IsControlledBy(currentPolicy, sandbox) {
					return errors.New("inference policy name is already in use")
				}
				currentPolicy.Labels = runtime.Policy.Labels
				currentPolicy.Spec = runtime.Policy.Spec
				return ctrl.SetControllerReference(sandbox, currentPolicy, r.Scheme)
			},
		)
		if err != nil {
			return false, fmt.Errorf("reconcile inference authorization: %w", err)
		}
		if ready {
			ready = inferencePolicyReady(currentPolicy)
		}
	}
	grants := &gwv1.ReferenceGrantList{}
	grantLabels := client.MatchingLabels{
		inference.SandboxLabel: sandbox.Name,
		sandboxNamespaceLabel:  sandbox.Namespace,
	}
	if err := r.List(ctx, grants, grantLabels); err != nil {
		return false, fmt.Errorf("list inference backend reference grants: %w", err)
	}
	for i := range grants.Items {
		if _, ok := desiredGrants[client.ObjectKeyFromObject(&grants.Items[i])]; ok {
			continue
		}
		if err := r.Delete(ctx, &grants.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return false, fmt.Errorf("delete stale inference backend reference grant: %w", err)
		}
	}
	if err := r.deleteStaleInferenceRuntime(ctx, sandbox, desired); err != nil {
		return false, err
	}
	return ready, nil
}

func inferenceRouteReady(route *gwv1.HTTPRoute) bool {
	for _, parent := range route.Status.Parents {
		acceptedCondition := meta.FindStatusCondition(parent.Conditions, string(gwv1.RouteConditionAccepted))
		accepted := acceptedCondition != nil && acceptedCondition.Status == metav1.ConditionTrue && acceptedCondition.ObservedGeneration == route.Generation
		resolvedCondition := meta.FindStatusCondition(parent.Conditions, string(gwv1.RouteConditionResolvedRefs))
		resolved := resolvedCondition != nil && resolvedCondition.Status == metav1.ConditionTrue && resolvedCondition.ObservedGeneration == route.Generation
		if accepted && resolved {
			return true
		}
	}
	return false
}

func inferencePolicyReady(policy *agentgatewayv1alpha1.AgentgatewayPolicy) bool {
	for _, ancestor := range policy.Status.Ancestors {
		acceptedCondition := meta.FindStatusCondition(ancestor.Conditions, "Accepted")
		accepted := acceptedCondition != nil && acceptedCondition.Status == metav1.ConditionTrue && acceptedCondition.ObservedGeneration == policy.Generation
		attachedCondition := meta.FindStatusCondition(ancestor.Conditions, "Attached")
		attached := attachedCondition != nil && attachedCondition.Status == metav1.ConditionTrue && attachedCondition.ObservedGeneration == policy.Generation
		if accepted && attached {
			return true
		}
	}
	return false
}

func (r *Reconciler) reconcileInferenceGateway(ctx context.Context, namespace string) error {
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := r.List(ctx, sandboxes, client.InNamespace(namespace)); err != nil {
		return fmt.Errorf("list inference gateway owners: %w", err)
	}
	owners := make([]agentzv1alpha1.Sandbox, 0, len(sandboxes.Items))
	for _, sandbox := range sandboxes.Items {
		if sandbox.DeletionTimestamp.IsZero() && len(sandbox.Spec.Inference.Models) > 0 {
			owners = append(owners, sandbox)
		}
	}
	slices.SortFunc(
		owners,
		func(a, b agentzv1alpha1.Sandbox) int {
			return strings.Compare(a.Name, b.Name)
		},
	)
	grants := &gwv1.HTTPRouteList{}
	err := r.List(ctx, grants, client.InNamespace(namespace), client.HasLabels{authorization.DelegationLabel})
	if err != nil {
		return err
	}
	delegated := slices.ContainsFunc(grants.Items, func(route gwv1.HTTPRoute) bool {
		for _, parent := range route.Spec.ParentRefs {
			if parent.Name == gwv1.ObjectName(inference.GatewayName) {
				return true
			}
		}
		return false
	})
	if len(owners) == 0 && delegated {
		return nil
	}
	if len(owners) == 0 {
		gateway := &gwv1.Gateway{
			ObjectMeta: metav1.ObjectMeta{Name: inference.GatewayName, Namespace: namespace},
		}
		if err := r.Delete(ctx, gateway); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete inference gateway: %w", err)
		}
		policy := &ciliumv2.CiliumNetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: inference.GatewayName, Namespace: namespace},
		}
		if err := r.Delete(ctx, policy); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete inference gateway network policy: %w", err)
		}
		if err := r.deleteNamedTraceBackend(ctx, namespace, inferenceTraceBackendName); err != nil {
			return err
		}
		tracePolicy := &agentgatewayv1alpha1.AgentgatewayPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: inferenceTracePolicyName, Namespace: namespace},
		}
		if err := r.Delete(ctx, tracePolicy); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete inference trace policy: %w", err)
		}
		return r.deleteAgentgatewayParameters(ctx, namespace, inference.ParametersName)
	}
	err = r.reconcileTraceBackend(ctx, namespace, inferenceTraceBackendName, owners)
	if err != nil {
		return err
	}
	tracePolicy := &agentgatewayv1alpha1.AgentgatewayPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: inferenceTracePolicyName, Namespace: namespace},
	}
	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		tracePolicy,
		func() error {
			tracePolicy.OwnerReferences = sandboxOwnerReferences(owners)
			tracePolicy.Spec = agentgatewayv1alpha1.AgentgatewayPolicySpec{
				TargetRefs: []agentgatewayv1alpha1.LocalPolicyTargetReferenceWithSectionName{{
					LocalPolicyTargetReference: agentgatewayv1alpha1.LocalPolicyTargetReference{
						Group: gwv1.Group("gateway.networking.k8s.io"),
						Kind:  gwv1.Kind("Gateway"),
						Name:  gwv1.ObjectName(inference.GatewayName),
					},
				}},
				Frontend: &agentgatewayv1alpha1.Frontend{
					Tracing: r.inferenceTracing(namespace),
				},
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("reconcile inference trace policy: %w", err)
	}
	gateway := &gwv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: inference.GatewayName, Namespace: namespace},
	}
	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		gateway,
		func() error {
			desired := inference.Gateway(namespace)
			for _, listener := range gateway.Spec.Listeners {
				if listener.Name == "delegation" {
					desired.Spec.Listeners = append(desired.Spec.Listeners, listener)
				}
			}
			gateway.Spec = desired.Spec
			if !delegated {
				gateway.OwnerReferences = sandboxOwnerReferences(owners)
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("reconcile inference gateway: %w", err)
	}
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: inference.GatewayName, Namespace: namespace},
	}
	providerKeys := map[client.ObjectKey]struct{}{}
	for i := range owners {
		for _, model := range owners[i].Spec.Inference.Models {
			ns, err := scope.Namespace(ctx, r.Client, namespace, model.Scope)
			if err != nil {
				return fmt.Errorf("resolve inference policy reference scope: %w", err)
			}
			if model.Provider != agentzv1alpha1.InferencePoolProvider {
				ns, err = scope.SelectedNamespace(
					ctx,
					r.Client,
					namespace,
					scope.Selection{
						Scope: model.Scope,
						Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
						Name:  model.Provider,
					},
				)
				if err != nil {
					return fmt.Errorf("resolve inference policy provider scope: %w", err)
				}
				key := client.ObjectKey{Namespace: ns, Name: model.Provider}
				providerKeys[key] = struct{}{}
				continue
			}
			pool := &agentzv1alpha1.InferencePool{}
			key := client.ObjectKey{Namespace: ns, Name: model.Model}
			if err := r.Get(ctx, key, pool); err != nil {
				return fmt.Errorf("get inference policy pool: %w", err)
			}
			for _, member := range pool.Spec.Members {
				memberNamespace, err := scope.SelectedNamespace(
					ctx,
					r.Client,
					pool.Namespace,
					scope.Selection{
						Scope: member.Scope,
						Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
						Name:  member.Provider,
					},
				)
				if err != nil {
					return fmt.Errorf("resolve inference policy pool member scope: %w", err)
				}
				key := client.ObjectKey{
					Namespace: memberNamespace,
					Name:      member.Provider,
				}
				providerKeys[key] = struct{}{}
			}
		}
	}
	egressTargets := make([]networkpolicy.Target, 0, len(providerKeys)+1)
	for i := range owners {
		bundle, err := guardrails.Resolve(ctx, r.Client, namespace, owners[i].Spec.Guardrails)
		if err != nil {
			return err
		}
		targets, err := bundle.ProjectConnections(ctx, r.Client, namespace, r.GuardrailStoreName)
		if err != nil {
			return err
		}
		egressTargets = append(egressTargets, targets...)
	}
	extAuthNamespaces := []string{namespace}
	for key := range providerKeys {
		provider := &agentzv1alpha1.InferenceProvider{}
		if err := r.Get(ctx, key, provider); err != nil {
			return fmt.Errorf("get inference policy provider: %w", err)
		}
		kind := provider.Spec.Kind
		if kind == agentzv1alpha1.InferenceProviderKindOpenAICodex && provider.Namespace != namespace {
			extAuthNamespaces = append(extAuthNamespaces, provider.Namespace)
		}
		target, err := inference.RenderProviderTarget(provider, "")
		if err != nil {
			return fmt.Errorf("render inference policy provider: %w", err)
		}
		egressTargets = append(
			egressTargets,
			networkpolicy.Target{
				Host: target.LLM.Host,
				Port: target.LLM.Port,
			},
		)
		for _, host := range target.AdditionalHosts {
			egressTargets = append(
				egressTargets,
				networkpolicy.Target{
					Host: host,
					Port: target.LLM.Port,
				},
			)
		}
	}
	slices.Sort(extAuthNamespaces)
	extAuthNamespaces = slices.Compact(extAuthNamespaces)
	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		policy,
		func() error {
			ingress := make([]ciliumapi.IngressRule, 0, len(owners))
			for i := range owners {
				agents, err := r.referencingAgents(ctx, &owners[i])
				if err != nil {
					return fmt.Errorf("find inference sandbox agents: %w", err)
				}
				for j := range agents {
					agt := &agents[j]
					ingress = append(
						ingress,
						ciliumapi.IngressRule{
							IngressCommonRule: ciliumapi.IngressCommonRule{
								FromEndpoints: []ciliumapi.EndpointSelector{
									ciliumapi.NewESFromLabels(
										ciliumlabels.NewLabel(
											"io.kubernetes.pod.namespace",
											agt.Namespace,
											ciliumlabels.LabelSourceK8s,
										),
										ciliumlabels.NewLabel(
											"app.kubernetes.io/name",
											"agentz-agent",
											ciliumlabels.LabelSourceK8s,
										),
										ciliumlabels.NewLabel(
											"app.kubernetes.io/instance",
											agt.Name,
											ciliumlabels.LabelSourceK8s,
										),
										ciliumlabels.NewLabel(
											"agentz.accuknox.com/agent",
											agt.Name,
											ciliumlabels.LabelSourceK8s,
										),
										ciliumlabels.NewLabel(
											"agentz.accuknox.com/managed",
											"true",
											ciliumlabels.LabelSourceK8s,
										),
									),
								},
							},
							ToPorts: []ciliumapi.PortRule{{
								Ports: []ciliumapi.PortProtocol{{
									Port:     "80",
									Protocol: ciliumapi.ProtoTCP,
								}},
								Rules: &ciliumapi.L7Rules{
									HTTP: ciliumapi.PortRulesHTTP{
										{
											Path: "^" + inference.AgentRoutePath(
												regexp.QuoteMeta(agt.Namespace),
												regexp.QuoteMeta(agt.Name),
												inference.SandboxProviderPath(regexp.QuoteMeta(owners[i].Name), "[^/]+"),
											) + "/.*$",
										},
										{
											Path: "^" + inference.AgentRoutePath(
												regexp.QuoteMeta(agt.Namespace),
												regexp.QuoteMeta(agt.Name),
												inference.SandboxPoolPath(regexp.QuoteMeta(owners[i].Name), "[^/]+"),
											) + "/.*$",
										},
									},
								},
							}},
						},
					)
				}
			}
			policy.OwnerReferences = sandboxOwnerReferences(owners)
			policy.Spec = gatewayNetworkPolicySpec(
				namespace,
				inference.GatewayName,
				r.TraceBackend,
			)
			policy.Spec.Ingress = ingress
			policy.Spec.Egress = append(
				policy.Spec.Egress,
				networkpolicy.ExternalEgress(egressTargets)...,
			)
			for _, namespace := range extAuthNamespaces {
				policy.Spec.Egress = append(
					policy.Spec.Egress,
					networkpolicy.ServiceEgress(
						namespace,
						mcp.ExtAuthServiceName,
						mcp.ExtAuthPort,
					)...,
				)
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("reconcile inference gateway network policy: %w", err)
	}
	return r.ensureAgentgatewayParameters(ctx, namespace, inference.ParametersName)
}

func (r *Reconciler) inferenceTracing(namespace string) *agentgatewayv1alpha1.Tracing {
	randomSampling := agentgatewayv1alpha1.CELExpression("true")
	return &agentgatewayv1alpha1.Tracing{
		PolicyBackendEndpoint: agentgatewayv1alpha1.PolicyBackendEndpoint{
			BackendRef: r.TraceBackend.BackendRef(inferenceTraceBackendName),
		},
		Protocol:         agentgatewayv1alpha1.OTLPProtocolGrpc,
		RandomSampling:   &randomSampling,
		ClientSampling:   &randomSampling,
		ParentNotSampled: &randomSampling,
		Attributes: &agentgatewayv1alpha1.LogTracingAttributes{
			Add: []agentgatewayv1alpha1.AttributeAdd{
				{
					Name:       "agentz.guardrails",
					Expression: "toJson(guardrails)",
				},
				{
					Name:       "agentz.guardrail_request",
					Expression: guardrails.RequestCaptureExpression,
				},
				{
					Name:       "agentz.guardrail_revision",
					Expression: `default(metadata.agentz_guardrail_revision, "")`,
				},
				{
					Name:       "session.id",
					Expression: `default(request.headers["x-session-id"], "")`,
				},
				{
					Name:       "agentz.tenant_namespace",
					Expression: `request.path.split("/")[2]`,
				},
				{
					Name:       "agentz.sandbox_name",
					Expression: `request.path.split("/")[5]`,
				},
				{
					Name:       "agentz.agent_name",
					Expression: `request.path.split("/")[3]`,
				},
				{
					Name:       "gen_ai.request.model",
					Expression: `llm.requestModel`,
				},
			},
		},
		Resources: []agentgatewayv1alpha1.ResourceAdd{
			{
				Name:       "service.name",
				Expression: agentgatewayv1alpha1.CELExpression(strconv.Quote("agentz-inference-gateway")),
			},
			{
				Name:       "service.namespace",
				Expression: agentgatewayv1alpha1.CELExpression(strconv.Quote(namespace)),
			},
		},
	}
}

func (r *Reconciler) deleteStaleInferenceRuntime(ctx context.Context, sandbox *agentzv1alpha1.Sandbox, desired map[string]struct{}) error {
	routes := &gwv1.HTTPRouteList{}
	err := r.List(
		ctx,
		routes,
		client.InNamespace(sandbox.Namespace),
		client.MatchingLabels{inference.SandboxLabel: sandbox.Name},
	)
	if err != nil {
		return fmt.Errorf("list inference routes: %w", err)
	}
	for i := range routes.Items {
		if _, exists := desired[routes.Items[i].Name]; exists {
			continue
		}
		if !metav1.IsControlledBy(&routes.Items[i], sandbox) {
			continue
		}
		if err := r.Delete(ctx, &routes.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete stale inference route: %w", err)
		}
	}
	policies := &agentgatewayv1alpha1.AgentgatewayPolicyList{}
	err = r.List(
		ctx,
		policies,
		client.InNamespace(sandbox.Namespace),
		client.MatchingLabels{inference.SandboxLabel: sandbox.Name},
	)
	if err != nil {
		return fmt.Errorf("list inference policies: %w", err)
	}
	for i := range policies.Items {
		if _, exists := desired[policies.Items[i].Name]; exists {
			continue
		}
		if !metav1.IsControlledBy(&policies.Items[i], sandbox) {
			continue
		}
		if err := r.Delete(ctx, &policies.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete stale inference policy: %w", err)
		}
	}
	return nil
}
