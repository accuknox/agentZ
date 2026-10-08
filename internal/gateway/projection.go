package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/networkpolicy"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) delegationReady(ctx context.Context, grant gatewaydb.DelegationGrant, namespace, gateway, name string, policyNames ...string) error {
	conditionsReady := func(conditions []metav1.Condition, generation int64, names ...string) bool {
		for _, name := range names {
			condition := meta.FindStatusCondition(conditions, name)
			if condition == nil || condition.Status != metav1.ConditionTrue || condition.ObservedGeneration != generation {
				return false
			}
		}
		return true
	}
	key := ctrlclient.ObjectKey{Namespace: namespace, Name: name}
	hash := sha256.Sum256(grant.Selection)
	selection := fmt.Sprintf("%x", hash)
	route := &gwv1.HTTPRoute{}
	if err := s.k8sClient.Get(ctx, key, route); err != nil {
		return err
	}
	if route.Annotations["agentz.accuknox.com/selection"] != selection {
		return errors.New("route selection is not current")
	}
	ready := false
	for _, parent := range route.Status.Parents {
		if parent.ParentRef.Name != gwv1.ObjectName(gateway) || parent.ControllerName != "agentgateway.dev/agentgateway" {
			continue
		}
		ready = ready || conditionsReady(parent.Conditions, route.Generation,
			string(gwv1.RouteConditionAccepted), string(gwv1.RouteConditionResolvedRefs))
	}
	if !ready {
		return errors.New("route is not accepted")
	}
	backend := &agw.AgentgatewayBackend{}
	if err := s.k8sClient.Get(ctx, key, backend); err != nil {
		return err
	}
	currentSelection := backend.Annotations["agentz.accuknox.com/selection"] == selection
	if !currentSelection || !conditionsReady(backend.Status.Conditions, backend.Generation, "Accepted") {
		return errors.New("backend is not accepted")
	}
	for _, policyName := range policyNames {
		policy := &agw.AgentgatewayPolicy{}
		key.Name = policyName
		if err := s.k8sClient.Get(ctx, key, policy); err != nil {
			return err
		}
		if policy.Annotations["agentz.accuknox.com/selection"] != selection {
			return errors.New("credential policy selection is not current")
		}
		ready = false
		for _, ancestor := range policy.Status.Ancestors {
			matchingGateway := ancestor.AncestorRef.Name == gwv1.ObjectName(gateway) &&
				ancestor.ControllerName == "agentgateway.dev/agentgateway"
			if !matchingGateway {
				continue
			}
			ready = ready || conditionsReady(ancestor.Conditions, policy.Generation, "Accepted", "Attached")
		}
		if !ready {
			return errors.New("credential policy is not attached")
		}
	}
	return nil
}

func (s *Service) runDelegationRuntime(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.reconcileDelegations(ctx); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "reconcile delegation runtime", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) reconcileDelegations(ctx context.Context) error {
	// One replica owns the snapshot, projection and cleanup cycle. Otherwise
	// an older snapshot can delete routes another replica just created.
	ctx, release, err := gatewayLocks(ctx, s.lockDB)
	if err != nil {
		return err
	}
	defer release()
	queries := ctx.Value(gatewayLockKey{}).(*gatewaydb.Queries)
	locked, err := queries.GatewayTryLockResource(ctx, "delegation-runtime")
	if err != nil || !locked {
		return err
	}
	grants, err := s.queries.GatewayListDelegationGrants(ctx)
	if err != nil {
		return err
	}
	active := make(map[string]bool, len(grants))
	for _, row := range grants {
		active[row.ID] = true
		selection := gatewayapi.DelegationCatalog{}
		if err := json.Unmarshal(row.Selection, &selection); err != nil {
			continue
		}
		if err := s.checkDelegation(ctx, row, selection); err != nil {
			continue
		}
		if err := s.projectDelegation(ctx, row, selection); err != nil {
			slog.ErrorContext(ctx, "project delegation", slog.String("grant", row.ID), slog.Any("error", err))
		}
	}
	// Grant routes are written by the gateway, never by external applications.
	for _, list := range []ctrlclient.ObjectList{&gwv1.HTTPRouteList{}, &agw.AgentgatewayBackendList{}, &agw.AgentgatewayPolicyList{}, &ciliumv2.CiliumNetworkPolicyList{}} {
		err := s.k8sClient.List(ctx, list, ctrlclient.HasLabels{authorization.DelegationLabel})
		if err != nil {
			return err
		}
		objects, err := meta.ExtractList(list)
		if err != nil {
			return err
		}
		for _, item := range objects {
			object := item.(ctrlclient.Object)
			if active[object.GetLabels()[authorization.DelegationLabel]] {
				continue
			}
			if err := ctrlclient.IgnoreNotFound(s.k8sClient.Delete(ctx, object)); err != nil {
				return err
			}
		}
	}
	if err := s.queries.GatewayPruneDelegationSessions(ctx); err != nil {
		return err
	}
	return s.queries.GatewayPruneDelegationTransactions(ctx)
}

