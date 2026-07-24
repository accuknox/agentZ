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

package mcpconn

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	agentgatewayclientset "github.com/agentgateway/agentgateway/controller/pkg/client/clientset/versioned"
	baoapi "github.com/openbao/openbao/api/v2"
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
	"github.com/accuknox/agentz/internal/openbao"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	conditionAccepted = mcp.ConditionAccepted
	conditionReady    = mcp.ConditionReady
	conditionDegraded = mcp.ConditionDegraded
	reasonAccepted    = mcp.ReasonAccepted
	reasonReady       = mcp.ReasonReady
	reasonDegraded    = mcp.ReasonReconcileFailed
)

// MCPConnectionReconciler reconciles one MCPConnection object.
type MCPConnectionReconciler struct {
	client.Client
	Scheme                  *runtime.Scheme
	AgentGateway            agentgatewayclientset.Interface
	OpenBaoAddr             string
	ManagerOpenBaoAddr      string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

func (r *MCPConnectionReconciler) managerOpenBaoAddr() string {
	addr := strings.TrimSpace(r.ManagerOpenBaoAddr)
	if addr != "" {
		return addr
	}
	return strings.TrimSpace(r.OpenBaoAddr)
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=mcpconnections,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=mcpconnections/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=mcpconnections/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods;serviceaccounts;services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaypolicies,verbs=get;list;watch;create;update;patch;delete

// Reconcile moves MCP runtime resources toward the declared connection state.
func (r *MCPConnectionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	conn := &agentzv1alpha1.MCPConnection{}
	if err := r.Get(ctx, req.NamespacedName, conn); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !conn.DeletionTimestamp.IsZero() {
		if err := r.deleteRuntime(ctx, conn); err != nil {
			return ctrl.Result{}, err
		}
		if ctrlutil.ContainsFinalizer(conn, mcp.MCPConnectionFinalizer) {
			patch := client.MergeFrom(conn.DeepCopy())
			ctrlutil.RemoveFinalizer(conn, mcp.MCPConnectionFinalizer)
			if err := r.Patch(ctx, conn, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}
	if !ctrlutil.ContainsFinalizer(conn, mcp.MCPConnectionFinalizer) {
		patch := client.MergeFrom(conn.DeepCopy())
		ctrlutil.AddFinalizer(conn, mcp.MCPConnectionFinalizer)
		if err := r.Patch(ctx, conn, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
	}

	refs, err := r.referencingSandboxes(ctx, conn.Namespace, conn.Name)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("list referencing sandboxes: %w", err)
	}

	ready, err := r.extAuthReady(ctx, conn.Namespace)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("read ext auth runtime status: %w", err)
	}
	extAuth := &extAuthStatus{
		serviceRef:    mcp.ManagedRef(conn.Namespace, mcp.ExtAuthServiceName),
		deploymentRef: mcp.ManagedRef(conn.Namespace, mcp.ExtAuthServiceName),
		ready:         ready,
	}

	requiresExtAuth := conn.Spec.Auth != nil && len(refs) > 0
	if len(refs) == 0 {
		err = r.deleteAuthPolicies(ctx, conn)
		if err != nil {
			return ctrl.Result{}, err
		}
		err = r.updateStatus(
			ctx,
			conn,
			agentzv1alpha1.MCPConnectionStateAccepted,
			nil,
			extAuth,
			false,
			nil,
		)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("update accepted status: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if requiresExtAuth && (extAuth == nil || !extAuth.ready) {
		err = fmt.Errorf("ext auth runtime is not ready")
		statusErr := r.updateStatus(
			ctx,
			conn,
			agentzv1alpha1.MCPConnectionStateDegraded,
			nil,
			extAuth,
			requiresExtAuth,
			err,
		)
		if statusErr != nil {
			return ctrl.Result{}, fmt.Errorf("update degraded status: %w", statusErr)
		}
		return ctrl.Result{}, err
	}

	policy, err := r.reconcileConnectionPolicies(ctx, conn, refs)
	if err != nil {
		statusErr := r.updateStatus(
			ctx,
			conn,
			agentzv1alpha1.MCPConnectionStateDegraded,
			nil,
			extAuth,
			requiresExtAuth,
			err,
		)
		if statusErr != nil {
			return ctrl.Result{}, fmt.Errorf("update degraded status: %w", statusErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile connection policies: %w", err)
	}

	err = r.updateStatus(
		ctx,
		conn,
		agentzv1alpha1.MCPConnectionStateReady,
		policy,
		extAuth,
		requiresExtAuth,
		nil,
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("update ready status: %w", err)
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *MCPConnectionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.MCPConnection{}).
		Watches(&agentzv1alpha1.Sandbox{}, handler.EnqueueRequestsFromMapFunc(r.mcpConnectionsForSandbox)).
		Named("mcpconnection").
		Complete(r)
}

func (r *MCPConnectionReconciler) mcpConnectionsForSandbox(_ context.Context, obj client.Object) []reconcile.Request {
	sandbox, ok := obj.(*agentzv1alpha1.Sandbox)
	if !ok {
		return nil
	}

	requests := make([]reconcile.Request, 0, len(sandbox.Spec.MCPConnectionRefs))
	for _, name := range mcp.MCPConnectionRefNames(sandbox) {
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: sandbox.Namespace,
				Name:      name,
			},
		})
	}
	return requests
}

func (r *MCPConnectionReconciler) referencingSandboxes(ctx context.Context, namespace, name string) ([]agentzv1alpha1.Sandbox, error) {
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := r.List(
		ctx,
		sandboxes,
		client.InNamespace(namespace),
		client.MatchingFields{mcp.SandboxByMCPConnectionIndex: name},
	)
	if err != nil {
		return nil, err
	}
	return sandboxes.Items, nil
}

func (r *MCPConnectionReconciler) reconcileConnectionPolicies(ctx context.Context, conn *agentzv1alpha1.MCPConnection, refs []agentzv1alpha1.Sandbox) (*agentzv1alpha1.MCPConnectionManagedResourceRef, error) {
	policies := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayPolicies(conn.Namespace)
	namespaceEnvs := &agentzv1alpha1.SandboxList{}
	err := r.List(ctx, namespaceEnvs, client.InNamespace(conn.Namespace))
	if err != nil {
		return nil, fmt.Errorf("list namespace sandboxes: %w", err)
	}

	if conn.Spec.Auth == nil && len(conn.Spec.Endpoint.Headers) == 0 {
		for _, sandbox := range namespaceEnvs.Items {
			name := mcp.SandboxAuthPolicyName(sandbox.Name, conn.Name)
			err := policies.Delete(ctx, name, metav1.DeleteOptions{})
			if err != nil && !apierrors.IsNotFound(err) {
				return nil, fmt.Errorf("delete auth policy %q: %w", name, err)
			}
		}
		return nil, nil
	}

	activeEnvNames := make(map[string]struct{}, len(refs))
	for _, sandbox := range refs {
		activeEnvNames[sandbox.Name] = struct{}{}
	}
	for _, sandbox := range namespaceEnvs.Items {
		if _, ok := activeEnvNames[sandbox.Name]; ok {
			continue
		}
		name := mcp.SandboxAuthPolicyName(sandbox.Name, conn.Name)
		err := policies.Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("delete stale auth policy %q: %w", name, err)
		}
	}

	var managedRef *agentzv1alpha1.MCPConnectionManagedResourceRef
	for _, sandbox := range refs {
		name := mcp.SandboxAuthPolicyName(sandbox.Name, conn.Name)
		obj, err := policies.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if !apierrors.IsNotFound(err) {
				return nil, fmt.Errorf("get auth policy %q: %w", name, err)
			}
			obj = &agentgatewayv1alpha1.AgentgatewayPolicy{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: conn.Namespace,
				},
			}
		}

		currentSpec := obj.Spec.DeepCopy()
		currentOwners := slices.Clone(obj.OwnerReferences)

		var transformation *agentgatewayv1alpha1.Transformation
		if len(conn.Spec.Endpoint.Headers) > 0 {
			names := slices.Collect(maps.Keys(conn.Spec.Endpoint.Headers))
			slices.Sort(names)
			setHeaders := make([]agentgatewayv1alpha1.HeaderTransformation, 0, len(names))
			for _, headerName := range names {
				setHeaders = append(setHeaders, agentgatewayv1alpha1.HeaderTransformation{
					Name:  agentgatewayv1alpha1.HeaderName(headerName),
					Value: agentgatewayv1alpha1.CELExpression(fmt.Sprintf("%q", conn.Spec.Endpoint.Headers[headerName])),
				})
			}
			transformation = &agentgatewayv1alpha1.Transformation{
				Request: &agentgatewayv1alpha1.Transform{
					Set: setHeaders,
				},
			}
		}

		var extAuth *agentgatewayv1alpha1.ExtAuth
		if conn.Spec.Auth != nil {
			extAuthPort := mcp.ExtAuthPort
			extAuth = &agentgatewayv1alpha1.ExtAuth{
				BackendRef: &gwv1.BackendObjectReference{
					Name: gwv1.ObjectName(mcp.ExtAuthServiceName),
					Port: &extAuthPort,
				},
				GRPC: &agentgatewayv1alpha1.AgentExtAuthGRPC{
					ContextExtensions: map[string]string{
						"agentz.namespace":      conn.Namespace,
						"agentz.sandbox":        sandbox.Name,
						"agentz.mcp_connection": conn.Name,
					},
					RequestMetadata: map[string]agentgatewayv1alpha1.CELExpression{
						"agentz.namespace":      agentgatewayv1alpha1.CELExpression(fmt.Sprintf("%q", conn.Namespace)),
						"agentz.sandbox":        agentgatewayv1alpha1.CELExpression(fmt.Sprintf("%q", sandbox.Name)),
						"agentz.mcp_connection": agentgatewayv1alpha1.CELExpression(fmt.Sprintf("%q", conn.Name)),
					},
				},
			}
		}

		section := gwv1.SectionName(conn.Name)
		obj.Spec = agentgatewayv1alpha1.AgentgatewayPolicySpec{
			TargetRefs: []agentgatewayv1alpha1.LocalPolicyTargetReferenceWithSectionName{{
				LocalPolicyTargetReference: agentgatewayv1alpha1.LocalPolicyTargetReference{
					Group: "agentgateway.dev",
					Kind:  "AgentgatewayBackend",
					Name:  gwv1.ObjectName(mcp.SandboxBackendName(sandbox.Name)),
				},
				SectionName: &section,
			}},
			Backend: &agentgatewayv1alpha1.BackendFull{
				Transformation: transformation,
				ExtAuth:        extAuth,
			},
		}

		if err := ctrl.SetControllerReference(conn, obj, r.Scheme); err != nil {
			return nil, fmt.Errorf("set auth policy owner: %w", err)
		}

		if obj.CreationTimestamp.IsZero() {
			if _, err := policies.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
				return nil, fmt.Errorf("create auth policy %q: %w", name, err)
			}
		}
		exists := !obj.CreationTimestamp.IsZero()
		specChanged := !reflect.DeepEqual(currentSpec, obj.Spec)
		ownersChanged := !reflect.DeepEqual(currentOwners, obj.OwnerReferences)
		if exists && (specChanged || ownersChanged) {
			_, err := policies.Update(ctx, obj, metav1.UpdateOptions{})
			if err != nil {
				return nil, fmt.Errorf("update auth policy %q: %w", name, err)
			}
		}

		if managedRef == nil {
			managedRef = mcp.ManagedRef(conn.Namespace, name)
		}
	}

	return managedRef, nil
}

