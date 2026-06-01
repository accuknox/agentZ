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

package environment

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	agentgatewayshared "github.com/agentgateway/agentgateway/controller/api/v1alpha1/shared"
	agentgatewayclientset "github.com/agentgateway/agentgateway/controller/pkg/client/clientset/versioned"
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

	"github.com/accuknox/clawarmor/internal/envutil"
	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// Reconciler reconciles Environment lifecycle protection and MCP runtime.
type Reconciler struct {
	client.Client
	Scheme       *runtime.Scheme
	AgentGateway agentgatewayclientset.Interface
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=envs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=envs/finalizers,verbs=update
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=mcpconnections,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways;httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaybackends,verbs=get;list;watch;create;update;patch;delete

// Reconcile prevents unsafe deletion and manages namespace MCP runtime.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	env := &clawarmorv1alpha1.Environment{}
	if err := r.Get(ctx, req.NamespacedName, env); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	agentName, err := envutil.ReferencingAgentName(ctx, r.Client, env.Namespace, env.Name)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("find referencing agent: %w", err)
	}

	if !env.DeletionTimestamp.IsZero() {
		if agentName != "" {
			return ctrl.Result{}, fmt.Errorf("environment %q is referenced by agent %q", env.Name, agentName)
		}
		if ctrlutil.ContainsFinalizer(env, mcp.EnvironmentFinalizer) {
			patch := client.MergeFrom(env.DeepCopy())
			ctrlutil.RemoveFinalizer(env, mcp.EnvironmentFinalizer)
			if err := r.Patch(ctx, env, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}

	if !ctrlutil.ContainsFinalizer(env, mcp.EnvironmentFinalizer) {
		patch := client.MergeFrom(env.DeepCopy())
		ctrlutil.AddFinalizer(env, mcp.EnvironmentFinalizer)
		if err := r.Patch(ctx, env, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
	}

	conns, err := mcp.LoadConnections(ctx, r.Client, env)
	if err != nil {
		return ctrl.Result{}, err
	}
	if len(conns) == 0 {
		if err := r.cleanupEnvironmentRuntime(ctx, env); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.reconcileGateway(ctx, env.Namespace); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.updateStatus(ctx, env); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if err := r.reconcileGateway(ctx, env.Namespace); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileBackend(ctx, env, conns); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileRoute(ctx, env); err != nil {
		return ctrl.Result{}, err
	}

	if err := r.updateStatus(ctx, env); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// updateStatus computes spec-derived counters and persists them to status.
func (r *Reconciler) updateStatus(ctx context.Context, env *clawarmorv1alpha1.Environment) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &clawarmorv1alpha1.Environment{}
		key := types.NamespacedName{Namespace: env.Namespace, Name: env.Name}
		if err := r.Get(ctx, key, current); err != nil {
			return client.IgnoreNotFound(err)
		}
		current.Status.PackageCount = len(current.Spec.Packages)
		current.Status.AllowedHostCount = len(current.Spec.AllowedHosts)
		current.Status.MCPRefCount = len(current.Spec.MCPConnectionRefs)
		return r.Status().Update(ctx, current)
	})
}

// SetupWithManager sets up the Environment controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Environment{}).
		Watches(&clawarmorv1alpha1.Agent{}, handler.EnqueueRequestsFromMapFunc(r.environmentForAgent)).
		Watches(&clawarmorv1alpha1.MCPConnection{}, handler.EnqueueRequestsFromMapFunc(r.environmentsForMCPConnection)).
		Named("environment").
		Complete(r)
}

