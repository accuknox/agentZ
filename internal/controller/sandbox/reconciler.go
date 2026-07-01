/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	agentgatewayshared "github.com/agentgateway/agentgateway/controller/api/v1alpha1/shared"
	agentgatewayclientset "github.com/agentgateway/agentgateway/controller/pkg/client/clientset/versioned"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Reconciler reconciles Sandbox lifecycle protection and MCP runtime.
type Reconciler struct {
	client.Client
	Scheme       *runtime.Scheme
	AgentGateway agentgatewayclientset.Interface
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes/status,verbs=get;patch;update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=mcpconnections,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways;httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaybackends;agentgatewayparameters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch;delete

// Reconcile prevents unsafe deletion and manages namespace MCP runtime.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	sandbox := &agentzv1alpha1.Sandbox{}
	if err := r.Get(ctx, req.NamespacedName, sandbox); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	agentName, err := sandboxutil.ReferencingAgentName(
		ctx,
		r.Client,
		sandbox.Namespace,
		sandbox.Name,
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("find referencing agent: %w", err)
	}

	if !sandbox.DeletionTimestamp.IsZero() {
		if agentName != "" {
			return ctrl.Result{}, fmt.Errorf("sandbox %q is referenced by agent %q", sandbox.Name, agentName)
		}
		if ctrlutil.ContainsFinalizer(sandbox, mcp.SandboxFinalizer) {
			patch := client.MergeFrom(sandbox.DeepCopy())
			ctrlutil.RemoveFinalizer(sandbox, mcp.SandboxFinalizer)
			if err := r.Patch(ctx, sandbox, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}

	if !ctrlutil.ContainsFinalizer(sandbox, mcp.SandboxFinalizer) {
		patch := client.MergeFrom(sandbox.DeepCopy())
		ctrlutil.AddFinalizer(sandbox, mcp.SandboxFinalizer)
		if err := r.Patch(ctx, sandbox, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
	}

	packages := defaultPackages(sandbox.Spec.Packages)
	if !slices.Equal(sandbox.Spec.Packages, packages) {
		patch := client.MergeFrom(sandbox.DeepCopy())
		sandbox.Spec.Packages = packages
		if err := r.Patch(ctx, sandbox, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("default packages: %w", err)
		}
	}

	conns, err := mcp.LoadConnections(ctx, r.Client, sandbox)
	if err != nil {
		return ctrl.Result{}, err
	}
	if len(conns) == 0 {
		if err := r.cleanupSandboxRuntime(ctx, sandbox); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.reconcileGateway(ctx, sandbox.Namespace); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.updateStatus(ctx, sandbox); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if err := r.reconcileGateway(ctx, sandbox.Namespace); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileBackend(ctx, sandbox, conns); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileRoute(ctx, sandbox); err != nil {
		return ctrl.Result{}, err
	}

	if err := r.updateStatus(ctx, sandbox); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// updateStatus computes spec-derived counters and persists them to status.
func (r *Reconciler) updateStatus(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.Sandbox{}
		key := types.NamespacedName{Namespace: sandbox.Namespace, Name: sandbox.Name}
		if err := r.Get(ctx, key, current); err != nil {
			return client.IgnoreNotFound(err)
		}
		status := current.Status.DeepCopy()
		status.PackageCount = len(current.Spec.Packages)
		status.AllowedHostCount = len(current.Spec.AllowedHosts)
		status.MCPRefCount = len(current.Spec.MCPConnectionRefs)
		if reflect.DeepEqual(current.Status, *status) {
			return nil
		}
		patch := client.MergeFrom(current.DeepCopy())
		current.Status = *status
		return r.Status().Patch(ctx, current, patch)
	})
}

// SetupWithManager sets up the Sandbox controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.Sandbox{}).
		Watches(&agentzv1alpha1.Agent{}, handler.EnqueueRequestsFromMapFunc(r.sandboxForAgent)).
		Watches(&agentzv1alpha1.MCPConnection{}, handler.EnqueueRequestsFromMapFunc(r.sandboxesForMCPConnection)).
		Named("sandbox").
		Complete(r)
}

func (r *Reconciler) sandboxForAgent(_ context.Context, obj client.Object) []reconcile.Request {
	agt, ok := obj.(*agentzv1alpha1.Agent)
	if !ok {
		return nil
	}
	ref := agt.Spec.SandboxRef
	if ref == nil || ref.Name == "" {
		return nil
	}
	return []reconcile.Request{{
		NamespacedName: types.NamespacedName{
			Name:      ref.Name,
			Namespace: agt.Namespace,
		},
	}}
}

func (r *Reconciler) sandboxesForMCPConnection(ctx context.Context, obj client.Object) []reconcile.Request {
	conn, ok := obj.(*agentzv1alpha1.MCPConnection)
	if !ok {
		return nil
	}

	sandboxes := &agentzv1alpha1.SandboxList{}
	err := r.List(
		ctx,
		sandboxes,
		client.InNamespace(conn.Namespace),
		client.MatchingFields{mcp.SandboxByMCPConnectionIndex: conn.Name},
	)
	if err != nil {
		slog.ErrorContext(
			ctx,
			"list sandboxes for mcp connection",
			slog.String("namespace", conn.Namespace),
			slog.String("mcpConnection", conn.Name),
			slog.Any("err", err),
		)
		return nil
	}

	requests := make([]reconcile.Request, 0, len(sandboxes.Items))
	for _, sandbox := range sandboxes.Items {
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: sandbox.Namespace,
				Name:      sandbox.Name,
			},
		})
	}
	return requests
}