func (s *Service) projectDelegation(ctx context.Context, grant gatewaydb.DelegationGrant, selection gatewayapi.DelegationCatalog) error {
	var objects []ctrlclient.Object
	ownerEgress := make(map[string][]networkpolicy.Target)
	var aggregationEgress []ciliumapi.EgressRule
	for index, selected := range selection.Models {
		provider := &agentzv1alpha1.InferenceProvider{}
		key := ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Provider}
		err := s.k8sClient.Get(ctx, key, provider)
		if err != nil {
			return err
		}
		if string(provider.UID) != selected.Uid {
			return errors.New("provider was replaced")
		}
		target, err := inference.RenderProviderTarget(provider, selected.Model)
		if err != nil {
			return err
		}
		// Plaintext HTTP/2 must not dictate the external provider's protocol.
		target.Policies.HTTP = &agw.BackendHTTP{Version: new(agw.HTTPVersion1)}
		name := fmt.Sprintf("d-%s-model-%d", grant.ID, index)
		ownerEgress[selected.Namespace] = append(ownerEgress[selected.Namespace], networkpolicy.Target{Host: target.LLM.Host, Port: target.LLM.Port})
		backend := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: selected.Namespace, Name: name},
			Spec: agw.AgentgatewayBackendSpec{AI: &agw.AIBackend{LLM: &target.LLM}, Policies: &agw.BackendFull{
				BackendSimple: target.Policies.BackendSimple, AI: target.Policies.AI, Transformation: target.Policies.Transformation,
				ExtAuth: s.delegatedExtAuth(selected.Id, provider, true),
			}},
		}
		route := s.delegationRoute(selected.Namespace, inference.GatewayName, name, fmt.Sprintf("/delegations/%s/models/%d", grant.ID, index), false)
		objects = append(objects, backend, route)
		// Keep the owner route intact through the shared private ingress. Only the
		// owner gateway rewrites it to the provider's API and injects credentials.
		forward := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: s.cfg.DelegationNamespace, Name: name},
			Spec: agw.AgentgatewayBackendSpec{
				Static:   &agw.StaticBackend{Host: "inference." + selected.Namespace + ".svc.cluster.local", Port: 8080},
				Policies: &agw.BackendFull{BackendSimple: agw.BackendSimple{HTTP: &agw.BackendHTTP{Version: new(agw.HTTPVersion2)}}},
			},
		}
		entry := s.delegationRoute(s.cfg.DelegationNamespace, "delegations", name, fmt.Sprintf("/delegations/%s/models/%d", grant.ID, index), false)
		entry.Spec.Rules[0].Filters = nil
		objects = append(objects, forward, entry)
		aggregationEgress = append(aggregationEgress, networkpolicy.ServiceEgress(selected.Namespace, inference.GatewayName, 8080)...)
	}
	if len(selection.Mcp) > 0 {
		name := "d-" + grant.ID + "-mcp"
		outer := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: s.cfg.DelegationNamespace, Name: name},
			Spec:       agw.AgentgatewayBackendSpec{MCP: &agw.MCPBackend{PrefixMode: agw.PrefixAlways, SessionRouting: agw.Stateful, FailureMode: agw.FailClosed}},
		}
		for index, selected := range selection.Mcp {
			connection := &agentzv1alpha1.MCPConnection{}
			key := ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}
			err := s.k8sClient.Get(ctx, key, connection)
			if err != nil {
				return err
			}
			if string(connection.UID) != selected.Uid {
				return errors.New("MCP connection was replaced")
			}
			target, err := mcp.ParseTarget(connection)
			if err != nil {
				return err
			}
			ownerEgress[selected.Namespace] = append(ownerEgress[selected.Namespace], networkpolicy.Target{Host: target.Host, Port: target.Port})
			aggregationEgress = append(aggregationEgress, networkpolicy.ServiceEgress(selected.Namespace, mcp.GatewayName, 8080)...)
			if !target.Secure || connection.Spec.Endpoint.InsecureSkipVerify {
				return errors.New("delegation requires verified upstream TLS")
			}
			transport := &agw.BackendSimple{
				TLS:  &agw.BackendTLS{Sni: &target.Host},
				HTTP: &agw.BackendHTTP{Version: new(agw.HTTPVersion1), RequestTimeout: connection.Spec.Endpoint.Timeout},
			}
			innerName := fmt.Sprintf("d-%s-mcp-%d", grant.ID, index)
			section := gwv1.SectionName(selected.Id)
			expressions, err := delegationMCPExpressions(selected)
			if err != nil {
				return err
			}
			inner := &agw.AgentgatewayBackend{
				TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
				ObjectMeta: metav1.ObjectMeta{Namespace: selected.Namespace, Name: innerName},
				Spec: agw.AgentgatewayBackendSpec{
					MCP: &agw.MCPBackend{
						PrefixMode: agw.PrefixConditional, SessionRouting: agw.Stateful, FailureMode: agw.FailClosed,
						Targets: []agw.McpTargetSelector{{Name: section, Static: &agw.McpTarget{
							Host: &target.Host, Port: target.Port, Path: target.Path,
							Protocol: target.Protocol, Policies: transport,
						}}},
					},
					Policies: &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: &agw.Authorization{
						Action: agw.AuthorizationPolicyActionAllow,
						Policy: agw.AuthorizationPolicy{MatchExpressions: expressions},
					}}},
				},
			}
			policy := &agw.AgentgatewayPolicy{
				TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayPolicy"},
				ObjectMeta: metav1.ObjectMeta{Namespace: selected.Namespace, Name: innerName + "-auth"},
				Spec: agw.AgentgatewayPolicySpec{
					TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{
						LocalPolicyTargetReference: agw.LocalPolicyTargetReference{
							Group: "agentgateway.dev", Kind: "AgentgatewayBackend", Name: gwv1.ObjectName(innerName),
						},
						SectionName: &section,
					}},
					Backend: &agw.BackendFull{ExtAuth: s.delegatedExtAuth(selected.Id, connection, false)},
				},
			}
			path := "/delegations/" + grant.ID + "/mcp/" + selected.Id
			objects = append(objects, inner, policy, s.delegationRoute(selected.Namespace, mcp.GatewayName, innerName, path, true))
			host := mcp.GatewayName + "." + selected.Namespace + ".svc.cluster.local"
			outer.Spec.MCP.Targets = append(outer.Spec.MCP.Targets, agw.McpTargetSelector{Name: section, Static: &agw.McpTarget{
				Host: &host, Port: 8080, Path: &path, Protocol: new(agw.MCPProtocolStreamableHTTP),
			}})
		}
		objects = append(objects, outer, s.delegationRoute(s.cfg.DelegationNamespace, "delegations", name, "/delegations/"+grant.ID+"/mcp", true))
	}
	if len(aggregationEgress) > 0 {
		objects = append(objects, &ciliumv2.CiliumNetworkPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
			ObjectMeta: metav1.ObjectMeta{Name: "d-" + grant.ID, Namespace: s.cfg.DelegationNamespace},
			Spec:       &ciliumapi.Rule{EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", "delegations", ciliumlabels.LabelSourceK8s)), Egress: aggregationEgress},
		})
	}

	for namespace, targets := range ownerEgress {
		policy := &ciliumv2.CiliumNetworkPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
			ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: "d-" + grant.ID},
			Spec: &ciliumapi.Rule{
				EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", inference.GatewayName, ciliumlabels.LabelSourceK8s)),
				Ingress: []ciliumapi.IngressRule{{IngressCommonRule: ciliumapi.IngressCommonRule{FromEndpoints: []ciliumapi.EndpointSelector{
					ciliumapi.NewESFromLabels(
						ciliumlabels.NewLabel("io.cilium.k8s.policy.serviceaccount", s.cfg.GatewayServiceAccountName, ciliumlabels.LabelSourceK8s),
						ciliumlabels.NewLabel("io.kubernetes.pod.namespace", s.cfg.GatewayServiceAccountNamespace, ciliumlabels.LabelSourceK8s),
					),
					ciliumapi.NewESFromLabels(
						ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", "delegations", ciliumlabels.LabelSourceK8s),
						ciliumlabels.NewLabel("io.cilium.k8s.policy.serviceaccount", "delegations", ciliumlabels.LabelSourceK8s),
						ciliumlabels.NewLabel("io.kubernetes.pod.namespace", s.cfg.DelegationNamespace, ciliumlabels.LabelSourceK8s),
					),
				}}, ToPorts: []ciliumapi.PortRule{{Ports: []ciliumapi.PortProtocol{{Port: "8080", Protocol: ciliumapi.ProtoTCP}}}}}},
			},
		}
		policy.Spec.Egress = networkpolicy.ExternalEgress(targets)
		policy.Spec.Egress = append(policy.Spec.Egress, networkpolicy.ServiceEgress(namespace, mcp.ExtAuthServiceName, 18084)...)
		policy.Spec.Egress = append(policy.Spec.Egress, networkpolicy.ServiceEgress("agentgateway-system", "agentgateway", 9978)...)
		mcpPolicy := policy.DeepCopy()
		mcpPolicy.Name += "-mcp"
		mcpPolicy.Spec.EndpointSelector = ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", mcp.GatewayName, ciliumlabels.LabelSourceK8s))
		mcpPolicy.Spec.Ingress[0].FromEndpoints = mcpPolicy.Spec.Ingress[0].FromEndpoints[1:]
		objects = append(objects, policy, mcpPolicy)
	}
	selectionHash := fmt.Sprintf("%x", sha256.Sum256(grant.Selection))
	for _, object := range objects {
		object.SetLabels(map[string]string{authorization.DelegationLabel: grant.ID})
		object.SetAnnotations(map[string]string{"agentz.accuknox.com/selection": selectionHash})
		data, err := json.Marshal(object)
		if err != nil {
			return err
		}
		err = s.k8sClient.Patch(ctx, object, ctrlclient.RawPatch(types.ApplyPatchType, data),
			ctrlclient.FieldOwner("agentz-delegation"), ctrlclient.ForceOwnership)
		if err != nil {
			return err
		}
	}
	return nil
}

