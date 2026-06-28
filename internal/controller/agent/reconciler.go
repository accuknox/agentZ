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

package agent

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/accuknox/clawarmor/internal/envutil"
	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// Reconciler reconciles an Agent object.
type Reconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config RuntimeConfig
	Bao    OpenBaoProvisioner
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents,verbs=create-workflow;create-workflow-schedule;delete-workflow-schedule;delete-workflows;get-workflow;list-workflow-schedules;list-workflows;set-workflowrun-status;update-workflow-schedule
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=agents/finalizers,verbs=update
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,resources=envs,verbs=get;list;watch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments/status,verbs=get
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cilium.io,resources=ciliumnetworkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete

// Reconcile moves the cluster state toward the desired Agent state.
//
//nolint:gocyclo
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	agt := &clawarmorv1alpha1.Agent{}
	err := r.Get(ctx, req.NamespacedName, agt)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !agt.DeletionTimestamp.IsZero() {
		if ctrlutil.ContainsFinalizer(agt, sinjectorFinalizer) {
			if err := r.cleanupSinjector(ctx, agt); err != nil {
				return ctrl.Result{}, fmt.Errorf("cleanup sinjector: %w", err)
			}
			patch := client.MergeFrom(agt.DeepCopy())
			ctrlutil.RemoveFinalizer(agt, sinjectorFinalizer)
			if err := r.Patch(ctx, agt, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("remove sinjector finalizer: %w", err)
			}
		}
		return ctrl.Result{}, nil
	}

	if agt.Spec.Image == "" && r.Config.AgentDefaultImage == "" {
		err = errImageEmpty
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("invalid agent config: %w", err)
	}

	envCfg, err := r.resolveEnvironment(ctx, agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("resolve environment: %w", err)
	}

	var opencodeCfg []byte
	var instruction string

	opencodeCfg, instruction, err = renderOpencodeConfig(agt, envCfg)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("render opencode config: %w", err)
	}

	err = r.reconcileConfigMap(ctx, agt, string(opencodeCfg), instruction)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile configmap: %w", err)
	}

	err = r.reconcileServiceAccount(ctx, agt, agt.Name, resourceLabels(agt))
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile agent serviceaccount: %w", err)
	}
	err = r.reconcileGatewayAccess(ctx, agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile agent gateway access: %w", err)
	}

	err = r.reconcileService(ctx, agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile service: %w", err)
	}

	err = r.reconcileNixPVCs(ctx, agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile nix pvcs: %w", err)
	}

	if !ctrlutil.ContainsFinalizer(agt, sinjectorFinalizer) {
		patch := client.MergeFrom(agt.DeepCopy())
		ctrlutil.AddFinalizer(agt, sinjectorFinalizer)
		if err := r.Patch(ctx, agt, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("add sinjector finalizer: %w", err)
		}
	}

	err = r.reconcileSinjector(ctx, agt, envCfg.AllowedHosts)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile sinjector: %w", err)
	}
	ready, err := r.sinjectorReady(ctx, agt)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("check sinjector readiness: %w", err)
	}
	if !ready {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}

	err = r.reconcileEgressPolicy(ctx, agt, envCfg)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile egress policy: %w", err)
	}

	jobReady, err := r.reconcilePackageJob(ctx, agt, envCfg.Packages)
	if err != nil {
		if deleteErr := r.deleteDeployment(ctx, agt); deleteErr != nil {
			return ctrl.Result{}, fmt.Errorf("delete deployment: %w", deleteErr)
		}
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile package job: %w", err)
	}
	if !jobReady {
		err = r.deleteDeployment(ctx, agt)
		if err != nil {
			updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
			if updateErr != nil {
				return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
			}
			return ctrl.Result{}, fmt.Errorf("delete deployment: %w", err)
		}
		err = r.updateAgentStatus(ctx, req.NamespacedName)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("update agent status: %w", err)
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}

	hash := configHash(opencodeCfg, agt.Spec.Env, envCfg)
	err = r.reconcileDeployment(ctx, agt, hash, envCfg.Packages, true)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile deployment: %w", err)
	}

	err = r.updateAgentStatus(ctx, req.NamespacedName)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("update agent status: %w", err)
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Agent{}).
		Watches(&clawarmorv1alpha1.Environment{}, handler.EnqueueRequestsFromMapFunc(r.agentsForEnvironment)).
		Owns(&appsv1.Deployment{}).
		Owns(&batchv1.Job{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&rbacv1.Role{}).
		Owns(&rbacv1.RoleBinding{}).
		Owns(&ciliumv2.CiliumNetworkPolicy{}).
		Named("agent").
		Complete(r)
}

type environmentConfig struct {
	Packages                []string
	AllowedHosts            []string
	MCPURL                  string
	MCPConsentPermissionIDs []string
	MCPRefs                 []mcpRefConfig
}

