// Package inferenceprovider reconciles provider credentials and AgentGateway
// runtime resources.
package inferenceprovider

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	externalsecretsv1 "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	baoapi "github.com/openbao/openbao/api/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/openbao"
	"github.com/accuknox/agentz/internal/scoperesolver"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ReconcilerConfig configures provider runtime and credential cleanup.
type ReconcilerConfig struct {
	StoreName               string
	RefreshInterval         time.Duration
	OpenBaoAddr             string
	ManagerOpenBaoAddr      string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

// Reconciler reconciles InferenceProvider runtime resources.
type Reconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Config   ReconcilerConfig
	Recorder events.EventRecorder
}

// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferenceproviders,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferenceproviders/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferenceproviders/finalizers,verbs=update
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=sandboxes,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferencepools,verbs=get;list;watch
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=workspaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaybackends,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agentgateway.dev,resources=agentgatewaypolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;delete

// Reconcile moves one provider's credentials and backend toward readiness.
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	provider := &agentzv1alpha1.InferenceProvider{}
	if err := r.Get(ctx, req.NamespacedName, provider); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !provider.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, provider)
	}
	if !ctrlutil.ContainsFinalizer(provider, agentzv1alpha1.InferenceProviderFinalizer) {
		patch := client.MergeFrom(provider.DeepCopy())
		ctrlutil.AddFinalizer(provider, agentzv1alpha1.InferenceProviderFinalizer)
		if err := r.Patch(ctx, provider, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add inference provider finalizer: %w", err)
		}
	}

	issues := inference.ValidateProvider(provider.Spec)
	if len(issues) > 0 {
		err := fmt.Errorf("provider configuration is invalid: %s", issues[0].Message)
		statusErr := r.updateStatus(ctx, provider, inference.Runtime{}, err)
		if r.Recorder != nil {
			r.Recorder.Eventf(
				provider,
				nil,
				corev1.EventTypeWarning,
				"InvalidConfiguration",
				"Reconcile",
				"%s", err.Error(),
			)
		}
		return ctrl.Result{}, statusErr
	}
	runtime, err := inference.RenderRuntime(
		provider,
		r.Config.StoreName,
		r.Config.RefreshInterval,
	)
	if err != nil {
		return ctrl.Result{}, errors.Join(err, r.updateStatus(ctx, provider, runtime, err))
	}
	if err := ctrlutil.SetControllerReference(provider, runtime.Backend, r.Scheme); err != nil {
		return ctrl.Result{}, fmt.Errorf("own inference backend: %w", err)
	}
	currentBackend := &agentgatewayv1alpha1.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: provider.Namespace},
	}
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, currentBackend, func() error {
		if currentBackend.UID != "" && !metav1.IsControlledBy(currentBackend, provider) {
			return errors.New("inference backend name is already in use")
		}
		currentBackend.Labels = runtime.Backend.Labels
		currentBackend.Spec = runtime.Backend.Spec
		return ctrlutil.SetControllerReference(provider, currentBackend, r.Scheme)
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile inference backend: %w", err)
	}
	runtime.Backend = currentBackend
	if runtime.AuthPolicy != nil {
		if err := ctrlutil.SetControllerReference(provider, runtime.AuthPolicy, r.Scheme); err != nil {
			return ctrl.Result{}, fmt.Errorf("own provider auth policy: %w", err)
		}
		currentPolicy := &agentgatewayv1alpha1.AgentgatewayPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name: runtime.AuthPolicy.Name, Namespace: provider.Namespace,
			},
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, currentPolicy, func() error {
			if currentPolicy.UID != "" && !metav1.IsControlledBy(currentPolicy, provider) {
				return errors.New("provider auth policy name is already in use")
			}
			currentPolicy.Spec = runtime.AuthPolicy.Spec
			return ctrlutil.SetControllerReference(provider, currentPolicy, r.Scheme)
		})
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("reconcile provider auth policy: %w", err)
		}
		runtime.AuthPolicy = currentPolicy
	}

	if runtime.ExternalSecret == nil {
		if err := r.deleteCredentialResources(ctx, provider); err != nil {
			return ctrl.Result{}, err
		}
	}
	if runtime.ExternalSecret != nil {
		err := ctrlutil.SetControllerReference(provider, runtime.ExternalSecret, r.Scheme)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("own provider external secret: %w", err)
		}
		currentExternalSecret := &externalsecretsv1.ExternalSecret{
			ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: provider.Namespace},
		}
		_, err = ctrlutil.CreateOrPatch(ctx, r.Client, currentExternalSecret, func() error {
			if currentExternalSecret.UID != "" && !metav1.IsControlledBy(currentExternalSecret, provider) {
				return errors.New("provider external secret name is already in use")
			}
			currentExternalSecret.Labels = runtime.ExternalSecret.Labels
			currentExternalSecret.Spec = runtime.ExternalSecret.Spec
			return ctrlutil.SetControllerReference(provider, currentExternalSecret, r.Scheme)
		})
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("reconcile provider external secret: %w", err)
		}
		runtime.ExternalSecret = currentExternalSecret
	}
	if r.Recorder != nil && runtime.ExternalSecret != nil && !externalSecretReady(runtime.ExternalSecret) {
		r.Recorder.Eventf(
			provider,
			nil,
			corev1.EventTypeWarning,
			"CredentialsNotReady",
			"Reconcile",
			"ExternalSecret has not materialized the expected credential keys",
		)
	}
	if r.Recorder != nil && !backendAccepted(runtime.Backend) {
		r.Recorder.Eventf(
			provider,
			nil,
			corev1.EventTypeWarning,
			"BackendNotReady",
			"Reconcile",
			"AgentGateway has not accepted the provider backend",
		)
	}
	return ctrl.Result{}, r.updateStatus(ctx, provider, runtime, nil)
}

