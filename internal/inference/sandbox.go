package inference

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const (
	// GatewayName is the namespace-local inference Gateway and Service name.
	GatewayName = "inference"
	// ParametersName configures only the inference Gateway deployment.
	ParametersName = "inference-clusterip"
	// SandboxLabel identifies the Sandbox that owns an inference route.
	SandboxLabel = "agentz.accuknox.com/inference-sandbox"
	// SandboxHeader carries controller-owned route identity to extAuth.
	SandboxHeader = "x-agentz-inference-sandbox"
	// SandboxNamespaceHeader binds the route to its source Workspace.
	SandboxNamespaceHeader = "x-agentz-inference-sandbox-namespace"
)

// Gateway returns the isolated namespace-local inference Gateway.
func Gateway(namespace string) *gwv1.Gateway {
	return &gwv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: GatewayName, Namespace: namespace},
		Spec: gwv1.GatewaySpec{
			GatewayClassName: gwv1.ObjectName("agentgateway"),
			Infrastructure: &gwv1.GatewayInfrastructure{
				ParametersRef: &gwv1.LocalParametersReference{
					Group: gwv1.Group("agentgateway.dev"),
					Kind:  gwv1.Kind("AgentgatewayParameters"),
					Name:  ParametersName,
				},
			},
			Listeners: []gwv1.Listener{{
				Name: gwv1.SectionName("inference-http"), Protocol: gwv1.HTTPProtocolType,
				Port: gwv1.PortNumber(80),
			}},
		},
	}
}

// SandboxTarget describes one logical inference target exposed by a Sandbox.
type SandboxTarget struct {
	Name             string
	Backend          string
	BackendNamespace string
	Path             string
	Models           []string
	Labels           map[string]string
	ExtAuth          bool
	Retries          int
}

// SandboxTargetRuntime contains the fail-closed route and authorization policy
// for one Sandbox inference target.
type SandboxTargetRuntime struct {
	Route  *gwv1.HTTPRoute
	Policy *agentgatewayv1alpha1.AgentgatewayPolicy
}

// SandboxProviderRuntimeName returns the bounded stable identity shared by a
// route and its authorization policy.
func SandboxProviderRuntimeName(sandboxName, providerName string) string {
	name := sandboxName + "-" + providerName
	if len(name) <= 63 {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	suffix := hex.EncodeToString(sum[:])[:10]
	return name[:52] + "-" + suffix
}

// SandboxProviderPath returns the controller-owned OpenAI-compatible prefix
// for one Sandbox/provider pair.
func SandboxProviderPath(sandboxName, providerName string) string {
	return "/sandboxes/" + sandboxName + "/providers/" + providerName
}

// SandboxPoolPath returns the controller-owned prefix for one Sandbox/Pool pair.
func SandboxPoolPath(sandboxName, poolName string) string {
	return "/sandboxes/" + sandboxName + "/pools/" + poolName
}

// RenderSandboxTarget creates a route and fail-closed logical model policy.
func RenderSandboxTarget(namespace, sandboxName string, target SandboxTarget) SandboxTargetRuntime {
	name := SandboxProviderRuntimeName(sandboxName, target.Name)
	pathType := gwv1.PathMatchPathPrefix
	group := gwv1.Group("agentgateway.dev")
	kind := gwv1.Kind("AgentgatewayBackend")
	labels := map[string]string{
		SandboxLabel: sandboxName,
	}
	maps.Copy(labels, target.Labels)
	route := &gwv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels},
		Spec: gwv1.HTTPRouteSpec{
			CommonRouteSpec: gwv1.CommonRouteSpec{
				ParentRefs: []gwv1.ParentReference{{Name: gwv1.ObjectName(GatewayName)}},
			},
			Rules: []gwv1.HTTPRouteRule{{
				Matches: []gwv1.HTTPRouteMatch{{
					Path: &gwv1.HTTPPathMatch{Type: &pathType, Value: &target.Path},
				}},
				BackendRefs: []gwv1.HTTPBackendRef{{
					BackendRef: gwv1.BackendRef{
						BackendObjectReference: gwv1.BackendObjectReference{
							Group: &group, Kind: &kind, Name: gwv1.ObjectName(target.Backend),
						},
					},
				}},
			}},
		},
	}
	if target.BackendNamespace != "" && target.BackendNamespace != namespace {
		backendNamespace := gwv1.Namespace(target.BackendNamespace)
		route.Spec.Rules[0].BackendRefs[0].Namespace = &backendNamespace
	}
	if target.ExtAuth {
		route.Spec.Rules[0].Filters = append(
			[]gwv1.HTTPRouteFilter{{
				Type: gwv1.HTTPRouteFilterRequestHeaderModifier,
				RequestHeaderModifier: &gwv1.HTTPHeaderFilter{
					Set: []gwv1.HTTPHeader{
						{
							Name:  gwv1.HTTPHeaderName(SandboxHeader),
							Value: sandboxName,
						},
						{
							Name:  gwv1.HTTPHeaderName(SandboxNamespaceHeader),
							Value: namespace,
						},
					},
				},
			}},
			route.Spec.Rules[0].Filters...,
		)
	}
	quoted := make([]string, 0, len(target.Models))
	for _, model := range target.Models {
		quoted = append(quoted, fmt.Sprintf("%q", model))
	}
	expression := agentgatewayv1alpha1.CELExpression(fmt.Sprintf(
		"default(json(request.body).model, \"\") in [%s]",
		strings.Join(quoted, ", "),
	))
	policy := &agentgatewayv1alpha1.AgentgatewayPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels},
		Spec: agentgatewayv1alpha1.AgentgatewayPolicySpec{
			TargetRefs: []agentgatewayv1alpha1.LocalPolicyTargetReferenceWithSectionName{{
				LocalPolicyTargetReference: agentgatewayv1alpha1.LocalPolicyTargetReference{
					Group: gwv1.Group("gateway.networking.k8s.io"),
					Kind:  gwv1.Kind("HTTPRoute"),
					Name:  gwv1.ObjectName(name),
				},
			}},
			Traffic: &agentgatewayv1alpha1.Traffic{
				Authorization: &agentgatewayv1alpha1.Authorization{
					Action: agentgatewayv1alpha1.AuthorizationPolicyActionRequire,
					Policy: agentgatewayv1alpha1.AuthorizationPolicy{
						MatchExpressions: []agentgatewayv1alpha1.CELExpression{expression},
					},
				},
			},
		},
	}
	if target.Retries > 0 {
		backoff := gwv1.Duration("50ms")
		condition := agentgatewayv1alpha1.CELExpression(
			"response.code == 401 || response.code == 403 || " +
				"response.code == 429 || response.code >= 500",
		)
		policy.Spec.Traffic.Retry = &agentgatewayv1alpha1.Retry{
			HTTPRouteRetry: &gwv1.HTTPRouteRetry{
				Attempts: &target.Retries,
				Backoff:  &backoff,
			},
			Condition: &condition,
		}
	}
	return SandboxTargetRuntime{Route: route, Policy: policy}
}