func (r *Reconciler) reconcileGateway(ctx context.Context, namespace string) error {
	owners, err := r.gatewayOwners(ctx, namespace)
	if err != nil {
		return err
	}
	if len(owners) == 0 {
		policy := &ciliumv2.CiliumNetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name:      mcp.GatewayName,
				Namespace: namespace,
			},
		}
		if err := r.Delete(ctx, policy); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete gateway network policy: %w", err)
		}

		gw := &gwv1.Gateway{
			ObjectMeta: metav1.ObjectMeta{
				Namespace: namespace,
				Name:      mcp.GatewayName,
			},
		}
		if err := r.Delete(ctx, gw); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete namespace gateway: %w", err)
		}

		if err := r.deleteAgentgatewayParameters(ctx, namespace); err != nil {
			return err
		}
		return nil
	}

	gw := &gwv1.Gateway{}
	gw.Name = mcp.GatewayName
	gw.Namespace = namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, gw, func() error {
		desired := mcp.Gateway(namespace)
		gw.Spec = desired.Spec
		refs := make([]metav1.OwnerReference, 0, len(owners))
		for _, sandbox := range owners {
			refs = append(refs, metav1.OwnerReference{
				APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
				Kind:       "Sandbox",
				Name:       sandbox.Name,
				UID:        sandbox.UID,
			})
		}
		gw.OwnerReferences = refs
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile gateway: %w", err)
	}
	if err := r.reconcileGatewayNetworkPolicy(ctx, namespace, owners); err != nil {
		return err
	}
	return r.ensureAgentgatewayParameters(ctx, namespace)
}

