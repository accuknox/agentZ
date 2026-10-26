// Package guardrail reconciles reusable detector connections and policy validation status.
package guardrail

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	eso "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/accuknox/agentz/internal/guardrails"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type guardrailCredentialKeys struct {
	Data struct {
		Keys []string `json:"keys"`
	} `json:"data"`
}

// ConnectionReconciler materializes reusable detector credentials and transports.
type ConnectionReconciler struct {
	client.Client
	StoreName              string
	Bao                    *baoapi.Client
	OpenBaoSecretMountPath string
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=guardrailconnections;guardrailpolicies;tenants,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=guardrailconnections/status;guardrailpolicies/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=guardrailconnections;guardrailconnections/finalizers,verbs=update;patch
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaybackends,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;delete

// Reconcile validates and projects one detector connection.
func (r *ConnectionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	connection := &api.GuardrailConnection{}
	if err := r.Get(ctx, req.NamespacedName, connection); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !connection.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, connection)
	}
	if !ctrlutil.ContainsFinalizer(connection, api.GuardrailConnectionFinalizer) {
		patch := client.MergeFrom(connection.DeepCopy())
		ctrlutil.AddFinalizer(connection, api.GuardrailConnectionFinalizer)
		if err := r.Patch(ctx, connection, patch); err != nil {
			return ctrl.Result{}, err
		}
	}
	err := guardrails.ValidateConnection(connection.Spec)
	if err == nil {
		bundle := &guardrails.Bundle{Connections: []*api.GuardrailConnection{connection}}
		_, err = bundle.ProjectConnections(ctx, r.Client, connection.Namespace, r.StoreName)
	}
	status := api.GuardrailResourceStatus{
		ObservedGeneration: connection.Generation,
		State:              "Ready",
		Message:            "Configuration accepted; workloads report enforcement rollout separately.",
	}
	if err != nil {
		status.State = "Error"
		status.Message = err.Error()
	}
	data, marshalErr := json.Marshal(connection.Spec)
	if marshalErr != nil {
		return ctrl.Result{}, marshalErr
	}
	sum := sha256.Sum256(data)
	status.Revision = hex.EncodeToString(sum[:])
	if !reflect.DeepEqual(connection.Status, status) {
		patch := client.MergeFrom(connection.DeepCopy())
		connection.Status = status
		if err := r.Status().Patch(ctx, connection, patch); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{RequeueAfter: time.Minute}, nil
}

func (r *ConnectionReconciler) reconcileDelete(ctx context.Context, connection *api.GuardrailConnection) (ctrl.Result, error) {
	if !ctrlutil.ContainsFinalizer(connection, api.GuardrailConnectionFinalizer) {
		return ctrl.Result{}, nil
	}
	selector := client.MatchingLabels{guardrails.ConnectionUIDLabel: string(connection.UID)}
	backends := &agw.AgentgatewayBackendList{}
	if err := r.List(ctx, backends, selector); err != nil {
		return ctrl.Result{}, err
	}
	for i := range backends.Items {
		if err := r.Delete(ctx, &backends.Items[i]); client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, err
		}
	}
	externalSecrets := &eso.ExternalSecretList{}
	if err := r.List(ctx, externalSecrets, selector); err != nil {
		return ctrl.Result{}, err
	}
	for i := range externalSecrets.Items {
		if err := r.Delete(ctx, &externalSecrets.Items[i]); client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, err
		}
	}
	secrets := &corev1.SecretList{}
	if err := r.List(ctx, secrets, selector); err != nil {
		return ctrl.Result{}, err
	}
	for i := range secrets.Items {
		if err := r.Delete(ctx, &secrets.Items[i]); client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, err
		}
	}
	if len(backends.Items)+len(externalSecrets.Items)+len(secrets.Items) > 0 {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	if connection.Spec.SecretName != "" {
		mount := strings.TrimSpace(r.OpenBaoSecretMountPath)
		if r.Bao == nil || mount == "" {
			return ctrl.Result{}, fmt.Errorf("complete manager OpenBao configuration is required for guardrail credential cleanup")
		}
		path := connection.Namespace + "/guardrail-connections/" + connection.Name
		request := r.Bao.NewRequest("LIST", "/v1/"+mount+"/metadata/"+path)
		response, err := r.Bao.RawRequestWithContext(ctx, request)
		var keys guardrailCredentialKeys
		if response != nil {
			defer response.Body.Close()
		}
		var responseError *baoapi.ResponseError
		missing := errors.As(err, &responseError) && responseError.StatusCode == 404
		if err != nil && !missing {
			return ctrl.Result{}, fmt.Errorf("list guardrail credential revisions: %w", err)
		}
		if err == nil {
			if err := response.DecodeJSON(&keys); err != nil {
				return ctrl.Result{}, fmt.Errorf("decode guardrail credential revisions: %w", err)
			}
		}
		// Revisions remain available to projections until connection deletion.
		// Deleting a failed rotation never changes the active key's history.
		paths := []string{path}
		for _, key := range keys.Data.Keys {
			paths = append(paths, path+"/"+key)
		}
		for _, key := range paths {
			err := r.Bao.KVv2(mount).DeleteMetadata(ctx, key)
			if err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
				return ctrl.Result{}, fmt.Errorf("delete guardrail credential metadata: %w", err)
			}
		}
	}
	patch := client.MergeFrom(connection.DeepCopy())
	ctrlutil.RemoveFinalizer(connection, api.GuardrailConnectionFinalizer)
	if err := r.Patch(ctx, connection, patch); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	return ctrl.Result{}, nil
}

// SetupWithManager registers detector connection reconciliation.
func (r *ConnectionReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).For(&api.GuardrailConnection{}).Named("guardrail-connection").Complete(r)
}

// PolicyReconciler validates resolved policy capabilities as dependencies change.
type PolicyReconciler struct{ client.Client }

// Reconcile validates the complete detector configuration for one reusable policy.
func (r *PolicyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	policy := &api.GuardrailPolicy{}
	if err := r.Get(ctx, req.NamespacedName, policy); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	bundle, err := guardrails.CompilePolicy(ctx, r.Client, policy.Namespace, policy)
	status := api.GuardrailResourceStatus{
		ObservedGeneration: policy.Generation,
		State:              "Ready",
		Message:            "Configuration accepted; workloads report enforcement rollout separately.",
	}
	switch err {
	case nil:
		status.Revision = bundle.Revision
	default:
		status.State = "Error"
		status.Message = err.Error()
	}
	if !reflect.DeepEqual(policy.Status, status) {
		patch := client.MergeFrom(policy.DeepCopy())
		policy.Status = status
		if err := r.Status().Patch(ctx, policy, patch); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{RequeueAfter: time.Minute}, nil
}

// SetupWithManager registers policy and detector dependency watches.
func (r *PolicyReconciler) SetupWithManager(manager ctrl.Manager) error {
	dependencies := handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, _ client.Object) []reconcile.Request {
		list := &api.GuardrailPolicyList{}
		if err := r.List(ctx, list); err != nil {
			slog.ErrorContext(ctx, "list guardrail policies for connection change", "err", err)
			return nil
		}
		requests := make([]reconcile.Request, 0, len(list.Items))
		for _, policy := range list.Items {
			requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&policy)})
		}
		return requests
	})
	return ctrl.NewControllerManagedBy(manager).
		For(&api.GuardrailPolicy{}).
		Watches(&api.GuardrailConnection{}, dependencies).
		Named("guardrail-policy").Complete(r)
}
