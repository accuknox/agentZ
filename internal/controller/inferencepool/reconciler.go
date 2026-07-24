// Package inferencepool reconciles Pool backends and derived status.
package inferencepool

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/accuknox/agentz/internal/inference"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Reconciler reconciles InferencePool runtime and derived status.
type Reconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferencepools,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferencepools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferencepools/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferenceproviders;sandboxes,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaybackends,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaypolicies,verbs=get;list;watch;create;update;patch;delete

// Reconcile moves one Pool backend and status toward the desired state.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	pool := &agentzv1alpha1.InferencePool{}
	if err := r.Get(ctx, req.NamespacedName, pool); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !pool.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, pool)
	}
	if !ctrlutil.ContainsFinalizer(pool, agentzv1alpha1.InferencePoolFinalizer) {
		patch := client.MergeFrom(pool.DeepCopy())
		ctrlutil.AddFinalizer(pool, agentzv1alpha1.InferencePoolFinalizer)
		if err := r.Patch(ctx, pool, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add inference pool finalizer: %w", err)
		}
	}

	definition, issues, err := inference.ResolvePool(ctx, r.Client, pool)
	if err != nil {
		return ctrl.Result{}, errors.Join(err, r.updateStatus(ctx, pool, definition, nil, err))
	}
	if len(issues) > 0 {
		err := fmt.Errorf("pool configuration is invalid: %s", issues[0].Message)
		return ctrl.Result{}, r.updateStatus(ctx, pool, definition, nil, err)
	}
	desired, err := inference.RenderPoolBackend(pool, definition)
	if err != nil {
		return ctrl.Result{}, errors.Join(err, r.updateStatus(ctx, pool, definition, nil, err))
	}
	backend := &agentgatewayv1alpha1.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Name: pool.Name, Namespace: pool.Namespace},
	}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, backend, func() error {
		if backend.UID != "" && !metav1.IsControlledBy(backend, pool) {
			return errors.New("inference backend name is already in use")
		}
		backend.Labels = desired.Labels
		backend.Spec = desired.Spec
		return ctrlutil.SetControllerReference(pool, backend, r.Scheme)
	})
	if err != nil {
		return ctrl.Result{}, errors.Join(err, r.updateStatus(ctx, pool, definition, backend, err))
	}
	if err := r.reconcileAuthPolicies(ctx, pool, definition); err != nil {
		return ctrl.Result{}, errors.Join(err, r.updateStatus(ctx, pool, definition, backend, err))
	}
	return ctrl.Result{}, r.updateStatus(ctx, pool, definition, backend, nil)
}

// SetupWithManager registers Pool watches and owned backends.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.InferencePool{}).
		Watches(
			&agentzv1alpha1.InferenceProvider{},
			handler.EnqueueRequestsFromMapFunc(r.poolsForProvider),
		).
		Owns(&agentgatewayv1alpha1.AgentgatewayBackend{}).
		Owns(&agentgatewayv1alpha1.AgentgatewayPolicy{}).
		Named("inference-pool").
		Complete(r)
}

func (r *Reconciler) reconcileAuthPolicies(ctx context.Context, pool *agentzv1alpha1.InferencePool, definition inference.PoolDefinition) error {
	desired := make(map[string]bool, len(definition.Members))
	for i := range definition.Members {
		member := &definition.Members[i]
		isCodex := member.Provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		isCopilot := member.Provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
		if !isCodex && !isCopilot {
			continue
		}
		policy := inference.RenderInferenceAuthPolicy(
			pool.Namespace,
			pool.Name,
			&member.Section,
			member.Provider.Name,
			pool.Name,
		)
		desired[policy.Name] = true
		current := &agentgatewayv1alpha1.AgentgatewayPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: policy.Name, Namespace: pool.Namespace},
		}
		_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
			if current.UID != "" && !metav1.IsControlledBy(current, pool) {
				return errors.New("pool auth policy name is already in use")
			}
			current.Spec = policy.Spec
			return ctrlutil.SetControllerReference(pool, current, r.Scheme)
		})
		if err != nil {
			return fmt.Errorf("reconcile pool auth policy: %w", err)
		}
	}
	policies := &agentgatewayv1alpha1.AgentgatewayPolicyList{}
	if err := r.List(ctx, policies, client.InNamespace(pool.Namespace)); err != nil {
		return fmt.Errorf("list pool auth policies: %w", err)
	}
	for i := range policies.Items {
		policy := &policies.Items[i]
		if !metav1.IsControlledBy(policy, pool) {
			continue
		}
		if _, ok := desired[policy.Name]; ok {
			continue
		}
		if err := r.Delete(ctx, policy); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete stale pool auth policy %q: %w", policy.Name, err)
		}
	}
	return nil
}