type mcpRefConfig struct {
	Name  string
	Tools []mcpToolConfig
}

type mcpToolConfig struct {
	Name           string
	RequireConsent bool
}

func (r *Reconciler) resolveEnvironment(ctx context.Context, agt *clawarmorv1alpha1.Agent) (environmentConfig, error) {
	ref := agt.Spec.EnvironmentRef
	if ref == nil {
		return environmentConfig{
			Packages:                []string{},
			AllowedHosts:            []string{},
			MCPURL:                  "",
			MCPConsentPermissionIDs: []string{},
			MCPRefs:                 []mcpRefConfig{},
		}, nil
	}

	env := &clawarmorv1alpha1.Environment{}
	key := types.NamespacedName{Name: ref.Name, Namespace: agt.Namespace}
	if err := r.Get(ctx, key, env); err != nil {
		return environmentConfig{}, fmt.Errorf("get environment %q: %w", ref.Name, err)
	}
	packages := make([]string, 0, len(env.Spec.Packages))
	for _, pkg := range env.Spec.Packages {
		pkg = strings.TrimSpace(pkg)
		if pkg == "" {
			continue
		}
		packages = append(packages, pkg)
	}
	slices.Sort(packages)
	packages = slices.Compact(packages)
	allowedHosts := make([]string, len(env.Spec.AllowedHosts))
	copy(allowedHosts, env.Spec.AllowedHosts)
	mcpConsentPermissionIDs := make([]string, 0, len(env.Spec.MCPConnectionRefs))
	mcpRefs := make([]mcpRefConfig, 0, len(env.Spec.MCPConnectionRefs))
	for _, ref := range env.Spec.MCPConnectionRefs {
		tools := make([]mcpToolConfig, 0, len(ref.Tools))
		for _, tool := range ref.Tools {
			tools = append(tools, mcpToolConfig{
				Name:           tool.Name,
				RequireConsent: tool.RequireConsent,
			})
			if !tool.RequireConsent {
				continue
			}
			mcpConsentPermissionIDs = append(
				mcpConsentPermissionIDs,
				ref.Name+"_"+tool.Name,
			)
		}
		mcpRefs = append(mcpRefs, mcpRefConfig{
			Name:  ref.Name,
			Tools: tools,
		})
	}
	slices.Sort(mcpConsentPermissionIDs)
	return environmentConfig{
		Packages:                packages,
		AllowedHosts:            allowedHosts,
		MCPURL:                  r.environmentMCPURL(ctx, agt.Namespace, env),
		MCPConsentPermissionIDs: mcpConsentPermissionIDs,
		MCPRefs:                 mcpRefs,
	}, nil
}

func (r *Reconciler) environmentMCPURL(ctx context.Context, namespace string, env *clawarmorv1alpha1.Environment) string {
	conns, err := mcp.LoadConnections(ctx, r.Client, env)
	if err != nil || len(conns) == 0 {
		return ""
	}
	return fmt.Sprintf(
		"http://%s.%s.svc.cluster.local%s",
		mcp.GatewayName,
		namespace,
		mcp.EnvironmentRoutePath(env.Name),
	)
}

func (r *Reconciler) agentsForEnvironment(ctx context.Context, obj client.Object) []reconcile.Request {
	env, ok := obj.(*clawarmorv1alpha1.Environment)
	if !ok {
		return []reconcile.Request{}
	}

	agents := &clawarmorv1alpha1.AgentList{}
	err := r.List(
		ctx,
		agents,
		client.InNamespace(env.Namespace),
		client.MatchingFields{envutil.AgentByEnvironmentIndex: env.Name},
	)
	if err != nil {
		return []reconcile.Request{}
	}

	requests := []reconcile.Request{}
	for _, agt := range agents.Items {
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Name:      agt.Name,
				Namespace: agt.Namespace,
			},
		})
	}
	return requests
}