//nolint:gocyclo
func (r *Reconciler) reconcileBackend(ctx context.Context, sandbox *agentzv1alpha1.Sandbox, conns []agentzv1alpha1.MCPConnection) error {
	client := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayBackends(sandbox.Namespace)
	name := mcp.SandboxBackendName(sandbox.Name)

	obj, err := client.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get backend: %w", err)
		}
		obj = &agentgatewayv1alpha1.AgentgatewayBackend{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: sandbox.Namespace,
			},
		}
	}

	refsByName := make(map[string]agentzv1alpha1.MCPConnectionRef, len(sandbox.Spec.MCPConnectionRefs))
	for _, ref := range sandbox.Spec.MCPConnectionRefs {
		name := strings.TrimSpace(ref.Name)
		if name == "" {
			return fmt.Errorf("sandbox %q has an mcp connection ref with an empty name", sandbox.Name)
		}
		if _, ok := refsByName[name]; ok {
			return fmt.Errorf(
				"sandbox %q references mcp connection %q more than once",
				sandbox.Name,
				name,
			)
		}
		tools := make([]agentzv1alpha1.SandboxMCPTool, 0, len(ref.Tools))
		seenTools := make(map[string]struct{}, len(ref.Tools))
		for _, rawTool := range ref.Tools {
			toolName := strings.TrimSpace(rawTool.Name)
			if toolName == "" {
				return fmt.Errorf(
					"sandbox %q mcp connection %q has an empty tool name",
					sandbox.Name,
					name,
				)
			}
			if _, ok := seenTools[toolName]; ok {
				return fmt.Errorf(
					"sandbox %q mcp connection %q enables tool %q more than once",
					sandbox.Name,
					name,
					toolName,
				)
			}
			seenTools[toolName] = struct{}{}
			tools = append(tools, agentzv1alpha1.SandboxMCPTool{
				Name:           toolName,
				RequireConsent: rawTool.RequireConsent,
			})
		}
		refsByName[name] = agentzv1alpha1.MCPConnectionRef{
			Name:  name,
			Tools: tools,
		}
	}

	connsByName := make(map[string]agentzv1alpha1.MCPConnection, len(conns))
	for _, conn := range conns {
		connsByName[conn.Name] = conn
	}
	for name, ref := range refsByName {
		conn, ok := connsByName[name]
		if !ok {
			return fmt.Errorf(
				"sandbox %q references missing mcp connection %q",
				sandbox.Name,
				name,
			)
		}
		if !conn.Status.ToolCatalogReady {
			return fmt.Errorf(
				"sandbox %q mcp connection %q tool catalog is not ready",
				sandbox.Name,
				name,
			)
		}
		if len(ref.Tools) == 0 {
			return fmt.Errorf(
				"sandbox %q mcp connection %q has no enabled tools; patch or recreate the Sandbox",
				sandbox.Name,
				name,
			)
		}

		toolNames := make(map[string]struct{}, len(conn.Status.Tools))
		for _, tool := range conn.Status.Tools {
			toolNames[tool.Name] = struct{}{}
		}
		for _, tool := range ref.Tools {
			toolName := tool.Name
			if _, ok := toolNames[toolName]; ok {
				continue
			}
			return fmt.Errorf(
				"sandbox %q mcp connection %q enables unknown tool %q",
				sandbox.Name,
				name,
				toolName,
			)
		}
	}

	targetCount := len(conns)
	if targetCount == 1 {
		targetCount++
	}
	targets := make([]agentgatewayv1alpha1.McpTargetSelector, 0, targetCount)
	matchExpressions := make([]agentgatewayshared.CELExpression, 0, len(sandbox.Spec.MCPConnectionRefs))
	for _, conn := range conns {
		target, err := mcp.ParseTarget(&conn)
		if err != nil {
			return fmt.Errorf("resolve target for %q: %w", conn.Name, err)
		}
		policies := &agentgatewayv1alpha1.BackendSimple{}
		if target.Secure {
			policies.TLS = &agentgatewayv1alpha1.BackendTLS{
				Sni: &target.Host,
			}
			if conn.Spec.Endpoint.InsecureSkipVerify {
				mode := agentgatewayv1alpha1.InsecureTLSModeAll
				policies.TLS.InsecureSkipVerify = &mode
			}
		}
		if conn.Spec.Endpoint.Timeout != nil {
			timeout := conn.Spec.Endpoint.Timeout.DeepCopy()
			policies.HTTP = &agentgatewayv1alpha1.BackendHTTP{
				RequestTimeout: timeout,
			}
		}
		if policies.TLS == nil && policies.HTTP == nil && policies.Tunnel == nil && policies.Auth == nil && policies.TCP == nil {
			policies = nil
		}

		targets = append(targets, agentgatewayv1alpha1.McpTargetSelector{
			Name: gwv1.SectionName(conn.Name),
			Static: &agentgatewayv1alpha1.McpTarget{
				Host:     &target.Host,
				Port:     target.Port,
				Path:     target.Path,
				Protocol: target.Protocol,
				Policies: policies,
			},
		})

		ref, ok := refsByName[conn.Name]
		if !ok {
			return fmt.Errorf("mcp connection ref %q is missing from sandbox spec", conn.Name)
		}
		for _, tool := range ref.Tools {
			matchExpressions = append(matchExpressions, agentgatewayshared.CELExpression(
				fmt.Sprintf(
					`mcp.tool.target == %q && mcp.tool.name == %q`,
					conn.Name,
					tool.Name,
				),
			))
		}
	}
	if len(conns) == 1 {
		path := agentgatewayv1alpha1.LongString(mcp.ExtAuthMCPPath)
		protocol := agentgatewayv1alpha1.MCPProtocolStreamableHTTP
		targets = append(targets, agentgatewayv1alpha1.McpTargetSelector{
			Name: gwv1.SectionName(mcp.MCPHelperTargetName),
			Static: &agentgatewayv1alpha1.McpTarget{
				BackendRef: &corev1.LocalObjectReference{
					Name: mcp.ExtAuthServiceName,
				},
				Port:     mcp.ExtAuthMCPPort,
				Path:     &path,
				Protocol: &protocol,
			},
		})
	}

	currentSpec := obj.Spec.DeepCopy()
	currentOwners := slices.Clone(obj.OwnerReferences)

	obj.Spec = agentgatewayv1alpha1.AgentgatewayBackendSpec{
		MCP: &agentgatewayv1alpha1.MCPBackend{
			Targets:        targets,
			SessionRouting: agentgatewayv1alpha1.Stateful,
			// One unhealthy MCP target must not make healthy targets unreachable.
			// Agentgateway still fails requests when every target is unavailable.
			FailureMode: agentgatewayv1alpha1.FailOpen,
		},
	}
	obj.Spec.Policies = &agentgatewayv1alpha1.BackendFull{
		MCP: &agentgatewayv1alpha1.BackendMCP{
			Authorization: &agentgatewayshared.Authorization{
				Action: agentgatewayshared.AuthorizationPolicyActionAllow,
				Policy: agentgatewayshared.AuthorizationPolicy{
					MatchExpressions: matchExpressions,
				},
			},
		},
	}
	if err := ctrl.SetControllerReference(sandbox, obj, r.Scheme); err != nil {
		return fmt.Errorf("set backend owner: %w", err)
	}

	if obj.CreationTimestamp.IsZero() {
		if _, err := client.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create backend: %w", err)
		}
		return nil
	}
	if reflect.DeepEqual(currentSpec, obj.Spec) && reflect.DeepEqual(currentOwners, obj.OwnerReferences) {
		return nil
	}
	if _, err := client.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update backend: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileRoute(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	route := &gwv1.HTTPRoute{}
	route.Name = mcp.SandboxRouteName(sandbox.Name)
	route.Namespace = sandbox.Namespace

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, route, func() error {
		group := gwv1.Group("agentgateway.dev")
		kind := gwv1.Kind("AgentgatewayBackend")
		pathType := gwv1.PathMatchPathPrefix
		pathValue := mcp.SandboxRoutePath(sandbox.Name)
		route.Spec = gwv1.HTTPRouteSpec{
			CommonRouteSpec: gwv1.CommonRouteSpec{
				ParentRefs: []gwv1.ParentReference{{
					Name: gwv1.ObjectName(mcp.GatewayName),
				}},
			},
			Rules: []gwv1.HTTPRouteRule{{
				Matches: []gwv1.HTTPRouteMatch{{
					Path: &gwv1.HTTPPathMatch{
						Type:  &pathType,
						Value: &pathValue,
					},
				}},
				BackendRefs: []gwv1.HTTPBackendRef{{
					BackendRef: gwv1.BackendRef{
						BackendObjectReference: gwv1.BackendObjectReference{
							Group: &group,
							Kind:  &kind,
							Name:  gwv1.ObjectName(mcp.SandboxBackendName(sandbox.Name)),
						},
					},
				}},
			}},
		}
		return ctrl.SetControllerReference(sandbox, route, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile route: %w", err)
	}
	return nil
}

func (r *Reconciler) cleanupSandboxRuntime(ctx context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	route := &gwv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: sandbox.Namespace,
			Name:      mcp.SandboxRouteName(sandbox.Name),
		},
	}
	if err := r.Delete(ctx, route); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete route: %w", err)
	}

	err := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayBackends(sandbox.Namespace).Delete(
		ctx,
		mcp.SandboxBackendName(sandbox.Name),
		metav1.DeleteOptions{},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete backend: %w", err)
	}
	return nil
}