func (r *Reconciler) poolsForProvider(ctx context.Context, obj client.Object) []reconcile.Request {
	pools := &agentzv1alpha1.InferencePoolList{}
	err := r.List(
		ctx,
		pools,
		client.InNamespace(obj.GetNamespace()),
		client.MatchingFields{inference.PoolByProviderIndex: obj.GetName()},
	)
	if err != nil {
		slog.ErrorContext(
			ctx,
			"list pools for inference provider",
			slog.String("namespace", obj.GetNamespace()),
			slog.String("provider", obj.GetName()),
			slog.Any("err", err),
		)
		return nil
	}
	requests := make([]reconcile.Request, 0, len(pools.Items))
	for _, pool := range pools.Items {
		requests = append(requests, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: pool.Namespace,
			Name:      pool.Name,
		}})
	}
	return requests
}

func (r *Reconciler) reconcileDelete(ctx context.Context, pool *agentzv1alpha1.InferencePool) (ctrl.Result, error) {
	if !ctrlutil.ContainsFinalizer(pool, agentzv1alpha1.InferencePoolFinalizer) {
		return ctrl.Result{}, nil
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := r.List(
		ctx,
		sandboxes,
		client.InNamespace(pool.Namespace),
		client.MatchingFields{inference.SandboxByPoolIndex: pool.Name},
	)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("list pool references before deletion: %w", err)
	}
	if len(sandboxes.Items) > 0 {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	backend := &agentgatewayv1alpha1.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Name: pool.Name, Namespace: pool.Namespace},
	}
	err = r.Get(ctx, client.ObjectKeyFromObject(backend), backend)
	if err == nil && !metav1.IsControlledBy(backend, pool) {
		return ctrl.Result{}, errors.New("pool backend name is owned by another resource")
	}
	if err == nil {
		if err := r.Delete(ctx, backend); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, fmt.Errorf("delete pool backend: %w", err)
		}
		return ctrl.Result{RequeueAfter: 500 * time.Millisecond}, nil
	}
	if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, fmt.Errorf("read pool backend for cleanup: %w", err)
	}
	patch := client.MergeFrom(pool.DeepCopy())
	ctrlutil.RemoveFinalizer(pool, agentzv1alpha1.InferencePoolFinalizer)
	if err := r.Patch(ctx, pool, patch); err != nil {
		return ctrl.Result{}, fmt.Errorf("remove inference pool finalizer: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) updateStatus(ctx context.Context, pool *agentzv1alpha1.InferencePool, definition inference.PoolDefinition, backend *agentgatewayv1alpha1.AgentgatewayBackend, reconcileErr error) error {
	return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		current := &agentzv1alpha1.InferencePool{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(pool), current); err != nil {
			return err
		}
		status := agentzv1alpha1.InferencePoolStatus{
			ObservedGeneration: current.Generation,
			State:              agentzv1alpha1.InferencePoolStateAccepted,
			Protocol:           definition.Protocol,
			Warnings:           definition.Warnings,
			Members:            make([]agentzv1alpha1.InferencePoolMemberStatus, 0, len(definition.Members)),
			Conditions:         current.Status.Conditions,
		}
		if len(definition.Members) > 0 && reconcileErr == nil {
			contract := definition.Contract
			status.Contract = &contract
		}

		var readyMembers int
		for _, member := range definition.Members {
			ready := member.Provider.Status.State == agentzv1alpha1.InferenceProviderStateReady
			reason := "ProviderReady"
			message := "provider is ready"
			if ready {
				readyMembers++
			}
			if !ready {
				reason = "ProviderNotReady"
				message = "provider is not ready"
				for _, condition := range member.Provider.Status.Conditions {
					if condition.Type == string(agentzv1alpha1.InferenceProviderConditionReady) {
						reason = condition.Reason
						message = condition.Message
						break
					}
				}
			}
			status.Members = append(status.Members, agentzv1alpha1.InferencePoolMemberStatus{
				Provider: member.Ref.Provider,
				Model:    member.Ref.Model,
				Protocol: member.Protocol,
				Ready:    ready,
				Reason:   reason,
				Message:  message,
			})
		}

		accepted := false
		backendRejected := false
		if backend != nil {
			for _, condition := range backend.Status.Conditions {
				if condition.Type != "Accepted" {
					continue
				}
				accepted = condition.Status == metav1.ConditionTrue
				backendRejected = condition.Status == metav1.ConditionFalse
				break
			}
		}
		switch {
		case reconcileErr != nil || backendRejected:
			status.State = agentzv1alpha1.InferencePoolStateDegraded
		case readyMembers == 0:
			status.State = agentzv1alpha1.InferencePoolStateDegraded
		case accepted && readyMembers == len(definition.Members):
			status.State = agentzv1alpha1.InferencePoolStateReady
		case accepted && readyMembers > 0:
			status.State = agentzv1alpha1.InferencePoolStatePartiallyDegraded
		}

		acceptedStatus := metav1.ConditionTrue
		acceptedReason := "Accepted"
		acceptedMessage := "pool configuration is valid"
		if reconcileErr != nil {
			acceptedStatus = metav1.ConditionFalse
			acceptedReason = "ReconcileFailed"
			acceptedMessage = reconcileErr.Error()
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type: string(agentzv1alpha1.InferencePoolConditionAccepted), Status: acceptedStatus,
			Reason: acceptedReason, Message: acceptedMessage,
			ObservedGeneration: current.Generation,
		})
		backendStatus := metav1.ConditionFalse
		backendReason := "BackendPending"
		backendMessage := "waiting for AgentGateway to accept the backend"
		switch {
		case accepted:
			backendStatus = metav1.ConditionTrue
			backendReason = "BackendAccepted"
			backendMessage = "AgentGateway accepted the backend"
		case backendRejected:
			backendReason = "BackendRejected"
			backendMessage = "AgentGateway rejected the backend"
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type: string(agentzv1alpha1.InferencePoolConditionBackendReady), Status: backendStatus,
			Reason: backendReason, Message: backendMessage,
			ObservedGeneration: current.Generation,
		})
		membersStatus := metav1.ConditionFalse
		membersReason := "MembersNotReady"
		membersMessage := fmt.Sprintf("%d of %d members are ready", readyMembers, len(definition.Members))
		if readyMembers == len(definition.Members) && len(definition.Members) > 0 {
			membersStatus = metav1.ConditionTrue
			membersReason = "MembersReady"
			membersMessage = "all members are ready"
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type: string(agentzv1alpha1.InferencePoolConditionMembersReady), Status: membersStatus,
			Reason: membersReason, Message: membersMessage,
			ObservedGeneration: current.Generation,
		})
		poolReady := status.State == agentzv1alpha1.InferencePoolStateReady
		readyStatus := metav1.ConditionFalse
		if poolReady {
			readyStatus = metav1.ConditionTrue
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type: string(agentzv1alpha1.InferencePoolConditionReady), Status: readyStatus,
			Reason: string(status.State), Message: "pool state is " + string(status.State),
			ObservedGeneration: current.Generation,
		})
		if reflect.DeepEqual(current.Status, status) {
			return nil
		}
		current.Status = status
		return r.Status().Update(ctx, current)
	})
}