func (r *Reconciler) reconcileDelete(ctx context.Context, provider *agentzv1alpha1.InferenceProvider) (ctrl.Result, error) {
	if !ctrlutil.ContainsFinalizer(provider, agentzv1alpha1.InferenceProviderFinalizer) {
		return ctrl.Result{}, nil
	}
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := r.List(
		ctx,
		sandboxes,
		client.MatchingFields{inference.SandboxByProviderIndex: provider.Name},
	)
	if err != nil {
		err = fmt.Errorf("list provider references before deletion: %w", err)
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "ReferenceCheckFailed", err),
		)
	}
	for i := range sandboxes.Items {
		for _, ref := range sandboxes.Items[i].Spec.Inference.Models {
			if ref.Provider != provider.Name {
				continue
			}
			ns, resolveErr := scoperesolver.SelectedNamespace(ctx, r.Client, sandboxes.Items[i].Namespace, scoperesolver.Selection{
				Scope: ref.Scope,
				Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
				Name:  ref.Provider,
			})
			if resolveErr == nil && ns == provider.Namespace {
				err := fmt.Errorf("provider is still referenced by sandbox %q", sandboxes.Items[i].Name)
				return ctrl.Result{RequeueAfter: 5 * time.Second}, r.blockDeletion(ctx, provider, "DeletionBlocked", err)
			}
		}
	}
	pools := &agentzv1alpha1.InferencePoolList{}
	err = r.List(
		ctx,
		pools,
		client.MatchingFields{inference.PoolByProviderIndex: provider.Name},
	)
	if err != nil {
		err = fmt.Errorf("list pool references before deletion: %w", err)
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "ReferenceCheckFailed", err),
		)
	}
	for i := range pools.Items {
		for _, ref := range pools.Items[i].Spec.Members {
			if ref.Provider != provider.Name {
				continue
			}
			ns, resolveErr := scoperesolver.SelectedNamespace(ctx, r.Client, pools.Items[i].Namespace, scoperesolver.Selection{
				Scope: ref.Scope,
				Kind:  agentzv1alpha1.OrganizationResourceKindInferenceProvider,
				Name:  ref.Provider,
			})
			if resolveErr == nil && ns == provider.Namespace {
				err := fmt.Errorf("provider is still referenced by pool %q", pools.Items[i].Name)
				return ctrl.Result{RequeueAfter: 5 * time.Second}, r.blockDeletion(ctx, provider, "DeletionBlocked", err)
			}
		}
	}
	if err := r.deleteCredentialResources(ctx, provider); err != nil {
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "FinalizerCleanupFailed", err),
		)
	}
	backend := &agentgatewayv1alpha1.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: provider.Namespace},
	}
	err = r.Get(ctx, client.ObjectKeyFromObject(backend), backend)
	if err == nil && !metav1.IsControlledBy(backend, provider) {
		err := errors.New("inference backend name is owned by another resource")
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "FinalizerCleanupFailed", err),
		)
	}
	switch {
	case err == nil:
		if err := r.Delete(ctx, backend); err != nil && !apierrors.IsNotFound(err) {
			err = fmt.Errorf("delete inference backend: %w", err)
			return ctrl.Result{}, errors.Join(
				err,
				r.blockDeletion(ctx, provider, "FinalizerCleanupFailed", err),
			)
		}
	case !apierrors.IsNotFound(err):
		err = fmt.Errorf("read inference backend for cleanup: %w", err)
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "FinalizerCleanupFailed", err),
		)
	}
	controlled := []client.Object{
		&externalsecretsv1.ExternalSecret{},
		&corev1.Secret{},
		&agentgatewayv1alpha1.AgentgatewayBackend{},
	}
	for _, obj := range controlled {
		err := r.Get(ctx, client.ObjectKeyFromObject(provider), obj)
		if err == nil {
			return ctrl.Result{RequeueAfter: 500 * time.Millisecond}, nil
		}
		if !apierrors.IsNotFound(err) {
			err = fmt.Errorf("confirm provider runtime cleanup: %w", err)
			return ctrl.Result{}, errors.Join(
				err,
				r.blockDeletion(ctx, provider, "FinalizerCleanupFailed", err),
			)
		}
	}
	kv, err := r.openBaoMetadata(ctx)
	if err != nil {
		err = fmt.Errorf("create openbao client for provider cleanup: %w", err)
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "FinalizerOpenBaoFailed", err),
		)
	}
	path := inference.CredentialPath(
		provider.Namespace,
		provider.Name,
		provider.Spec.Kind,
	)
	if err := kv.DeleteMetadata(ctx, path); err != nil && !errors.Is(err, baoapi.ErrSecretNotFound) {
		err = fmt.Errorf("delete inference credential metadata: %w", err)
		return ctrl.Result{}, errors.Join(
			err,
			r.blockDeletion(ctx, provider, "FinalizerOpenBaoFailed", err),
		)
	}
	patch := client.MergeFrom(provider.DeepCopy())
	ctrlutil.RemoveFinalizer(provider, agentzv1alpha1.InferenceProviderFinalizer)
	if err := r.Patch(ctx, provider, patch); err != nil && !apierrors.IsNotFound(err) {
		return ctrl.Result{}, fmt.Errorf("remove inference provider finalizer: %w", err)
	}
	return ctrl.Result{}, nil
}

