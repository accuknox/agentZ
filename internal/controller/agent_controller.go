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

package controller

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"maps"
	"math"
	"net"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/yaml"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	agentconfig "github.com/accuknox/clawarmor/internal/agent/config"
)

const (
	configKey       = "config.yaml"
	configMountPath = "/etc/clawarmor/config.yaml"
	configVolume    = "config"

	nixAgentVolume = "nix-agent"
	nixAgentMount  = "/mnt/nix"
	nixLinkVolume  = "nix-link"
	nixLinkMount   = "/nix"
	nixLinkStage   = "/tmp/nix-link"
	nixInitImage   = "murtazau/clawarmor-nix-init:latest"
	nixPkgEnv      = "NIX_PACKAGES"
)

var (
	errImageEmpty  = errors.New("agent image must not be empty")
	errPortInvalid = errors.New("server.address must include a valid port")
)

// AgentRuntimeConfig configures controller-side launch defaults.
type AgentRuntimeConfig struct {
	DefaultImage string
	SharedNixPVC string
}

// AgentReconciler reconciles an Agent object.
type AgentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config AgentRuntimeConfig
}

// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=clawarmor.accuknox.com,namespace=clawarmor-system,resources=agents/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments/status,verbs=get
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;delete

// Reconcile moves the cluster state toward the desired Agent state.
func (r *AgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	agt := &clawarmorv1alpha1.Agent{}
	err := r.Get(ctx, req.NamespacedName, agt)
	if err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !agt.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	if agt.Spec.Image == "" && r.Config.DefaultImage == "" {
		err = errImageEmpty
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("invalid agent config: %w", err)
	}

	_, err = serverPort(agt.Spec.Server.Address)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("invalid agent config: %w", err)
	}

	cfgYAML, err := renderConfig(agt)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("render config: %w", err)
	}

	err = r.reconcileConfigMap(ctx, agt, string(cfgYAML))
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("reconcile configmap: %w", err)
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

	hash, err := configHash(cfgYAML, agt.Spec.Env)
	if err != nil {
		updateErr := r.setDegradedStatus(ctx, req.NamespacedName, agt.Generation, err)
		if updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("set degraded status: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("hash config: %w", err)
	}
	err = r.reconcileDeployment(ctx, agt, hash)
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
func (r *AgentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&clawarmorv1alpha1.Agent{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Named("agent").
		Complete(r)
}

func (r *AgentReconciler) reconcileConfigMap(ctx context.Context, agt *clawarmorv1alpha1.Agent, cfg string) error {
	current := &corev1.ConfigMap{}
	current.Name = agt.Name
	current.Namespace = agt.Namespace

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = resourceLabels(agt)
		current.Annotations = agt.Annotations
		current.Data = map[string]string{
			configKey: cfg,
		}
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch configmap: %w", err)
	}
	return nil
}

func (r *AgentReconciler) reconcileNixPVCs(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	if len(agt.Spec.Packages) == 0 {
		return nil
	}

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

func (r *AgentReconciler) reconcileService(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	desired, err := r.buildService(agt)
	if err != nil {
		return err
	}
	current := &corev1.Service{}
	current.Name = desired.Name
	current.Namespace = desired.Namespace

	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = desired.Labels
		current.Annotations = desired.Annotations
		current.Spec.Ports = desired.Spec.Ports
		current.Spec.Selector = desired.Spec.Selector
		current.Spec.Type = desired.Spec.Type
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch service: %w", err)
	}
	return nil
}

func (r *AgentReconciler) reconcileDeployment(ctx context.Context, agt *clawarmorv1alpha1.Agent, hash string) error {
	desired, err := r.buildDeployment(agt, hash)
	if err != nil {
		return err
	}
	err = ctrl.SetControllerReference(agt, desired, r.Scheme)
	if err != nil {
		return fmt.Errorf("set controller reference: %w", err)
	}

	current := &appsv1.Deployment{}
	err = r.Get(ctx, client.ObjectKeyFromObject(desired), current)
	if err != nil {
		if apierr.IsNotFound(err) {
			err = r.Create(ctx, desired)
			if err != nil {
				return fmt.Errorf("create deployment: %w", err)
			}
			return nil
		}
		return fmt.Errorf("get deployment: %w", err)
	}

	patch := client.MergeFrom(current.DeepCopy())
	current.Name = desired.Name
	current.Namespace = desired.Namespace
	current.Spec = desired.Spec
	if current.Labels == nil {
		current.Labels = map[string]string{}
	}
	if current.Annotations == nil {
		current.Annotations = map[string]string{}
	}
	maps.Copy(current.Labels, desired.Labels)
	maps.Copy(current.Annotations, desired.Annotations)

	err = r.Patch(ctx, current, patch)
	if err != nil {
		return fmt.Errorf("patch deployment: %w", err)
	}
	return nil
}

func (r *AgentReconciler) buildService(agt *clawarmorv1alpha1.Agent) (*corev1.Service, error) {
	port, err := serverPort(agt.Spec.Server.Address)
	if err != nil {
		return nil, err
	}

	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:        agt.Name,
			Namespace:   agt.Namespace,
			Labels:      resourceLabels(agt),
			Annotations: agt.Annotations,
		},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: selectorLabels(agt),
			Ports: []corev1.ServicePort{
				{
					Name:       "grpc",
					Port:       port,
					TargetPort: intstr.FromInt32(port),
					Protocol:   corev1.ProtocolTCP,
				},
			},
		},
	}, nil
}