func (r *MCPConnectionReconciler) updateStatus(ctx context.Context, conn *agentzv1alpha1.MCPConnection, state agentzv1alpha1.MCPConnectionState, authRef *agentzv1alpha1.MCPConnectionManagedResourceRef, extAuth *extAuthStatus, extAuthRequired bool, recErr error) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.MCPConnection{}
		key := types.NamespacedName{Namespace: conn.Namespace, Name: conn.Name}
		err := r.Get(ctx, key, current)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		status := current.Status.DeepCopy()
		status.ObservedGeneration = current.Generation
		status.State = state
		status.AuthMode = resolveAuthMode(current.Spec.Auth)
		status.ServiceRef = nil
		status.AuthPolicyRef = authRef
		status.ExtAuthServiceRef = nil
		status.ExtAuthDeploymentRef = nil
		if extAuth != nil {
			status.ExtAuthServiceRef = extAuth.serviceRef
			status.ExtAuthDeploymentRef = extAuth.deploymentRef
		}

		ready := metav1.ConditionFalse
		degraded := metav1.ConditionFalse
		readyReason := reasonAccepted
		readyMessage := "MCP runtime is accepted"
		degradedReason := reasonAccepted
		degradedMessage := "No MCP runtime failure detected"
		if state == agentzv1alpha1.MCPConnectionStateReady {
			ready = metav1.ConditionTrue
			readyReason = reasonReady
			readyMessage = "MCP runtime is ready"
		}
		if recErr != nil || state == agentzv1alpha1.MCPConnectionStateDegraded {
			degraded = metav1.ConditionTrue
			degradedReason = reasonDegraded
			degradedMessage = "MCP runtime reconcile failed"
			if recErr != nil {
				degradedMessage = recErr.Error()
			}
		}

		status.SetCondition(metav1.Condition{
			Type:               conditionAccepted,
			Status:             metav1.ConditionTrue,
			Reason:             reasonAccepted,
			Message:            "MCPConnection spec accepted",
			ObservedGeneration: current.Generation,
		})
		status.SetCondition(metav1.Condition{
			Type:               conditionReady,
			Status:             ready,
			Reason:             readyReason,
			Message:            readyMessage,
			ObservedGeneration: current.Generation,
		})
		status.SetCondition(metav1.Condition{
			Type:               conditionDegraded,
			Status:             degraded,
			Reason:             degradedReason,
			Message:            degradedMessage,
			ObservedGeneration: current.Generation,
		})
		extAuthCondition := metav1.Condition{
			Type:               extAuthConditionType,
			Status:             metav1.ConditionFalse,
			Reason:             reasonAccepted,
			Message:            "Ext auth runtime is not required",
			ObservedGeneration: current.Generation,
		}
		if extAuth != nil && extAuth.ready {
			extAuthCondition.Status = metav1.ConditionTrue
			extAuthCondition.Reason = reasonReady
			extAuthCondition.Message = "Ext auth runtime is ready"
		}
		if extAuth != nil && !extAuth.ready {
			extAuthCondition.Reason = "DeploymentNotReady"
			extAuthCondition.Message = "Ext auth runtime is not ready"
		}
		if extAuthRequired && extAuth == nil {
			extAuthCondition.Reason = reasonDegraded
			extAuthCondition.Message = "Ext auth runtime is unavailable"
		}
		status.SetCondition(extAuthCondition)
		if reflect.DeepEqual(current.Status, *status) {
			return nil
		}
		patch := client.MergeFrom(current.DeepCopy())
		current.Status = *status
		return r.Status().Patch(ctx, current, patch)
	})
}