func (r *Reconciler) blockDeletion(ctx context.Context, provider *agentzv1alpha1.InferenceProvider, reason string, reconcileErr error) error {
	message := "Provider cleanup is blocked"
	if reason == "DeletionBlocked" {
		message = reconcileErr.Error()
	}
	if r.Recorder != nil {
		r.Recorder.Eventf(
			provider,
			nil,
			corev1.EventTypeWarning,
			reason,
			"Delete",
			"%s",
			message,
		)
	}
	statusErr := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.InferenceProvider{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(provider), current); err != nil {
			return client.IgnoreNotFound(err)
		}
		current.Status.State = agentzv1alpha1.InferenceProviderStateDegraded
		current.Status.ObservedGeneration = current.Generation
		meta.SetStatusCondition(&current.Status.Conditions, metav1.Condition{
			Type:               string(agentzv1alpha1.InferenceProviderConditionReady),
			Status:             metav1.ConditionFalse,
			Reason:             reason,
			Message:            message,
			ObservedGeneration: current.Generation,
		})
		return r.Status().Update(ctx, current)
	})
	return statusErr
}

func (r *Reconciler) deleteCredentialResources(ctx context.Context, provider *agentzv1alpha1.InferenceProvider) error {
	externalSecret := &externalsecretsv1.ExternalSecret{
		ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: provider.Namespace},
	}
	err := r.Get(ctx, client.ObjectKeyFromObject(externalSecret), externalSecret)
	if err == nil && !metav1.IsControlledBy(externalSecret, provider) {
		return errors.New("provider external secret name is owned by another resource")
	}
	var externalSecretUID types.UID
	switch {
	case err == nil:
		externalSecretUID = externalSecret.UID
	case !apierrors.IsNotFound(err):
		return fmt.Errorf("read provider external secret for cleanup: %w", err)
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: provider.Namespace},
	}
	err = r.Get(ctx, client.ObjectKeyFromObject(secret), secret)
	switch {
	case err == nil:
		owner := metav1.GetControllerOf(secret)
		if externalSecretUID == "" || owner == nil {
			return errors.New("provider target secret name is owned by another resource")
		}
		if owner.UID != externalSecretUID || owner.Kind != externalsecretsv1.ExtSecretKind {
			return errors.New("provider target secret name is owned by another resource")
		}
		if err := r.Delete(ctx, secret); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete stale provider target secret: %w", err)
		}
	case !apierrors.IsNotFound(err):
		return fmt.Errorf("read provider target secret for cleanup: %w", err)
	}
	if externalSecretUID != "" {
		if err := r.Delete(ctx, externalSecret); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete stale provider external secret: %w", err)
		}
	}
	return nil
}