// delegationMCPExpressions splits exact capability allowlists to fit the native
// 16 KiB CEL limit. Allow expressions are ORed by Agentgateway. The selection's
// 256 KiB total limit and 32-target limit also bound the result below 256 rules.
func delegationMCPExpressions(selected gatewayapi.DelegationMCP) ([]agw.CELExpression, error) {
	expressions := make([]agw.CELExpression, 0, 3)
	for _, kind := range []string{"tool", "prompt", "resource"} {
		values := selected.Tools
		switch kind {
		case "prompt":
			values = selected.Prompts
		case "resource":
			values = selected.Resources
		}
		if len(values) == 0 {
			continue
		}
		prefix := fmt.Sprintf("has(mcp.%s) && mcp.%s.target == %q && mcp.%s.name in [", kind, kind, selected.Id, kind)
		expression := prefix
		for _, value := range values {
			encoded := strconv.Quote(value)
			if len(value) > 2500 {
				return nil, errors.New("MCP capability exceeds the native authorization expression limit")
			}
			if len(expression)+len(encoded)+2 > 16384 {
				expressions = append(expressions, agw.CELExpression(expression+"]"))
				expression = prefix
			}
			if len(expression) != len(prefix) {
				expression += ","
			}
			expression += encoded
		}
		expressions = append(expressions, agw.CELExpression(expression+"]"))
	}
	return expressions, nil
}