// resolveAuthMode returns a human-readable auth mode string for a given Auth
// spec pointer.
func resolveAuthMode(auth *agentzv1alpha1.MCPConnectionAuth) string {
	if auth == nil {
		return "None"
	}
	if auth.Bearer != nil {
		return "Bearer"
	}
	if auth.OAuth != nil {
		return "OAuth"
	}
	return "None"
}

func (r *MCPConnectionReconciler) deleteAuthPolicies(ctx context.Context, conn *agentzv1alpha1.MCPConnection) error {
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := r.List(ctx, sandboxes, client.InNamespace(conn.Namespace))
	if err != nil {
		return fmt.Errorf("list namespace sandboxes for auth policy cleanup: %w", err)
	}

	policies := r.AgentGateway.AgentgatewayAgentgateway().AgentgatewayPolicies(conn.Namespace)
	for _, sandbox := range sandboxes.Items {
		name := mcp.SandboxAuthPolicyName(sandbox.Name, conn.Name)
		err := policies.Delete(
			ctx,
			name,
			metav1.DeleteOptions{},
		)
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete auth policy %q: %w", name, err)
		}
	}

	return nil
}

func (r *MCPConnectionReconciler) deleteRuntime(ctx context.Context, conn *agentzv1alpha1.MCPConnection) error {
	if err := r.deleteAuthPolicies(ctx, conn); err != nil {
		return err
	}

	openBaoAddr := strings.TrimSpace(r.managerOpenBaoAddr())
	openBaoSecretMntPath := strings.TrimSpace(r.OpenBaoSecretMountPath)
	openBaoK8sAuthRole := strings.TrimSpace(r.OpenBaoK8sAuthRole)
	if openBaoAddr == "" || openBaoSecretMntPath == "" || openBaoK8sAuthRole == "" {
		return nil
	}

	baoClient, err := openbao.NewClient(
		ctx,
		openBaoAddr,
		openBaoK8sAuthRole,
		r.OpenBaoK8sAuthMountPath,
		r.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return fmt.Errorf("create openbao client for mcp cleanup: %w", err)
	}

	path := mcp.SecretPath(conn.Namespace, conn.Name)
	err = baoClient.KVv2(r.OpenBaoSecretMountPath).DeleteMetadata(ctx, path)
	if err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
		return fmt.Errorf("delete mcp connection secret metadata %q: %w", path, err)
	}
	return nil
}