func (r *Reconciler) updateStatus(ctx context.Context, provider *agentzv1alpha1.InferenceProvider, runtime inference.Runtime, reconcileErr error) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current := &agentzv1alpha1.InferenceProvider{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(provider), current); err != nil {
			return client.IgnoreNotFound(err)
		}
		status := current.Status
		status.ObservedGeneration = current.Generation
		status.ModelCount = len(current.Spec.Models)
		acceptedStatus := metav1.ConditionTrue
		acceptedReason := "Accepted"
		acceptedMessage := "Provider settings are valid"
		if reconcileErr != nil {
			acceptedStatus = metav1.ConditionFalse
			acceptedReason = "InvalidConfiguration"
			acceptedMessage = "Check the provider settings and try again"
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type:   string(agentzv1alpha1.InferenceProviderConditionAccepted),
			Status: acceptedStatus, Reason: acceptedReason, Message: acceptedMessage,
			ObservedGeneration: current.Generation,
		})

		credentialsReady := reconcileErr == nil && runtime.ExternalSecret == nil
		credentialsMessage := "Authentication is not required"
		isCodex := current.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		isCopilot := current.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
		if isCodex || isCopilot {
			credentialsMessage = "Subscription is connected"
		}
		if reconcileErr != nil {
			credentialsMessage = "Authentication setup is incomplete"
		}
		if runtime.ExternalSecret != nil {
			credentialsReady = externalSecretReady(runtime.ExternalSecret)
			credentialsMessage = "Authentication is still being prepared"
			secret := &corev1.Secret{}
			err := r.Get(ctx, types.NamespacedName{Name: current.Name, Namespace: current.Namespace}, secret)
			switch {
			case err == nil:
				keysReady := hasKeys(secret, runtime.SecretKeys)
				credentialsReady = credentialsReady && keysReady
				if !keysReady && r.Recorder != nil {
					r.Recorder.Eventf(
						current,
						nil,
						corev1.EventTypeWarning,
						"CredentialKeysMissing",
						"Reconcile",
						"Target Secret is missing one or more expected credential keys",
					)
				}
			case !apierrors.IsNotFound(err):
				return fmt.Errorf("read provider target secret status: %w", err)
			default:
				credentialsReady = false
			}
			if credentialsReady {
				credentialsMessage = "Authentication is ready"
			}
		}
		setReadyCondition(
			&status.Conditions,
			string(agentzv1alpha1.InferenceProviderConditionCredentialsReady),
			credentialsReady,
			credentialsMessage,
			current.Generation,
		)

		backendReady := backendAccepted(runtime.Backend)
		backendMessage := "Provider connection is still being prepared"
		if backendReady {
			backendMessage = "Provider connection is ready"
		}
		setReadyCondition(
			&status.Conditions,
			string(agentzv1alpha1.InferenceProviderConditionBackendReady),
			backendReady,
			backendMessage,
			current.Generation,
		)
		ready := reconcileErr == nil && credentialsReady && backendReady
		message := "Provider is ready"
		if !ready {
			message = "Provider setup is still in progress"
		}
		setReadyCondition(
			&status.Conditions,
			string(agentzv1alpha1.InferenceProviderConditionReady),
			ready,
			message,
			current.Generation,
		)
		status.State = agentzv1alpha1.InferenceProviderStateAccepted
		if ready {
			status.State = agentzv1alpha1.InferenceProviderStateReady
		}
		if reconcileErr != nil {
			status.State = agentzv1alpha1.InferenceProviderStateDegraded
		}
		if reflect.DeepEqual(current.Status, status) {
			return nil
		}
		current.Status = status
		return r.Status().Update(ctx, current)
	})
}