func (r *Reconciler) gatewayOwners(ctx context.Context, namespace string) ([]agentzv1alpha1.Sandbox, error) {
	sandboxes := &agentzv1alpha1.SandboxList{}
	if err := r.List(ctx, sandboxes, client.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list sandboxes: %w", err)
	}

	owners := make([]agentzv1alpha1.Sandbox, 0, len(sandboxes.Items))
	for _, sandbox := range sandboxes.Items {
		if !sandbox.DeletionTimestamp.IsZero() {
			continue
		}
		conns, err := mcp.LoadConnections(ctx, r.Client, &sandbox)
		if err != nil {
			return nil, err
		}
		if len(conns) == 0 {
			continue
		}
		owners = append(owners, sandbox)
	}
	slices.SortFunc(owners, func(a, b agentzv1alpha1.Sandbox) int {
		return strings.Compare(a.Name, b.Name)
	})
	return owners, nil
}

func (r *Reconciler) reconcileGatewayNetworkPolicy(ctx context.Context, namespace string, owners []agentzv1alpha1.Sandbox) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.GatewayName,
			Namespace: namespace,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, policy, func() error {
		refs := make([]metav1.OwnerReference, 0, len(owners))
		for _, sandbox := range owners {
			refs = append(refs, metav1.OwnerReference{
				APIVersion: agentzv1alpha1.SchemeGroupVersion.String(),
				Kind:       "Sandbox",
				Name:       sandbox.Name,
				UID:        sandbox.UID,
			})
		}
		policy.OwnerReferences = refs
		policy.Spec = gatewayNetworkPolicySpec(namespace)
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile gateway network policy: %w", err)
	}
	return nil
}

