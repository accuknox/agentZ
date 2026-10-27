package mcpconn

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	sandboxcontroller "github.com/accuknox/agentz/internal/controller/sandbox"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
)

const delegationParametersAnnotation = "agentz.accuknox.com/delegation-parameters"

type delegationParameters struct {
	Batch *corev1.EnvVar `json:"batch"`
}

func (r *ExtAuthRuntimeReconciler) reconcileDelegationRuntime(ctx context.Context, namespace *corev1.Namespace) error {
	ns := namespace.Name
	ownerRefs := []metav1.OwnerReference{
		*metav1.NewControllerRef(namespace, corev1.SchemeGroupVersion.WithKind("Namespace")),
	}
	routes := &gwv1.HTTPRouteList{}
	err := r.List(ctx, routes, client.InNamespace(ns))
	if err != nil {
		return err
	}
	delegated := slices.ContainsFunc(routes.Items, func(route gwv1.HTTPRoute) bool {
		_, delegated := route.Labels[authorization.DelegationLabel]
		return delegated
	})
	backend := &agw.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "delegation-extauth",
			Namespace: ns,
		},
	}
	if delegated {
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, backend, func() error {
			backend.OwnerReferences = ownerRefs
			backend.Spec = agw.AgentgatewayBackendSpec{
				Static: &agw.StaticBackend{Host: "extauth." + ns + ".svc.cluster.local", Port: 18084},
			}
			return nil
		})
	}
	if !delegated {
		err = client.IgnoreNotFound(r.Delete(ctx, backend))
	}
	if err != nil {
		return err
	}
	gateways := []*gwv1.Gateway{inference.Gateway(ns), mcp.Gateway(ns)}
	for _, desired := range gateways {
		var needed, consumed bool
		for _, route := range routes.Items {
			attached := slices.ContainsFunc(route.Spec.ParentRefs, func(parent gwv1.ParentReference) bool {
				return parent.Name == gwv1.ObjectName(desired.Name)
			})
			if !attached {
				continue
			}
			consumed = true
			_, delegated := route.Labels[authorization.DelegationLabel]
			if delegated {
				needed = true
				break
			}
		}
		err := r.reconcileDelegationTracing(ctx, ns, desired.Name, needed, ownerRefs)
		if err != nil {
			return err
		}
		gateway := &gwv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: desired.Name, Namespace: ns}}
		err = r.Get(ctx, client.ObjectKeyFromObject(gateway), gateway)
		missing := apierrors.IsNotFound(err)
		if err != nil && !missing {
			return err
		}
		if !needed {
			if !consumed {
				if err := client.IgnoreNotFound(r.Delete(ctx, gateway)); err != nil {
					return err
				}
				parameters := &agw.AgentgatewayParameters{
					ObjectMeta: metav1.ObjectMeta{
						Name:      desired.Spec.Infrastructure.ParametersRef.Name,
						Namespace: ns,
					},
				}
				if err := client.IgnoreNotFound(r.Delete(ctx, parameters)); err != nil {
					return err
				}
				continue
			}
			if missing {
				continue
			}
			parameters := &agw.AgentgatewayParameters{}
			key := client.ObjectKey{
				Namespace: ns,
				Name:      desired.Spec.Infrastructure.ParametersRef.Name,
			}
			err := r.Get(ctx, key, parameters)
			if err != nil && !apierrors.IsNotFound(err) {
				return err
			}
			if err == nil {
				patch := client.MergeFrom(parameters.DeepCopy())
				if saved := parameters.Annotations[delegationParametersAnnotation]; saved != "" {
					var original delegationParameters
					if err := json.Unmarshal([]byte(saved), &original); err != nil {
						return err
					}
					index := slices.IndexFunc(parameters.Spec.Env, func(variable corev1.EnvVar) bool {
						return variable.Name == "OTEL_BSP_MAX_EXPORT_BATCH_SIZE" && variable.Value == "1"
					})
					if index >= 0 {
						parameters.Spec.Env = slices.Delete(parameters.Spec.Env, index, index+1)
						if original.Batch != nil {
							parameters.Spec.Env = append(parameters.Spec.Env, *original.Batch)
						}
					}
					delete(parameters.Annotations, delegationParametersAnnotation)
				}
				if err := r.Patch(ctx, parameters, patch); err != nil {
					return err
				}
			}
			patch := client.MergeFrom(gateway.DeepCopy())
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool {
				return listener.Name == "delegation"
			})
			if err := r.Patch(ctx, gateway, patch); err != nil {
				return err
			}
			continue
		}
		parameters := &agw.AgentgatewayParameters{
			ObjectMeta: metav1.ObjectMeta{
				Name:      desired.Spec.Infrastructure.ParametersRef.Name,
				Namespace: ns,
			},
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, parameters, func() error {
			parameters.OwnerReferences = ownerRefs
			var original delegationParameters
			switch saved := parameters.Annotations[delegationParametersAnnotation]; saved {
			case "":
				index := slices.IndexFunc(parameters.Spec.Env, func(variable corev1.EnvVar) bool {
					return variable.Name == "OTEL_BSP_MAX_EXPORT_BATCH_SIZE"
				})
				if index >= 0 {
					original.Batch = parameters.Spec.Env[index].DeepCopy()
				}
			default:
				if err := json.Unmarshal([]byte(saved), &original); err != nil {
					return err
				}
			}
			encoded, err := json.Marshal(original)
			if err != nil {
				return err
			}
			if parameters.Annotations == nil {
				parameters.Annotations = map[string]string{}
			}
			parameters.Annotations[delegationParametersAnnotation] = string(encoded)
			if parameters.CreationTimestamp.IsZero() {
				parameters.Spec.Service = &agw.KubernetesResourceOverlay{
					Spec: &apiextensionsv1.JSON{
						Raw: []byte(`{"type":"ClusterIP"}`),
					},
				}
			}
			parameters.Spec.Env = slices.DeleteFunc(parameters.Spec.Env, func(variable corev1.EnvVar) bool {
				return variable.Name == "OTEL_BSP_MAX_EXPORT_BATCH_SIZE"
			})
			parameters.Spec.Env = append(parameters.Spec.Env, corev1.EnvVar{Name: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", Value: "1"})
			return nil
		})
		if err != nil {
			return err
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, gateway, func() error {
			if gateway.CreationTimestamp.IsZero() {
				gateway.Spec = desired.Spec
			}
			gateway.OwnerReferences = ownerRefs
			gateway.Spec.Listeners = slices.DeleteFunc(gateway.Spec.Listeners, func(listener gwv1.Listener) bool {
				return listener.Name == "delegation"
			})
			gateway.Spec.Listeners = append(gateway.Spec.Listeners, gwv1.Listener{
				Name:     "delegation",
				Port:     8080,
				Protocol: gwv1.HTTPProtocolType,
			})
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileDelegationTracing(ctx context.Context, namespace, gateway string, needed bool, owners []metav1.OwnerReference) error {
	name := gateway + "-delegation-tracing"
	policy := &agw.AgentgatewayPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
	}
	backend := &agw.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name + "-backend"},
	}
	network := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
	}
	if !needed {
		for _, object := range []client.Object{policy, backend, network} {
			if err := client.IgnoreNotFound(r.Delete(ctx, object)); err != nil {
				return err
			}
		}
		return nil
	}
	if err := r.TraceBackend.Validate(); err != nil {
		return err
	}
	if r.TraceBackend.Mode == sandboxcontroller.TraceBackendModeStatic {
		_, err := ctrlutil.CreateOrPatch(ctx, r.Client, backend, func() error {
			backend.OwnerReferences = owners
			backend.Spec = agw.AgentgatewayBackendSpec{
				Static: &agw.StaticBackend{
					Host: r.TraceBackend.Host,
					Port: r.TraceBackend.Port,
				},
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if r.TraceBackend.Mode == sandboxcontroller.TraceBackendModeService {
		if err := client.IgnoreNotFound(r.Delete(ctx, backend)); err != nil {
			return err
		}
	}
	attrs := []agw.AttributeAdd{}
	fields := []string{
		"client_id", "app_name", "grant_id", "user_id", "organization_id", "workspace_id",
		"resource_kind", "resource_namespace", "resource_name", "resource_uid", "target_id", "tenant_namespace",
	}
	for _, field := range fields {
		attrs = append(attrs, agw.AttributeAdd{
			Name:       "agentz." + field,
			Expression: agw.CELExpression("metadata.agentz_observability." + field),
		})
	}
	// Registration controls which native metadata is accepted as conversation identity.
	attrs = append(attrs, agw.AttributeAdd{
		Name:       "agentz.agent_kind",
		Expression: `default(metadata.agentz_observability.agent_kind, "")`,
	})
	if gateway == inference.GatewayName {
		attrs = append(attrs,
			agw.AttributeAdd{Name: "agentz.guardrails", Expression: "toJson(guardrails)"},
			agw.AttributeAdd{
				Name: "agentz.guardrail_request",
				Expression: `guardrails.exists(g, g.phase == "request")
  && size(request.body) <= 1048576 ? string(request.body) : ""`,
			},
			agw.AttributeAdd{
				Name:       "agentz.guardrail_revision",
				Expression: `default(metadata.agentz_guardrail_revision, "")`,
			},
			agw.AttributeAdd{
				Name: "session.id",
				Expression: `default(metadata.agentz_observability.agent_kind, "") == "codex"
  ? default(request.headers["thread-id"], "")
  : (default(metadata.agentz_observability.agent_kind, "") == "claude"
      ? default(request.headers["x-claude-code-session-id"], "")
      : "")`,
			},
			agw.AttributeAdd{
				Name: "agentz.turn_id",
				Expression: `default(metadata.agentz_observability.agent_kind, "") == "codex"
  ? default(json(request.headers["x-codex-turn-metadata"]).turn_id, "")
  : (default(metadata.agentz_observability.agent_kind, "") == "claude"
      ? default(request.headers["x-claude-code-prompt-id"], "")
      : "")`,
			},
			agw.AttributeAdd{Name: "llm.input_messages", Expression: "string(request.body)"},
			agw.AttributeAdd{
				Name:       "gen_ai.request.model",
				Expression: "default(llm.requestModel, json(request.body).model)",
			},
			agw.AttributeAdd{
				Name: "llm.output_messages",
				Expression: `toJson({
  "completion": default(llm.completion, []),
  "tool_calls": default(llm.toolCalls, [])
})`,
			},
		)
	}
	if gateway == mcp.GatewayName {
		attrs = append(attrs,
			agw.AttributeAdd{
				Name: "session.id",
				Expression: `default(metadata.agentz_observability.agent_kind, "") == "codex"
  ? default(
      json(request.body).params._meta["x-codex-turn-metadata"].thread_id,
      ""
    )
  : ""`,
			},
			agw.AttributeAdd{
				Name: "agentz.turn_id",
				Expression: `default(metadata.agentz_observability.agent_kind, "") == "codex"
  ? default(
      json(request.body).params._meta["x-codex-turn-metadata"].turn_id,
      ""
    )
  : ""`,
			},
			agw.AttributeAdd{
				Name: "gen_ai.tool.call.id",
				Expression: `default(metadata.agentz_observability.agent_kind, "") == "claude"
  ? default(json(request.body).params._meta["claudecode/toolUseId"], "")
  : (default(metadata.agentz_observability.agent_kind, "") == "codex"
      ? default(json(request.body).params._meta.callId, "")
      : "")`,
			},
			agw.AttributeAdd{
				Name:       "tool.parameters",
				Expression: "toJson(default(mcp.tool.arguments, json(request.body).params.arguments))",
			},
			agw.AttributeAdd{Name: "output.value", Expression: "toJson(mcp.tool.result)"},
			agw.AttributeAdd{
				Name: "tool.error",
				Expression: `toJson(
  response.code >= 400
    ? default(mcp.tool.error, string(response.body))
    : mcp.tool.error
)`,
			},
			agw.AttributeAdd{Name: "mcp.request.id", Expression: "json(request.body).id"},
			agw.AttributeAdd{
				Name:       "mcp.method.name",
				Expression: "default(mcp.methodName, json(request.body).method)",
			},
			agw.AttributeAdd{
				Name:       "gen_ai.tool.name",
				Expression: "default(mcp.tool.name, json(request.body).params.name)",
			},
		)
	}
	sample := agw.CELExpression("true")
	filter := agw.CELExpression(`metadata.agentz_observability.resource_kind == "inference" || (
  metadata.agentz_observability.resource_kind == "mcp" &&
  default(mcp.methodName, json(request.body).method) == "tools/call"
)`)
	bufferSize := resource.MustParse("32Mi")
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, policy, func() error {
		policy.OwnerReferences = owners
		policy.Spec = agw.AgentgatewayPolicySpec{
			TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{
				LocalPolicyTargetReference: agw.LocalPolicyTargetReference{
					Group: "gateway.networking.k8s.io",
					Kind:  "Gateway",
					Name:  gwv1.ObjectName(gateway),
				},
				Port: new(int32(8080)),
			}},
			Frontend: &agw.Frontend{
				HTTP: &agw.FrontendHTTP{
					MaxBufferSize: &agw.ByteSize{Value: &bufferSize},
				},
				Tracing: &agw.Tracing{
					PolicyBackendEndpoint: agw.PolicyBackendEndpoint{
						BackendRef: r.TraceBackend.BackendRef(backend.Name),
					},
					Protocol:         agw.OTLPProtocolGrpc,
					RandomSampling:   &sample,
					ClientSampling:   &sample,
					ParentNotSampled: &sample,
					Filter:           &filter,
					Attributes:       &agw.LogTracingAttributes{Add: attrs},
					Resources: []agw.ResourceAdd{
						{Name: "service.name", Expression: `"agentz-oauth-gateway"`},
						{
							Name:       "service.namespace",
							Expression: agw.CELExpression(strconv.Quote(namespace)),
						},
					},
				},
			},
		}
		return nil
	})
	if err != nil {
		return err
	}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, network, func() error {
		network.OwnerReferences = owners
		network.Spec = &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(ciliumlabels.NewLabel(
				"gateway.networking.k8s.io/gateway-name", gateway, ciliumlabels.LabelSourceK8s,
			)),
			Egress: r.TraceBackend.Egress(),
		}
		return nil
	})
	return err
}