func (s *Service) delegatedExtAuth(target string, owner ctrlclient.Object, inferenceTarget bool) *agw.ExtAuth {
	policy := &agw.ExtAuth{
		BackendRef: &gwv1.BackendObjectReference{
			Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")), Name: "delegation-extauth",
		},
		FailureMode: agw.FailClosed,
		GRPC: &agw.AgentExtAuthGRPC{ContextExtensions: map[string]string{
			"agentz.target": target, "agentz.uid": string(owner.GetUID()), "agentz.namespace": owner.GetNamespace(),
			"agentz.name": owner.GetName(), "agentz.generation": strconv.FormatInt(owner.GetGeneration(), 10), "agentz.operation": "mcp",
		}},
	}
	if inferenceTarget {
		policy.GRPC.ContextExtensions["agentz.operation"] = "inference"
		limit := resource.MustParse("32Mi")
		policy.ForwardBody = &agw.ExtAuthBody{MaxSize: agw.ByteSize{Value: &limit}}
	}
	return policy
}

func (s *Service) delegationRoute(namespace, gateway, name, path string, mcpTarget bool) *gwv1.HTTPRoute {
	matchType := gwv1.PathMatchPathPrefix
	filters := []gwv1.HTTPRouteFilter{{
		Type:       gwv1.HTTPRouteFilterURLRewrite,
		URLRewrite: &gwv1.HTTPURLRewriteFilter{Path: &gwv1.HTTPPathModifier{Type: gwv1.PrefixMatchHTTPPathModifier, ReplacePrefixMatch: new("/v1")}},
	}}
	if mcpTarget {
		matchType = gwv1.PathMatchExact
		filters = nil
	}
	return &gwv1.HTTPRoute{
		TypeMeta:   metav1.TypeMeta{APIVersion: gwv1.GroupVersion.String(), Kind: "HTTPRoute"},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: gwv1.HTTPRouteSpec{
			CommonRouteSpec: gwv1.CommonRouteSpec{ParentRefs: []gwv1.ParentReference{{Name: gwv1.ObjectName(gateway), SectionName: new(gwv1.SectionName("delegation"))}}},
			Rules: []gwv1.HTTPRouteRule{{
				Matches: []gwv1.HTTPRouteMatch{{Path: &gwv1.HTTPPathMatch{Type: &matchType, Value: &path}}}, Filters: filters,
				BackendRefs: []gwv1.HTTPBackendRef{{BackendRef: gwv1.BackendRef{BackendObjectReference: gwv1.BackendObjectReference{
					Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")), Name: gwv1.ObjectName(name),
				}}}},
			}},
		},
	}
}