func (r *Reconciler) reconcileNixPVCs(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	agentPVC := &corev1.PersistentVolumeClaim{}
	agentPVC.Name = agt.Name + "-nix"
	agentPVC.Namespace = agt.Namespace
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, agentPVC, func() error {
		agentPVC.Labels = resourceLabels(agt)
		if len(agentPVC.Spec.AccessModes) == 0 {
			agentPVC.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{
				corev1.ReadWriteOnce,
			}
		}
		if agentPVC.Spec.Resources.Requests == nil {
			size := agt.Spec.NixStoreSize
			if size.IsZero() {
				size = resource.MustParse("5Gi")
			}
			agentPVC.Spec.Resources.Requests = corev1.ResourceList{
				corev1.ResourceStorage: size,
			}
		}
		return ctrl.SetControllerReference(agt, agentPVC, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("ensure agent nix pvc: %w", err)
	}
	return nil
}

func (r *Reconciler) proxyAddress(agt *clawarmorv1alpha1.Agent) string {
	return fmt.Sprintf(
		"http://%s.%s.svc.cluster.local:%d",
		sinjectorName(agt),
		agt.Namespace,
		4096,
	)
}

func (r *Reconciler) updateAgentStatus(ctx context.Context, key types.NamespacedName) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt := &clawarmorv1alpha1.Agent{}
		err := r.Get(ctx, key, agt)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		svc := &corev1.Service{}
		svcErr := r.Get(ctx, key, svc)
		if svcErr != nil && !apierr.IsNotFound(svcErr) {
			return fmt.Errorf("get service: %w", svcErr)
		}

		job := &batchv1.Job{}
		jobErr := r.Get(ctx, types.NamespacedName{
			Name:      packageJobName(agt),
			Namespace: agt.Namespace,
		}, job)
		if jobErr != nil && !apierr.IsNotFound(jobErr) {
			return fmt.Errorf("get package job: %w", jobErr)
		}

		dep := &appsv1.Deployment{}
		depErr := r.Get(ctx, key, dep)
		if depErr != nil && !apierr.IsNotFound(depErr) {
			return fmt.Errorf("get deployment: %w", depErr)
		}

		status := agt.Status.DeepCopy()
		status.ServiceName = ""
		status.URL = ""
		if svcErr == nil {
			status.ServiceName = svc.Name
			status.URL = fmt.Sprintf(
				"http://%s.%s.svc.cluster.local:%d",
				svc.Name,
				svc.Namespace,
				4096,
			)
		}
		status.ObservedGeneration = agt.Generation
		writeStatus := func() error {
			if reflect.DeepEqual(agt.Status, *status) {
				return nil
			}
			patch := client.MergeFrom(agt.DeepCopy())
			agt.Status = *status
			return r.Status().Patch(ctx, agt, patch)
		}

		if job.Name == "" {
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobCreating,
				Message:            "Waiting for package job to be created",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonPackageJobCreating,
				Message:            "Waiting for package job to be created",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobCreating,
				Message:            "Package preparation has not started yet",
				ObservedGeneration: agt.Generation,
			})
			return writeStatus()
		}

		failed := findJobCondition(job, batchv1.JobFailed)
		if failed != nil && failed.Status == corev1.ConditionTrue {
			message := strings.TrimSpace(failed.Message)
			if message == "" {
				message = strings.TrimSpace(failed.Reason)
			}
			if message == "" {
				message = "package preparation job failed"
			}
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobFailed,
				Message:            "Package preparation job failed",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobFailed,
				Message:            "Package preparation job failed",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonPackageJobFailed,
				Message:            message,
				ObservedGeneration: agt.Generation,
			})
			return writeStatus()
		}

		complete := findJobCondition(job, batchv1.JobComplete)
		if complete == nil || complete.Status != corev1.ConditionTrue {
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobRunning,
				Message:            "Waiting for package job to complete",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonPackageJobRunning,
				Message:            "Waiting for package job to complete",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonPackageJobRunning,
				Message:            "Package preparation is still running",
				ObservedGeneration: agt.Generation,
			})
			return writeStatus()
		}

		if dep.Name == "" {
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Waiting for deployment to be created",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
				Message:            "Deployment has not been created yet",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Agent is being created",
				ObservedGeneration: agt.Generation,
			})
			return writeStatus()
		}

		if dep.Status.ReadyReplicas > 0 {
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is healthy",
				ObservedGeneration: agt.Generation,
			})
			return writeStatus()
		}

		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
			Message:            "Waiting for agent pods to become ready",
			ObservedGeneration: agt.Generation,
		})
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Waiting for deployment rollout",
			ObservedGeneration: agt.Generation,
		})
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Agent deployment is progressing",
			ObservedGeneration: agt.Generation,
		})
		return writeStatus()
	})
}

func (r *Reconciler) setDegradedStatus(ctx context.Context, key types.NamespacedName, gen int64, recErr error) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt := &clawarmorv1alpha1.Agent{}
		err := r.Get(ctx, key, agt)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		status := agt.Status.DeepCopy()
		status.ObservedGeneration = gen
		reason := clawarmorv1alpha1.ReasonReconcileFailed
		if errors.Is(recErr, errImageEmpty) {
			reason = clawarmorv1alpha1.ReasonConfigInvalid
		}
		if errors.Is(recErr, errPackageJobFailed) {
			reason = clawarmorv1alpha1.ReasonPackageJobFailed
		}
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionTrue,
			Reason:             reason,
			Message:            recErr.Error(),
			ObservedGeneration: gen,
		})
		if reflect.DeepEqual(agt.Status, *status) {
			return nil
		}
		patch := client.MergeFrom(agt.DeepCopy())
		agt.Status = *status
		return r.Status().Patch(ctx, agt, patch)
	})
}