func (r *Reconciler) environmentForAgent(_ context.Context, obj client.Object) []reconcile.Request {
	agt, ok := obj.(*clawarmorv1alpha1.Agent)
	if !ok {
		return nil
	}
	ref := agt.Spec.EnvironmentRef
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

func (r *Reconciler) environmentsForMCPConnection(ctx context.Context, obj client.Object) []reconcile.Request {
	conn, ok := obj.(*clawarmorv1alpha1.MCPConnection)
	if !ok {
		return nil
	}

	envs := &clawarmorv1alpha1.EnvironmentList{}
	err := r.List(
		ctx,
		envs,
		client.InNamespace(conn.Namespace),
		client.MatchingFields{mcp.EnvironmentByMCPConnectionIndex: conn.Name},
	)
	if err != nil {
		return nil
	}

	requests := make([]reconcile.Request, 0, len(envs.Items))
	for _, env := range envs.Items {
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: env.Namespace,
				Name:      env.Name,
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
		if err := r.deleteGateway(ctx, namespace); err != nil {
			return err
		}
		return r.deleteAgentgatewayParameters(ctx, namespace)
	}

	gw := &gwv1.Gateway{}
	gw.Name = mcp.GatewayName
	gw.Namespace = namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, gw, func() error {
		desired := mcp.Gateway(namespace)
		gw.Spec = desired.Spec
		gw.OwnerReferences = gatewayOwnerReferences(owners)
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile gateway: %w", err)
	}
	return r.ensureAgentgatewayParameters(ctx, namespace)
}

func (r *Reconciler) reconcileBackend(ctx context.Context, env *clawarmorv1alpha1.Environment, conns []clawarmorv1alpha1.MCPConnection) error {
	client := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayBackends(env.Namespace)
	name := mcp.EnvironmentBackendName(env.Name)

	obj, err := client.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get backend: %w", err)
		}
		obj = &agentgatewayv1alpha1.AgentgatewayBackend{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: env.Namespace,
			},
		}
	}

	targets := make([]agentgatewayv1alpha1.McpTargetSelector, 0, len(conns))
	for _, conn := range conns {
		target, err := mcp.ParseTarget(&conn)
		if err != nil {
			return fmt.Errorf("resolve target for %q: %w", conn.Name, err)
		}
		targets = append(targets, agentgatewayv1alpha1.McpTargetSelector{
			Name: gwv1.SectionName(conn.Name),
			Static: &agentgatewayv1alpha1.McpTarget{
				Host:     new(target.Host),
				Port:     target.Port,
				Path:     target.Path,
				Protocol: target.Protocol,
			},
		})
		if target.Secure {
			targets[len(targets)-1].Static.Policies = &agentgatewayv1alpha1.BackendSimple{
				TLS: &agentgatewayv1alpha1.BackendTLS{
					Sni: new(target.Host),
				},
			}
		}
	}

	obj.Spec = agentgatewayv1alpha1.AgentgatewayBackendSpec{
		MCP: &agentgatewayv1alpha1.MCPBackend{
			Targets:        targets,
			SessionRouting: agentgatewayv1alpha1.Stateful,
		},
	}
	if err := ctrl.SetControllerReference(env, obj, r.Scheme); err != nil {
		return fmt.Errorf("set backend owner: %w", err)
	}

	if obj.CreationTimestamp.IsZero() {
		if _, err := client.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create backend: %w", err)
		}
		return nil
	}
	if _, err := client.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update backend: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileRoute(ctx context.Context, env *clawarmorv1alpha1.Environment) error {
	route := &gwv1.HTTPRoute{}
	route.Name = mcp.EnvironmentRouteName(env.Name)
	route.Namespace = env.Namespace

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, route, func() error {
		group := gwv1.Group("agentgateway.dev")
		kind := gwv1.Kind("AgentgatewayBackend")
		pathType := gwv1.PathMatchPathPrefix
		pathValue := mcp.EnvironmentRoutePath(env.Name)
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
							Name:  gwv1.ObjectName(mcp.EnvironmentBackendName(env.Name)),
						},
					},
				}},
			}},
		}
		return ctrl.SetControllerReference(env, route, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile route: %w", err)
	}
	return nil
}

func (r *Reconciler) cleanupEnvironmentRuntime(ctx context.Context, env *clawarmorv1alpha1.Environment) error {
	route := &gwv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: env.Namespace,
			Name:      mcp.EnvironmentRouteName(env.Name),
		},
	}
	if err := r.Delete(ctx, route); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete route: %w", err)
	}

	err := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayBackends(env.Namespace).Delete(
		ctx,
		mcp.EnvironmentBackendName(env.Name),
		metav1.DeleteOptions{},
	)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete backend: %w", err)
	}
	return nil
}

func (r *Reconciler) gatewayOwners(ctx context.Context, namespace string) ([]clawarmorv1alpha1.Environment, error) {
	envs := &clawarmorv1alpha1.EnvironmentList{}
	if err := r.List(ctx, envs, client.InNamespace(namespace)); err != nil {
		return nil, fmt.Errorf("list environments: %w", err)
	}

	owners := make([]clawarmorv1alpha1.Environment, 0, len(envs.Items))
	for _, env := range envs.Items {
		if !env.DeletionTimestamp.IsZero() {
			continue
		}
		conns, err := mcp.LoadConnections(ctx, r.Client, &env)
		if err != nil {
			return nil, err
		}
		if len(conns) == 0 {
			continue
		}
		owners = append(owners, env)
	}
	slices.SortFunc(owners, func(a, b clawarmorv1alpha1.Environment) int {
		return strings.Compare(a.Name, b.Name)
	})
	return owners, nil
}

func gatewayOwnerReferences(envs []clawarmorv1alpha1.Environment) []metav1.OwnerReference {
	refs := make([]metav1.OwnerReference, 0, len(envs))
	for _, env := range envs {
		refs = append(refs, metav1.OwnerReference{
			APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
			Kind:       "Environment",
			Name:       env.Name,
			UID:        env.UID,
		})
	}
	return refs
}

func (r *Reconciler) deleteGateway(ctx context.Context, namespace string) error {
	gw := &gwv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      mcp.GatewayName,
		},
	}
	if err := r.Delete(ctx, gw); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete namespace gateway: %w", err)
	}
	return nil
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

	obj.Spec = agentgatewayv1alpha1.AgentgatewayParametersSpec{
		AgentgatewayParametersOverlays: agentgatewayv1alpha1.AgentgatewayParametersOverlays{
			Service: &agentgatewayshared.KubernetesResourceOverlay{
				Spec: &apiextensionsv1.JSON{Raw: specBytes},
			},
		},
	}

	if obj.CreationTimestamp.IsZero() {
		if _, err := client.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create agentgateway parameters: %w", err)
		}
		return nil
	}
	if _, err := client.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update agentgateway parameters: %w", err)
	}
	return nil
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