func (r *AgentReconciler) buildDeployment(agt *clawarmorv1alpha1.Agent, hash string) (*appsv1.Deployment, error) {
	port, err := serverPort(agt.Spec.Server.Address)
	if err != nil {
		return nil, err
	}

	image := agt.Spec.Image
	if image == "" {
		image = r.Config.DefaultImage
	}

	labels := resourceLabels(agt)
	podLabels := make(map[string]string, len(labels))
	maps.Copy(podLabels, labels)

	podAnnotations := make(map[string]string, len(agt.Annotations)+2)
	maps.Copy(podAnnotations, agt.Annotations)
	podAnnotations["clawarmor.accuknox.com/config-hash"] = hash
	podAnnotations["kubearmor-visibility"] = "process,file"

	replicas := int32(1)
	grace := int64(0)
	timeout := agt.Spec.Server.GracefulShutdownTimeout.Duration
	if timeout > 0 {
		grace = int64(math.Ceil(timeout.Seconds()))
	}

	useNix := len(agt.Spec.Packages) > 0

	volumes := []corev1.Volume{
		{
			Name: configVolume,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{
						Name: agt.Name,
					},
				},
			},
		},
	}

	mainVolumeMounts := []corev1.VolumeMount{
		{
			Name:      configVolume,
			MountPath: configMountPath,
			SubPath:   configKey,
			ReadOnly:  true,
		},
	}

	mainEnv := make([]corev1.EnvVar, len(agt.Spec.Env))
	copy(mainEnv, agt.Spec.Env)

	var initContainers []corev1.Container

	if useNix {
		volumes = append(volumes,
			corev1.Volume{
				Name: nixAgentVolume,
				VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
						ClaimName: agt.Name + "-nix",
					},
				},
			},
			corev1.Volume{
				Name: nixLinkVolume,
				VolumeSource: corev1.VolumeSource{
					EmptyDir: &corev1.EmptyDirVolumeSource{},
				},
			},
		)
		initVolumeMounts := []corev1.VolumeMount{
			{Name: nixAgentVolume, MountPath: nixAgentMount},
			{Name: nixLinkVolume, MountPath: nixLinkStage},
		}
		initEnv := []corev1.EnvVar{
			{Name: nixPkgEnv, Value: strings.Join(agt.Spec.Packages, ",")},
		}

		if r.Config.SharedNixPVC != "" {
			volumes = append(volumes, corev1.Volume{
				Name: "nix-shared",
				VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
						ClaimName: r.Config.SharedNixPVC,
					},
				},
			})
			initVolumeMounts = append(initVolumeMounts,
				corev1.VolumeMount{Name: "nix-shared", MountPath: "/nix-shared"},
			)
			initEnv = append(initEnv,
				corev1.EnvVar{Name: "NIX_SHARED_PVC", Value: r.Config.SharedNixPVC},
			)
		}

		initContainers = append(initContainers, corev1.Container{
			Name:            "nix-init",
			Image:           nixInitImage,
			ImagePullPolicy: corev1.PullIfNotPresent,
			Env:             initEnv,
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: new(false),
				RunAsUser:                new(int64(0)),
				RunAsNonRoot:             new(false),
				Capabilities: &corev1.Capabilities{
					Drop: []corev1.Capability{"ALL"},
				},
			},
			VolumeMounts: initVolumeMounts,
		})

		mainVolumeMounts = append(mainVolumeMounts,
			corev1.VolumeMount{
				Name:      nixAgentVolume,
				MountPath: nixAgentMount,
				ReadOnly:  true,
			},
			corev1.VolumeMount{
				Name:      nixLinkVolume,
				MountPath: nixLinkMount,
			},
		)

		mainEnv = append(mainEnv,
			corev1.EnvVar{
				Name:  "NIX_PROFILES",
				Value: "/nix/profile",
			},
			corev1.EnvVar{
				Name:  "PATH",
				Value: "/nix/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			},
		)
	}

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:        agt.Name,
			Namespace:   agt.Namespace,
			Labels:      labels,
			Annotations: agt.Annotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: selectorLabels(agt),
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      podLabels,
					Annotations: podAnnotations,
				},
				Spec: corev1.PodSpec{
					AutomountServiceAccountToken:  new(false),
					TerminationGracePeriodSeconds: &grace,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: new(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes:        volumes,
					InitContainers: initContainers,
					Containers: []corev1.Container{
						{
							Name:            "agent",
							Image:           image,
							ImagePullPolicy: agt.Spec.ImagePullPolicy,
							WorkingDir:      agentconfig.DefaultHomeDir,
							Args: []string{
								"agent",
								"serve",
								"--config",
								configMountPath,
							},
							Env:       mainEnv,
							Resources: agt.Spec.Resources,
							Ports: []corev1.ContainerPort{
								{
									Name:          "grpc",
									ContainerPort: port,
									Protocol:      corev1.ProtocolTCP,
								},
							},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: new(false),
								ReadOnlyRootFilesystem:   new(true),
								RunAsNonRoot:             new(true),
								Capabilities: &corev1.Capabilities{
									Drop: []corev1.Capability{"ALL"},
								},
							},
							VolumeMounts: mainVolumeMounts,
						},
					},
					RestartPolicy: corev1.RestartPolicyAlways,
				},
			},
		},
	}, nil
}

func selectorLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":         "clawarmor-agent",
		"app.kubernetes.io/instance":     agt.Name,
		"clawarmor.accuknox.com/agent":   agt.Name,
		"clawarmor.accuknox.com/managed": "true",
	}
}

func resourceLabels(agt *clawarmorv1alpha1.Agent) map[string]string {
	labels := make(map[string]string, len(agt.Labels)+4)
	maps.Copy(labels, agt.Labels)
	maps.Copy(labels, selectorLabels(agt))
	return labels
}

func renderConfig(agt *clawarmorv1alpha1.Agent) ([]byte, error) {
	cfg := *agt.Spec.DeepCopy()
	cfg.Env = nil
	cfg.Server.GracefulShutdownTimeout = metav1.Duration{}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal yaml: %w", err)
	}
	return data, nil
}

func configHash(cfgYAML []byte, env []corev1.EnvVar) (string, error) {
	envYAML, err := yaml.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("marshal env yaml: %w", err)
	}
	sum := sha256.Sum256(append(cfgYAML, envYAML...))
	return fmt.Sprintf("%x", sum), nil
}

func serverPort(addr string) (int32, error) {
	_, rawPort, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return 0, errPortInvalid
	}
	port, err := strconv.ParseInt(rawPort, 10, 32)
	if err != nil || port <= 0 || port > 65535 {
		return 0, errPortInvalid
	}
	return int32(port), nil
}

