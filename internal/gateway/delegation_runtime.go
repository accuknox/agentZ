package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	esv1 "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/networkpolicy"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const delegationLabel = "agentz.accuknox.com/delegation"

func (s *Service) delegationReady(ctx context.Context, grant gatewaydb.GatewayGetDelegationGrantRow, name string, mcp bool, connections int) error {
	conditionsReady := func(conditions []metav1.Condition, generation int64, names ...string) bool {
		for _, name := range names {
			condition := meta.FindStatusCondition(conditions, name)
			if condition == nil || condition.Status != metav1.ConditionTrue || condition.ObservedGeneration != generation {
				return false
			}
		}
		return true
	}
	key := ctrlclient.ObjectKey{Namespace: s.cfg.DelegationNamespace, Name: name}
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
		if parent.ParentRef.Name != "delegations" || parent.ControllerName != "agentgateway.dev/agentgateway" {
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
	if !mcp {
		return nil
	}
	for index := range connections {
		policy := &agw.AgentgatewayPolicy{}
		key.Name = fmt.Sprintf("d-%s-mcp-%d-auth", grant.ID, index)
		if err := s.k8sClient.Get(ctx, key, policy); err != nil {
			return err
		}
		if policy.Annotations["agentz.accuknox.com/selection"] != selection {
			return errors.New("credential policy selection is not current")
		}
		ready = false
		for _, ancestor := range policy.Status.Ancestors {
			if ancestor.AncestorRef.Name != "delegations" || ancestor.ControllerName != "agentgateway.dev/agentgateway" {
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
	grants, err := s.queries.GatewayListDelegationGrants(ctx)
	if err != nil {
		return err
	}
	active := make(map[string]bool, len(grants))
	for _, row := range grants {
		claims := delegationClaims{ClientID: row.ClientID, GrantID: row.ID, Scope: strings.Join(row.Scopes, " ")}
		claims.Subject = row.UserID
		grant, selection, err := s.checkDelegation(ctx, claims)
		if err != nil {
			continue // Live authorization also denies these grants at admission.
		}
		active[row.ID] = true
		if err := s.projectDelegation(ctx, grant, selection); err != nil {
			slog.ErrorContext(ctx, "project delegation", slog.String("grant", row.ID), slog.Any("error", err))
		}
	}
	// Reconciliation owns only its labeled objects in the private namespace.
	lists := []ctrlclient.ObjectList{
		&gwv1.HTTPRouteList{}, &agw.AgentgatewayBackendList{},
		&agw.AgentgatewayPolicyList{}, &esv1.ExternalSecretList{}, &ciliumv2.CiliumNetworkPolicyList{},
	}
	for _, list := range lists {
		err := s.k8sClient.List(
			ctx, list, ctrlclient.InNamespace(s.cfg.DelegationNamespace),
			ctrlclient.HasLabels{delegationLabel},
		)
		if err != nil {
			return err
		}
		objects, err := meta.ExtractList(list)
		if err != nil {
			return err
		}
		for _, item := range objects {
			object := item.(ctrlclient.Object)
			if active[object.GetLabels()[delegationLabel]] {
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
	namespace := s.cfg.DelegationNamespace
	objects := make([]ctrlclient.Object, 0)
	egressTargets := make([]networkpolicy.Target, 0)
	for index, selected := range selection.Models {
		provider := &agentzv1alpha1.InferenceProvider{}
		err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Provider}, provider)
		if err != nil {
			return err
		}
		if string(provider.UID) != selected.Uid {
			return errors.New("provider was replaced")
		}
		// Native secret templates keep credential values out of the Go proxy.
		runtime, err := inference.RenderRuntime(provider, s.cfg.DelegationSecretStore, time.Minute)
		if err != nil {
			return err
		}
		name := fmt.Sprintf("d-%s-model-%d", grant.ID, index)
		credentialName := fmt.Sprintf("d-%s-credentials-%d", grant.ID, index)
		projected := provider.DeepCopy()
		projected.Namespace, projected.Name = namespace, credentialName
		target, err := inference.RenderProviderTarget(projected, selected.Model)
		if err != nil {
			return err
		}
		egressTargets = append(egressTargets, networkpolicy.Target{Host: target.LLM.Host, Port: target.LLM.Port})
		for _, host := range target.AdditionalHosts {
			egressTargets = append(egressTargets, networkpolicy.Target{Host: host, Port: 443})
		}
		if runtime.ExternalSecret != nil {
			secret := runtime.ExternalSecret
			secret.Namespace, secret.Name = namespace, credentialName
			secret.Spec.Target.Name = credentialName
			objects = append(objects, secret)
		}
		backend := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
			Spec: agw.AgentgatewayBackendSpec{
				AI: &agw.AIBackend{LLM: &target.LLM},
				Policies: &agw.BackendFull{
					BackendSimple: target.Policies.BackendSimple, AI: target.Policies.AI,
					Transformation: target.Policies.Transformation,
					ExtAuth:        s.delegatedExtAuth(grant, selected.Id),
				},
			},
		}
		objects = append(objects, backend)
		prefix := fmt.Sprintf("/delegations/%s/models/%d", grant.ID, index)
		objects = append(objects, s.delegationRoute(name, prefix, false))
	}
	if len(selection.Mcp) != 0 {
		name := "d-" + grant.ID + "-mcp"
		backend := &agw.AgentgatewayBackend{
			TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayBackend"},
			ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
			Spec: agw.AgentgatewayBackendSpec{
				MCP: &agw.MCPBackend{PrefixMode: agw.PrefixAlways, SessionRouting: agw.Stateful, FailureMode: agw.FailClosed},
				Policies: &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: &agw.Authorization{
					Action: agw.AuthorizationPolicyActionAllow,
				}}},
			},
		}
		for index, selected := range selection.Mcp {
			connection := &agentzv1alpha1.MCPConnection{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}, connection)
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
			egressTargets = append(egressTargets, networkpolicy.Target{Host: target.Host, Port: target.Port})
			policies := &agw.BackendSimple{}
			if target.Secure {
				policies.TLS = &agw.BackendTLS{Sni: &target.Host}
				if connection.Spec.Endpoint.InsecureSkipVerify {
					mode := agw.InsecureTLSModeAll
					policies.TLS.InsecureSkipVerify = &mode
				}
			}
			if connection.Spec.Endpoint.Timeout != nil {
				policies.HTTP = &agw.BackendHTTP{RequestTimeout: connection.Spec.Endpoint.Timeout}
			}
			section := gwv1.SectionName(selected.Id)
			backend.Spec.MCP.Targets = append(backend.Spec.MCP.Targets, agw.McpTargetSelector{
				Name: section, Static: &agw.McpTarget{
					Host: &target.Host, Port: target.Port, Path: target.Path,
					Protocol: target.Protocol, Policies: policies,
				},
			})
			policy := &agw.AgentgatewayPolicy{
				TypeMeta:   metav1.TypeMeta{APIVersion: agw.GroupVersion.String(), Kind: "AgentgatewayPolicy"},
				ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: fmt.Sprintf("d-%s-mcp-%d-auth", grant.ID, index)},
				Spec: agw.AgentgatewayPolicySpec{
					TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{
						LocalPolicyTargetReference: agw.LocalPolicyTargetReference{
							Group: "agentgateway.dev", Kind: "AgentgatewayBackend", Name: gwv1.ObjectName(name),
						},
						SectionName: &section,
					}},
					Backend: &agw.BackendFull{ExtAuth: s.delegatedExtAuth(grant, selected.Id)},
				},
			}
			objects = append(objects, policy)
			expressions, err := delegationMCPExpressions(selected)
			if err != nil {
				return err
			}
			backend.Spec.Policies.MCP.Authorization.Policy.MatchExpressions = append(
				backend.Spec.Policies.MCP.Authorization.Policy.MatchExpressions, expressions...,
			)
		}
		objects = append(objects, backend, s.delegationRoute(name, "/delegations/"+grant.ID+"/mcp", true))
	}
	objects = append(objects, &ciliumv2.CiliumNetworkPolicy{
		TypeMeta:   metav1.TypeMeta{APIVersion: "cilium.io/v2", Kind: "CiliumNetworkPolicy"},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: "d-" + grant.ID},
		Spec: &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel(
				"gateway.networking.k8s.io/gateway-name", "delegations", ciliumlabels.LabelSourceK8s,
			)),
			Egress: networkpolicy.ExternalEgress(egressTargets),
		},
	})
	for _, object := range objects {
		labels := object.GetLabels()
		if labels == nil {
			labels = make(map[string]string)
		}
		labels[delegationLabel] = grant.ID
		object.SetLabels(labels)
		// Grant selections never mutate. Readiness must refer to this exact
		// database snapshot rather than a route left from an older projection.
		hash := sha256.Sum256(grant.Selection)
		object.SetAnnotations(map[string]string{"agentz.accuknox.com/selection": fmt.Sprintf("%x", hash)})
		data, err := json.Marshal(object)
		if err != nil {
			return err
		}
		err = s.k8sClient.Patch(
			ctx, object, ctrlclient.RawPatch(types.ApplyPatchType, data),
			ctrlclient.FieldOwner("agentz-delegation"), ctrlclient.ForceOwnership,
		)
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

func (s *Service) delegatedExtAuth(grant gatewaydb.GatewayGetDelegationGrantRow, target string) *agw.ExtAuth {
	return &agw.ExtAuth{
		BackendRef: &gwv1.BackendObjectReference{
			Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")),
			Name: gwv1.ObjectName(s.cfg.DelegationCredentialService),
		},
		FailureMode: agw.FailClosed,
		GRPC: &agw.AgentExtAuthGRPC{ContextExtensions: map[string]string{
			"agentz.grant": grant.ID, "agentz.client": grant.ClientID,
			"agentz.user": grant.UserID, "agentz.target": target,
		}},
	}
}

func (s *Service) delegationRoute(name, path string, mcp bool) *gwv1.HTTPRoute {
	matchType := gwv1.PathMatchPathPrefix
	filters := []gwv1.HTTPRouteFilter{}
	if mcp {
		matchType = gwv1.PathMatchExact
	} else {
		filters = append(filters, gwv1.HTTPRouteFilter{
			Type: gwv1.HTTPRouteFilterURLRewrite,
			URLRewrite: &gwv1.HTTPURLRewriteFilter{Path: &gwv1.HTTPPathModifier{
				Type: gwv1.PrefixMatchHTTPPathModifier, ReplacePrefixMatch: new("/v1"),
			}},
		})
	}
	return &gwv1.HTTPRoute{
		TypeMeta:   metav1.TypeMeta{APIVersion: gwv1.GroupVersion.String(), Kind: "HTTPRoute"},
		ObjectMeta: metav1.ObjectMeta{Namespace: s.cfg.DelegationNamespace, Name: name},
		Spec: gwv1.HTTPRouteSpec{
			CommonRouteSpec: gwv1.CommonRouteSpec{ParentRefs: []gwv1.ParentReference{{Name: "delegations"}}},
			Rules: []gwv1.HTTPRouteRule{{
				Matches: []gwv1.HTTPRouteMatch{{Path: &gwv1.HTTPPathMatch{Type: &matchType, Value: &path}}},
				Filters: filters,
				BackendRefs: []gwv1.HTTPBackendRef{{BackendRef: gwv1.BackendRef{BackendObjectReference: gwv1.BackendObjectReference{
					Group: new(gwv1.Group("agentgateway.dev")), Kind: new(gwv1.Kind("AgentgatewayBackend")), Name: gwv1.ObjectName(name),
				}}}},
			}},
		},
	}
}

// Check resolves credentials for a controller-owned delegated target. The
// private listener is reachable only by the delegated Agentgateway runtime.
func (s *Service) Check(ctx context.Context, request *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	extensions := request.GetAttributes().GetContextExtensions()
	claims := delegationClaims{ClientID: extensions["agentz.client"], GrantID: extensions["agentz.grant"]}
	claims.Subject = extensions["agentz.user"]
	_, selection, err := s.checkDelegation(ctx, claims)
	var credentials *authv3.OkHttpResponse
	if err == nil {
		target := extensions["agentz.target"]
		modelIndex := slices.IndexFunc(selection.Models, func(model gatewayapi.DelegationModel) bool {
			return model.Id == target
		})
		connectionIndex := slices.IndexFunc(selection.Mcp, func(connection gatewayapi.DelegationMCP) bool {
			return connection.Id == target
		})
		if modelIndex >= 0 {
			model := selection.Models[modelIndex]
			provider := &agentzv1alpha1.InferenceProvider{}
			err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: model.Namespace, Name: model.Provider}, provider)
			if err == nil && string(provider.UID) != model.Uid {
				err = errors.New("provider identity changed")
			}
			if err == nil {
				credentials, err = s.delegationCredentials.InferenceCredentials(ctx, provider)
			}
		} else if connectionIndex >= 0 {
			selected := selection.Mcp[connectionIndex]
			connection := &agentzv1alpha1.MCPConnection{}
			err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: selected.Namespace, Name: selected.Connection}, connection)
			if err == nil && string(connection.UID) != selected.Uid {
				err = errors.New("MCP connection identity changed")
			}
			if err == nil {
				credentials, err = s.delegationCredentials.MCPCredentials(ctx, connection)
			}
		} else {
			err = errors.New("target is not delegated")
		}
	}
	if err != nil {
		slog.WarnContext(ctx, "delegated credential request denied",
			slog.String("grant", claims.GrantID),
			slog.String("target", extensions["agentz.target"]), slog.Any("error", err),
		)
		return &authv3.CheckResponse{
			Status: &statuspb.Status{Code: int32(codes.PermissionDenied)},
			HttpResponse: &authv3.CheckResponse_DeniedResponse{
				DeniedResponse: &authv3.DeniedHttpResponse{Status: &typev3.HttpStatus{Code: typev3.StatusCode_Forbidden}},
			},
		}, nil
	}
	return &authv3.CheckResponse{
		Status:       &statuspb.Status{Code: int32(codes.OK)},
		HttpResponse: &authv3.CheckResponse_OkResponse{OkResponse: credentials},
	}, nil
}