func externalSecretReady(secret *externalsecretsv1.ExternalSecret) bool {
	for _, condition := range secret.Status.Conditions {
		if condition.Type == externalsecretsv1.ExternalSecretReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func backendAccepted(backend *agentgatewayv1alpha1.AgentgatewayBackend) bool {
	if backend == nil {
		return false
	}
	for _, condition := range backend.Status.Conditions {
		if condition.Type == "Accepted" {
			return condition.Status == metav1.ConditionTrue
		}
	}
	return false
}

func hasKeys(secret *corev1.Secret, keys []string) bool {
	for _, key := range keys {
		if _, exists := secret.Data[key]; !exists {
			return false
		}
	}
	return true
}

func setReadyCondition(conditions *[]metav1.Condition, conditionType string, ready bool, message string, generation int64) {
	status := metav1.ConditionFalse
	reason := "Pending"
	if ready {
		status = metav1.ConditionTrue
		reason = "Ready"
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: conditionType, Status: status, Reason: reason, Message: message,
		ObservedGeneration: generation,
	})
}

func (r *Reconciler) openBaoMetadata(ctx context.Context) (*baoapi.KVv2, error) {
	addr := strings.TrimSpace(r.Config.ManagerOpenBaoAddr)
	if addr == "" {
		addr = strings.TrimSpace(r.Config.OpenBaoAddr)
	}
	mountPath := strings.TrimSpace(r.Config.OpenBaoSecretMountPath)
	authRole := strings.TrimSpace(r.Config.OpenBaoK8sAuthRole)
	if addr == "" || mountPath == "" || authRole == "" {
		return nil, fmt.Errorf("complete manager openbao configuration is required")
	}
	bao, err := openbao.NewClient(
		ctx,
		addr,
		r.Config.OpenBaoK8sAuthRole,
		r.Config.OpenBaoK8sAuthMountPath,
		r.Config.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return nil, err
	}
	return bao.KVv2(r.Config.OpenBaoSecretMountPath), nil
}

// SetupWithManager registers provider and owned-resource watches.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	if strings.TrimSpace(r.Config.StoreName) == "" {
		return fmt.Errorf("inference provider secret store name is required")
	}
	if r.Config.RefreshInterval <= 0 {
		return fmt.Errorf("inference provider secret refresh interval is required")
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentzv1alpha1.InferenceProvider{}).
		Owns(&externalsecretsv1.ExternalSecret{}).
		Owns(&agentgatewayv1alpha1.AgentgatewayBackend{}).
		Owns(&agentgatewayv1alpha1.AgentgatewayPolicy{}).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.providerForSecret)).
		Watches(&agentzv1alpha1.Sandbox{}, handler.EnqueueRequestsFromMapFunc(r.providersForSandbox)).
		Named("inference-provider").
		Complete(r)
}

func (r *Reconciler) providersForSandbox(_ context.Context, obj client.Object) []reconcile.Request {
	sandbox := obj.(*agentzv1alpha1.Sandbox)
	providers := make(map[string]struct{}, len(sandbox.Spec.Inference.Models))
	requests := make([]reconcile.Request, 0, len(sandbox.Spec.Inference.Models))
	for _, model := range sandbox.Spec.Inference.Models {
		if _, exists := providers[model.Provider]; exists {
			continue
		}
		providers[model.Provider] = struct{}{}
		requests = append(requests, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: sandbox.Namespace,
			Name:      model.Provider,
		}})
	}
	return requests
}

func (r *Reconciler) providerForSecret(ctx context.Context, obj client.Object) []reconcile.Request {
	providerName := obj.GetLabels()[inference.ProviderLabel]
	if providerName == "" {
		return nil
	}
	provider := &agentzv1alpha1.InferenceProvider{}
	key := types.NamespacedName{Name: providerName, Namespace: obj.GetNamespace()}
	if err := r.Get(ctx, key, provider); err != nil {
		if !apierrors.IsNotFound(err) {
			slog.ErrorContext(ctx, "resolve provider target secret", slog.Any("err", err))
		}
		return nil
	}
	return []reconcile.Request{{NamespacedName: key}}
}