func (r *AgentReconciler) updateAgentStatus(ctx context.Context, key types.NamespacedName) error {
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

		cm := &corev1.ConfigMap{}
		cmErr := r.Get(ctx, key, cm)
		if cmErr != nil && !apierr.IsNotFound(cmErr) {
			return fmt.Errorf("get configmap: %w", cmErr)
		}

		dep := &appsv1.Deployment{}
		depErr := r.Get(ctx, key, dep)
		if depErr != nil && !apierr.IsNotFound(depErr) {
			return fmt.Errorf("get deployment: %w", depErr)
		}

		port, portErr := serverPort(agt.Spec.Server.Address)
		if portErr != nil {
			port = 0
		}

		agt.Status.ServiceName = ""
		agt.Status.URL = ""
		if svcErr == nil {
			agt.Status.ServiceName = svc.Name
			agt.Status.URL = fmt.Sprintf(
				"http://%s.%s.svc.cluster.local:%d",
				svc.Name,
				svc.Namespace,
				port,
			)
		}
		agt.Status.ConfigMapName = ""
		if cmErr == nil {
			agt.Status.ConfigMapName = cm.Name
		}
		agt.Status.ObservedSessionID = agt.Spec.Session.ID
		agt.Status.ObservedGeneration = agt.Generation

		if dep.Name == "" {
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Waiting for deployment to be created",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
				Message:            "Deployment has not been created yet",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentCreating,
				Message:            "Agent is being created",
				ObservedGeneration: agt.Generation,
			})
			return r.Status().Update(ctx, agt)
		}

		if dep.Status.ReadyReplicas > 0 {
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
				Status:             metav1.ConditionTrue,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is ready",
				ObservedGeneration: agt.Generation,
			})
			agt.Status.SetCondition(metav1.Condition{
				Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
				Status:             metav1.ConditionFalse,
				Reason:             clawarmorv1alpha1.ReasonDeploymentReady,
				Message:            "Agent deployment is healthy",
				ObservedGeneration: agt.Generation,
			})
			return r.Status().Update(ctx, agt)
		}

		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentNotReady,
			Message:            "Waiting for agent pods to become ready",
			ObservedGeneration: agt.Generation,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionTrue,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Waiting for deployment rollout",
			ObservedGeneration: agt.Generation,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonDeploymentUpdating,
			Message:            "Agent deployment is progressing",
			ObservedGeneration: agt.Generation,
		})
		return r.Status().Update(ctx, agt)
	})
}

func (r *AgentReconciler) setDegradedStatus(ctx context.Context, key types.NamespacedName, gen int64, recErr error) error {
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		agt := &clawarmorv1alpha1.Agent{}
		err := r.Get(ctx, key, agt)
		if err != nil {
			return client.IgnoreNotFound(err)
		}

		agt.Status.ObservedSessionID = agt.Spec.Session.ID
		agt.Status.ObservedGeneration = gen
		reason := clawarmorv1alpha1.ReasonReconcileFailed
		if errors.Is(recErr, errImageEmpty) || errors.Is(recErr, errPortInvalid) {
			reason = clawarmorv1alpha1.ReasonConfigInvalid
		}
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeReady.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeProgressing.String(),
			Status:             metav1.ConditionFalse,
			Reason:             clawarmorv1alpha1.ReasonReconcileFailed,
			Message:            "Agent reconcile failed",
			ObservedGeneration: gen,
		})
		agt.Status.SetCondition(metav1.Condition{
			Type:               clawarmorv1alpha1.ConditionTypeDegraded.String(),
			Status:             metav1.ConditionTrue,
			Reason:             reason,
			Message:            recErr.Error(),
			ObservedGeneration: gen,
		})
		return r.Status().Update(ctx, agt)
	})
}
