package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
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

func (s *Service) delegationReady(ctx context.Context, grant gatewaydb.GatewayGetDelegationGrantRow, namespace, gateway, name string, policyNames ...string) error {
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
			if ancestor.AncestorRef.Name != gwv1.ObjectName(gateway) || ancestor.ControllerName != "agentgateway.dev/agentgateway" {
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
	root := &corev1.Secret{}
	if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: s.cfg.DelegationNamespace, Name: "delegation-gateway-tls"}, root); err != nil {
		return err
	}
	if len(root.Data["ca.crt"]) == 0 {
		return errors.New("delegation CA is not ready")
	}
	ca := &corev1.ConfigMap{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMap"},
		ObjectMeta: metav1.ObjectMeta{Name: "delegation-ca", Namespace: s.cfg.DelegationNamespace},
		Data:       map[string]string{"ca.crt": string(root.Data["ca.crt"])},
	}
	data, err := json.Marshal(ca)
	if err != nil {
		return err
	}
	if err := s.k8sClient.Patch(ctx, ca, ctrlclient.RawPatch(types.ApplyPatchType, data), ctrlclient.FieldOwner("agentz-delegation")); err != nil {
		return err
	}

	host, portValue, err := net.SplitHostPort(s.cfg.DelegationAuthorityTarget)
	if err != nil {
		return err
	}
	port, err := strconv.ParseInt(portValue, 10, 32)
	if err != nil {
		return err
	}
	authority := &agw.AgentgatewayBackend{
		TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
		ObjectMeta: metav1.ObjectMeta{Name: "delegation-authority", Namespace: s.cfg.DelegationNamespace},
		Spec: agw.AgentgatewayBackendSpec{Static: &agw.StaticBackend{Host: host, Port: int32(port)}, Policies: &agw.BackendFull{BackendSimple: agw.BackendSimple{TLS: &agw.BackendTLS{
			CACertificateRefs:  []corev1.LocalObjectReference{{Name: "delegation-ca"}},
			MtlsCertificateRef: []agw.LocalSecretObjectRef{{Name: "delegation-gateway-tls"}},
		}}}},
	}
	data, err = json.Marshal(authority)
	if err != nil {
		return err
	}
	if err := s.k8sClient.Patch(ctx, authority, ctrlclient.RawPatch(types.ApplyPatchType, data), ctrlclient.FieldOwner("agentz-delegation")); err != nil {
		return err
	}

	grants, err := s.queries.GatewayListDelegationGrants(ctx)
	if err != nil {
		return err
	}
	active := make(map[string]bool, len(grants))
	for _, row := range grants {
		claims := authorization.DelegationClaims{ClientID: row.ClientID, GrantID: row.ID, Scope: strings.Join(row.Scopes, " ")}
		claims.Subject = row.UserID
		// Keep the projection during dependency outages. Every request still
		// checks live authority; revoked grants disappear from this SQL result.
		active[row.ID] = true
		grant, selection, err := s.checkDelegation(ctx, claims, "")
		if err != nil {
			continue
		}
		if err := s.projectDelegation(ctx, grant, selection); err != nil {
			slog.ErrorContext(ctx, "project delegation", slog.String("grant", row.ID), slog.Any("error", err))
		}
	}
	// Only the private management identity can project or delete grant routes.
	for _, list := range []ctrlclient.ObjectList{&gwv1.HTTPRouteList{}, &agw.AgentgatewayBackendList{}, &agw.AgentgatewayPolicyList{}, &ciliumv2.CiliumNetworkPolicyList{}} {
		if err := s.k8sClient.List(ctx, list, ctrlclient.HasLabels{authorization.DelegationLabel}); err != nil {
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

func (s *Service) projectDelegation(ctx context.Context, grant gatewaydb.GatewayGetDelegationGrantRow, selection gatewayapi.DelegationCatalog) error {
	objects := make([]ctrlclient.Object, 0)
	ownerNamespaces := make(map[string]bool)
	ownerEgress := make(map[string][]networkpolicy.Target)
	aggregationEgress := []ciliumapi.EgressRule{}
	publicEgress := []ciliumapi.EgressRule{}
	for index, selected := range selection.Models {
		provider := &agentzv1alpha1.InferenceProvider{}
		if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Provider}, provider); err != nil {
			return err
		}
		if string(provider.UID) != selected.Uid {
			return errors.New("provider was replaced")
		}
		target, err := inference.RenderProviderTarget(provider, selected.Model)
		if err != nil {
			return err
		}
		publicEgress = append(publicEgress, networkpolicy.ServiceEgress(selected.Namespace, inference.GatewayName, 8443)...)
		name := fmt.Sprintf("d-%s-model-%d", grant.ID, index)
		ownerEgress[selected.Namespace] = append(ownerEgress[selected.Namespace], networkpolicy.Target{Host: target.LLM.Host, Port: target.LLM.Port})
		backend := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: selected.Namespace, Name: name},
			Spec: agw.AgentgatewayBackendSpec{AI: &agw.AIBackend{LLM: &target.LLM}, Policies: &agw.BackendFull{
				BackendSimple: target.Policies.BackendSimple, AI: target.Policies.AI, Transformation: target.Policies.Transformation,
				ExtAuth: s.delegatedExtAuth(grant, selected.Id, provider, true),
			}},
		}
		route := s.delegationRoute(selected.Namespace, inference.GatewayName, name, fmt.Sprintf("/delegations/%s/models/%d", grant.ID, index), false)
		objects = append(objects, backend, route)
		ownerNamespaces[selected.Namespace] = true
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
			if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}, connection); err != nil {
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
			aggregationEgress = append(aggregationEgress, networkpolicy.ServiceEgress(selected.Namespace, mcp.GatewayName, 8443)...)
			transport := &agw.BackendSimple{}
			if target.Secure {
				transport.TLS = &agw.BackendTLS{Sni: &target.Host}
			}
			if !target.Secure || connection.Spec.Endpoint.InsecureSkipVerify {
				return errors.New("delegation requires verified upstream TLS")
			}
			if connection.Spec.Endpoint.Timeout != nil {
				transport.HTTP = &agw.BackendHTTP{RequestTimeout: connection.Spec.Endpoint.Timeout}
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
					TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{LocalPolicyTargetReference: agw.LocalPolicyTargetReference{Group: "agentgateway.dev", Kind: "AgentgatewayBackend", Name: gwv1.ObjectName(innerName)}, SectionName: &section}},
					Backend:    &agw.BackendFull{ExtAuth: s.delegatedExtAuth(grant, selected.Id, connection, false)},
				},
			}
			admission := s.delegatedExtAuth(grant, selected.Id, connection, false)
			admission.GRPC.ContextExtensions["agentz.operation"] = "mcp-admission"
			objects = append(objects, &agw.AgentgatewayPolicy{
				TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayPolicy"},
				ObjectMeta: metav1.ObjectMeta{Name: innerName + "-admission", Namespace: selected.Namespace},
				Spec: agw.AgentgatewayPolicySpec{
					TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{LocalPolicyTargetReference: agw.LocalPolicyTargetReference{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Name: gwv1.ObjectName(innerName)}}},
					Traffic:    &agw.Traffic{ExtAuth: &agw.ExtAuthOrConditional{ExtAuth: *admission}},
				},
			})

			path := "/delegations/" + grant.ID + "/mcp/" + selected.Id
			objects = append(objects, inner, policy, s.delegationRoute(selected.Namespace, mcp.GatewayName, innerName, path, true))
			host := mcp.GatewayName + "." + selected.Namespace + ".svc.cluster.local"
			outer.Spec.MCP.Targets = append(outer.Spec.MCP.Targets, agw.McpTargetSelector{Name: section, Static: &agw.McpTarget{
				Host: &host, Port: 8443, Path: &path, Protocol: new(agw.MCPProtocolStreamableHTTP),
				Policies: &agw.BackendSimple{TLS: &agw.BackendTLS{CACertificateRefs: []corev1.LocalObjectReference{{Name: "delegation-ca"}}}},
			}})
			ownerNamespaces[selected.Namespace] = true
		}
		objects = append(objects, &ciliumv2.CiliumNetworkPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
			ObjectMeta: metav1.ObjectMeta{Name: "d-" + grant.ID, Namespace: s.cfg.DelegationNamespace},
			Spec:       &ciliumapi.Rule{EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", "delegations", ciliumlabels.LabelSourceK8s)), Egress: aggregationEgress},
		})
		objects = append(objects, &agw.AgentgatewayPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayPolicy"},
			ObjectMeta: metav1.ObjectMeta{Name: name + "-admission", Namespace: s.cfg.DelegationNamespace},
			Spec: agw.AgentgatewayPolicySpec{
				TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{LocalPolicyTargetReference: agw.LocalPolicyTargetReference{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Name: gwv1.ObjectName(name)}}},
				Traffic: &agw.Traffic{ExtAuth: &agw.ExtAuthOrConditional{ExtAuth: agw.ExtAuth{
					BackendRef:  &gwv1.BackendObjectReference{Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")), Name: "delegation-authority"},
					FailureMode: agw.FailClosed, GRPC: &agw.AgentExtAuthGRPC{ContextExtensions: map[string]string{
						"agentz.operation": "aggregation", "agentz.grant": grant.ID, "agentz.client": grant.ClientID, "agentz.user": grant.UserID,
					}},
				}}},
			},
		})

		objects = append(objects, outer, s.delegationRoute(s.cfg.DelegationNamespace, "delegations", name, "/delegations/"+grant.ID+"/mcp", true))
	}
	publicIdentity := strings.Split(s.cfg.DelegationPublicPeer, ".")
	if len(publicEgress) > 0 {
		objects = append(objects, &ciliumv2.CiliumNetworkPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
			ObjectMeta: metav1.ObjectMeta{Name: "d-" + grant.ID + "-public", Namespace: publicIdentity[1]},
			Spec: &ciliumapi.Rule{
				EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("io.cilium.k8s.policy.serviceaccount", publicIdentity[0], ciliumlabels.LabelSourceK8s)),
				Egress:           publicEgress,
			},
		})
	}

	for namespace := range ownerNamespaces {
		policy := &ciliumv2.CiliumNetworkPolicy{
			TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
			ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: "d-" + grant.ID},
			Spec: &ciliumapi.Rule{
				EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", inference.GatewayName, ciliumlabels.LabelSourceK8s)),
				Ingress: []ciliumapi.IngressRule{{IngressCommonRule: ciliumapi.IngressCommonRule{FromEndpoints: []ciliumapi.EndpointSelector{
					ciliumapi.NewESFromLabels(
						ciliumlabels.NewLabel("io.cilium.k8s.policy.serviceaccount", publicIdentity[0], ciliumlabels.LabelSourceK8s),
						ciliumlabels.NewLabel("io.kubernetes.pod.namespace", publicIdentity[1], ciliumlabels.LabelSourceK8s),
					),
					ciliumapi.NewESFromLabels(
						ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", "delegations", ciliumlabels.LabelSourceK8s),
						ciliumlabels.NewLabel("io.kubernetes.pod.namespace", s.cfg.DelegationNamespace, ciliumlabels.LabelSourceK8s),
					),
				}}, ToPorts: []ciliumapi.PortRule{{Ports: []ciliumapi.PortProtocol{{Port: "8443", Protocol: ciliumapi.ProtoTCP}}}}}},
			},
		}
		policy.Spec.Egress = networkpolicy.ExternalEgress(ownerEgress[namespace])
		policy.Spec.Egress = append(policy.Spec.Egress, networkpolicy.ServiceEgress(namespace, mcp.ExtAuthServiceName, 18084)...)
		policy.Spec.Egress = append(policy.Spec.Egress, networkpolicy.ServiceEgress("agentgateway-system", "agentgateway", 9978)...)
		mcpPolicy := policy.DeepCopy()
		mcpPolicy.Name += "-mcp"
		mcpPolicy.Spec.EndpointSelector = ciliumapi.NewESFromLabels(ciliumlabels.NewLabel("gateway.networking.k8s.io/gateway-name", mcp.GatewayName, ciliumlabels.LabelSourceK8s))
		policy.Spec.Ingress[0].FromEndpoints = policy.Spec.Ingress[0].FromEndpoints[:1]
		mcpPolicy.Spec.Ingress[0].FromEndpoints = mcpPolicy.Spec.Ingress[0].FromEndpoints[1:]
		objects = append(objects, policy, mcpPolicy)
	}
	hash := sha256.Sum256(grant.Selection)
	for _, object := range objects {
		object.SetLabels(map[string]string{authorization.DelegationLabel: grant.ID})
		object.SetAnnotations(map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", hash)})
		data, err := json.Marshal(object)
		if err != nil {
			return err
		}
		if err := s.k8sClient.Patch(ctx, object, ctrlclient.RawPatch(types.ApplyPatchType, data), ctrlclient.FieldOwner("agentz-delegation"), ctrlclient.ForceOwnership); err != nil {
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

func (s *Service) delegatedExtAuth(grant gatewaydb.GatewayGetDelegationGrantRow, target string, owner ctrlclient.Object, inferenceTarget bool) *agw.ExtAuth {
	policy := &agw.ExtAuth{
		BackendRef: &gwv1.BackendObjectReference{
			Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")), Name: "delegation-extauth",
		},
		FailureMode: agw.FailClosed,
		GRPC: &agw.AgentExtAuthGRPC{ContextExtensions: map[string]string{
			"agentz.grant": grant.ID, "agentz.client": grant.ClientID, "agentz.user": grant.UserID,
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