func gatewayNetworkPolicySpec(namespace string) *ciliumapi.Rule {
	return &ciliumapi.Rule{
		EndpointSelector: ciliumapi.NewESFromLabels(
			ciliumlabels.NewLabel(
				"io.kubernetes.pod.namespace",
				namespace,
				ciliumlabels.LabelSourceK8s,
			),
			ciliumlabels.NewLabel(
				"app.kubernetes.io/name",
				mcp.GatewayName,
				ciliumlabels.LabelSourceK8s,
			),
			ciliumlabels.NewLabel(
				"app.kubernetes.io/instance",
				mcp.GatewayName,
				ciliumlabels.LabelSourceK8s,
			),
			ciliumlabels.NewLabel(
				"gateway.networking.k8s.io/gateway-name",
				mcp.GatewayName,
				ciliumlabels.LabelSourceK8s,
			),
		),
		Ingress: []ciliumapi.IngressRule{{
			IngressCommonRule: ciliumapi.IngressCommonRule{
				FromEndpoints: []ciliumapi.EndpointSelector{
					ciliumapi.NewESFromLabels(
						ciliumlabels.NewLabel(
							"io.kubernetes.pod.namespace",
							namespace,
							ciliumlabels.LabelSourceK8s,
						),
						ciliumlabels.NewLabel(
							"app.kubernetes.io/name",
							"agentz-agent",
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
			}},
		}},
		Egress: []ciliumapi.EgressRule{{
			EgressCommonRule: ciliumapi.EgressCommonRule{
				ToEntities: ciliumapi.EntitySlice{ciliumapi.EntityAll},
			},
		}},
	}
}

func (r *Reconciler) ensureAgentgatewayParameters(ctx context.Context, namespace string) error {
	client := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayParameters(namespace)

	obj, err := client.Get(ctx, mcp.AgentgatewayParametersName, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get agentgateway parameters: %w", err)
		}
		obj = &agentgatewayv1alpha1.AgentgatewayParameters{
			ObjectMeta: metav1.ObjectMeta{
				Name:      mcp.AgentgatewayParametersName,
				Namespace: namespace,
			},
		}
	}

	specBytes, err := json.Marshal(map[string]string{"type": "ClusterIP"})
	if err != nil {
		return fmt.Errorf("marshal service spec overlay: %w", err)
	}

	desiredSpec := agentgatewayv1alpha1.AgentgatewayParametersSpec{
		AgentgatewayParametersOverlays: agentgatewayv1alpha1.AgentgatewayParametersOverlays{
			Service: &agentgatewayshared.KubernetesResourceOverlay{
				Spec: &apiextensionsv1.JSON{Raw: specBytes},
			},
		},
	}

	if obj.CreationTimestamp.IsZero() {
		obj.Spec = desiredSpec
		if _, err := client.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create agentgateway parameters: %w", err)
		}
		return nil
	}

	if reflect.DeepEqual(obj.Spec, desiredSpec) {
		return nil
	}

	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := client.Get(ctx, mcp.AgentgatewayParametersName, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("get agentgateway parameters for update: %w", err)
		}
		if reflect.DeepEqual(current.Spec, desiredSpec) {
			return nil
		}
		current.Spec = desiredSpec
		_, err = client.Update(ctx, current, metav1.UpdateOptions{})
		if err != nil {
			return fmt.Errorf("update agentgateway parameters: %w", err)
		}
		return nil
	})
}

func (r *Reconciler) deleteAgentgatewayParameters(ctx context.Context, namespace string) error {
	err := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayParameters(namespace).Delete(
		ctx, mcp.AgentgatewayParametersName, metav1.DeleteOptions{},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete agentgateway parameters: %w", err)
	}
	return nil
}
