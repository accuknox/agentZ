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
	"fmt"
	"maps"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

func (r *Reconciler) reconcileConfigMap(ctx context.Context, agt *clawarmorv1alpha1.Agent, opencodeCfg string, instruction string) error {
	if opencodeCfg == "" {
		current := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      agt.Name,
				Namespace: agt.Namespace,
			},
		}
		err := r.Delete(ctx, current)
		if err != nil && !apierr.IsNotFound(err) {
			return fmt.Errorf("delete configmap: %w", err)
		}
		return nil
	}

	current := &corev1.ConfigMap{}
	current.Name = agt.Name
	current.Namespace = agt.Namespace

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = resourceLabels(agt)
		current.Annotations = agt.Annotations
		current.Data = map[string]string{opencodeConfigKey: opencodeCfg}
		if instruction != "" {
			current.Data[opencodeInstructionKey] = instruction
		}
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch configmap: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileService(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	desired := r.buildService(agt)
	current := &corev1.Service{}
	current.Name = desired.Name
	current.Namespace = desired.Namespace

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
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

func (r *Reconciler) reconcileDeployment(ctx context.Context, agt *clawarmorv1alpha1.Agent, hash string, packages []string, mountConfig bool) error {
	desired := r.buildDeployment(agt, hash, packages, mountConfig)
	if err := ctrl.SetControllerReference(agt, desired, r.Scheme); err != nil {
		return fmt.Errorf("set controller reference: %w", err)
	}

	current := &appsv1.Deployment{}
	err := r.Get(ctx, client.ObjectKeyFromObject(desired), current)
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

func (r *Reconciler) buildService(agt *clawarmorv1alpha1.Agent) *corev1.Service {
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
					Name:       "http",
					Port:       4096,
					TargetPort: intstr.FromInt32(4096),
					Protocol:   corev1.ProtocolTCP,
				},
			},
		},
	}
}

func (r *Reconciler) buildDeployment(agt *clawarmorv1alpha1.Agent, hash string, packages []string, mountConfig bool) *appsv1.Deployment {
	image := agt.Spec.Image
	if image == "" {
		image = r.Config.AgentDefaultImage
	}

	labels := resourceLabels(agt)
	podLabels := make(map[string]string, len(labels))
	maps.Copy(podLabels, labels)

	podAnnotations := make(map[string]string, len(agt.Annotations)+2)
	maps.Copy(podAnnotations, agt.Annotations)
	podAnnotations["clawarmor.accuknox.com/config-hash"] = hash
	podAnnotations["kubearmor-visibility"] = "process,file"

	replicas := int32(1)
	var automount bool
	var serviceAccountName string
	var volumes []corev1.Volume
	var volumeMounts []corev1.VolumeMount
	var initContainers []corev1.Container
	claimName := agt.Name + "-nix"

	agentInitImage := r.Config.AgentInitImage
	if agentInitImage == "" {
		agentInitImage = nixInitImage
	}

	volumes = append(volumes, corev1.Volume{
		Name: nixAgentVolume,
		VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: claimName,
			},
		},
	})
	initContainers = append(initContainers, corev1.Container{
		Name:            homeInitName,
		Image:           agentInitImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Command: []string{
			"/bin/bash",
			"-lc",
			"mkdir -p /pvc/home /pvc/nix",
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: new(false),
			RunAsUser:                new(int64(1000)),
			RunAsGroup:               new(int64(1000)),
			RunAsNonRoot:             new(true),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
		},
		VolumeMounts: []corev1.VolumeMount{{
			Name:      nixAgentVolume,
			MountPath: nixVolumeRootMount,
		}},
	})
	volumeMounts = append(volumeMounts, corev1.VolumeMount{
		Name:      nixAgentVolume,
		MountPath: "/home/clawarmor",
		SubPath:   nixHomeSubPath,
	})

	if mountConfig {
		volumes = append(volumes, corev1.Volume{
			Name: configVolume,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{
						Name: agt.Name,
					},
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      configVolume,
			MountPath: opencodeConfigDir,
			ReadOnly:  true,
		})
	}

	if r.sinjectorEnabled() {
		serviceAccountName = agt.Name
		bundleKey := r.Config.SinjectorCASecretBundleKey
		volumes = append(volumes, corev1.Volume{
			Name: sinjectorCAVolume,
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: r.Config.SinjectorCASecretName,
					Items: []corev1.KeyToPath{{
						Key:  bundleKey,
						Path: "ca.crt",
					}},
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      sinjectorCAVolume,
			MountPath: sinjectorCAMountPath,
			ReadOnly:  true,
		})
	}

	if len(packages) > 0 {
		volumes = append(volumes,
			corev1.Volume{
				Name: nixLinkVolume,
				VolumeSource: corev1.VolumeSource{
					EmptyDir: &corev1.EmptyDirVolumeSource{},
				},
			},
			corev1.Volume{
				Name: nixRuntimeStoreVolume,
				VolumeSource: corev1.VolumeSource{
					EmptyDir: &corev1.EmptyDirVolumeSource{},
				},
			},
		)
		initVolumeMounts := []corev1.VolumeMount{
			{Name: nixAgentVolume, MountPath: nixAgentMount, SubPath: nixStoreSubPath},
			{Name: nixLinkVolume, MountPath: nixLinkStage},
			{Name: nixRuntimeStoreVolume, MountPath: nixRuntimeStageMount},
		}
		initEnv := []corev1.EnvVar{
			{Name: nixPkgEnv, Value: strings.Join(packages, ",")},
		}

		initContainers = append(initContainers, corev1.Container{
			Name:            "nix-store-init",
			Image:           image,
			ImagePullPolicy: agt.Spec.ImagePullPolicy,
			Command: []string{
				"/bin/sh",
				"-lc",
				// Seed the shared runtime store with the agent image's own closures
				// before nix-init links package closures into the same namespace.
				"cp -a /nix/store/. " + nixRuntimeStageMount + "/",
			},
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: new(false),
				RunAsUser:                new(int64(0)),
				RunAsGroup:               new(int64(0)),
				RunAsNonRoot:             new(false),
				Capabilities: &corev1.Capabilities{
					Drop: []corev1.Capability{"ALL"},
				},
			},
			VolumeMounts: []corev1.VolumeMount{{
				Name:      nixRuntimeStoreVolume,
				MountPath: nixRuntimeStageMount,
			}},
		})

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
			Image:           agentInitImage,
			ImagePullPolicy: corev1.PullIfNotPresent,
			Env:             initEnv,
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: new(false),
				RunAsUser:                new(int64(0)),
				RunAsGroup:               new(int64(0)),
				RunAsNonRoot:             new(false),
				Capabilities: &corev1.Capabilities{
					Drop: []corev1.Capability{"ALL"},
					Add:  []corev1.Capability{"DAC_OVERRIDE"},
				},
			},
			VolumeMounts: initVolumeMounts,
		})

		volumeMounts = append(volumeMounts,
			corev1.VolumeMount{
				Name:      nixAgentVolume,
				MountPath: nixAgentMount,
				SubPath:   nixStoreSubPath,
				ReadOnly:  true,
			},
			corev1.VolumeMount{
				// The init container stages a runnable profile here so the agent can
				// reach installed tools while /nix/store itself is backed by the
				// shared runtime store volume prepared by the init containers.
				Name:      nixLinkVolume,
				MountPath: nixLinkMount,
			},
			corev1.VolumeMount{
				Name:      nixRuntimeStoreVolume,
				MountPath: nixRuntimeStoreMount,
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
			Strategy: appsv1.DeploymentStrategy{
				Type: appsv1.RecreateDeploymentStrategyType,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      podLabels,
					Annotations: podAnnotations,
				},
				Spec: corev1.PodSpec{
					ServiceAccountName:           serviceAccountName,
					AutomountServiceAccountToken: &automount,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: new(true),
						FSGroup:      new(int64(1000)),
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
							WorkingDir:      "/home/clawarmor",
							Args: []string{
								"serve",
								"--hostname=0.0.0.0",
								"--port=4096",
							},
							Env:       r.agentEnv(agt, packages, mountConfig),
							Resources: agt.Spec.Resources,
							Ports: []corev1.ContainerPort{
								{
									Name:          "http",
									ContainerPort: 4096,
									Protocol:      corev1.ProtocolTCP,
								},
							},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: new(false),
								ReadOnlyRootFilesystem:   new(false),
								RunAsUser:                new(int64(1000)),
								RunAsGroup:               new(int64(1000)),
								RunAsNonRoot:             new(true),
								Capabilities: &corev1.Capabilities{
									Drop: []corev1.Capability{"ALL"},
								},
							},
							VolumeMounts: volumeMounts,
						},
					},
				},
			},
		},
	}
}

func (r *Reconciler) agentEnv(agt *clawarmorv1alpha1.Agent, packages []string, mountConfig bool) []corev1.EnvVar {
	proxy := r.proxyAddress(agt)
	proxy = strings.TrimPrefix(proxy, "https://")
	proxy = strings.TrimPrefix(proxy, "http://")
	proxy = "http://" + proxy
	telemetryEndpoint := strings.TrimPrefix(agt.Spec.Telemetry.TraceEndpoint, "https://")
	telemetryEndpoint = strings.TrimPrefix(telemetryEndpoint, "http://")

	var forced []corev1.EnvVar
	noProxy := []string{
		"127.0.0.1",
		"::1",
		"localhost",
		".cluster.local",
		".svc",
	}
	if mountConfig {
		forced = append(forced, corev1.EnvVar{
			Name:  "OPENCODE_CONFIG",
			Value: opencodeConfigDir + "/" + opencodeConfigKey,
		})
	}
	if agt.Spec.Telemetry.Enabled {
		endpointHost := endpointHost(agt.Spec.Telemetry.TraceEndpoint)
		if endpointHost != "" {
			noProxy = append(noProxy, endpointHost)
		}
	}
	if r.sinjectorEnabled() {
		noProxyValue := strings.Join(noProxy, ",")
		forced = append(forced,
			corev1.EnvVar{Name: "https_proxy", Value: proxy},
			corev1.EnvVar{Name: "HTTPS_PROXY", Value: proxy},
			corev1.EnvVar{Name: "no_proxy", Value: noProxyValue},
			corev1.EnvVar{Name: "NO_PROXY", Value: noProxyValue},
			corev1.EnvVar{Name: "SSL_CERT_FILE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "REQUESTS_CA_BUNDLE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "CURL_CA_BUNDLE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "NODE_EXTRA_CA_CERTS", Value: r.Config.AgentCABundlePath},
		)
	}
	var telemetryURL string
	if telemetryEndpoint != "" {
		telemetryURL = "http://" + telemetryEndpoint
	}
	forced = append(forced,
		corev1.EnvVar{
			Name:  "OPENCODE_ENABLE_TELEMETRY",
			Value: strconv.FormatBool(agt.Spec.Telemetry.Enabled),
		},
		corev1.EnvVar{Name: "OPENCODE_OTLP_PROTOCOL", Value: "grpc"},
		corev1.EnvVar{Name: "OPENCODE_OTLP_ENDPOINT", Value: telemetryURL},
		corev1.EnvVar{
			Name:  "OPENCODE_RESOURCE_ATTRIBUTES",
			Value: "clawarmor.agent_name=" + agt.Name,
		},
		corev1.EnvVar{Name: "CLAWARMOR_GATEWAY_URL", Value: r.Config.GatewayURL},
	)

	forcedNames := make(map[string]struct{}, len(forced))
	for _, item := range forced {
		forcedNames[item.Name] = struct{}{}
	}

	env := append([]corev1.EnvVar{}, forced...)

	for _, item := range agt.Spec.Env {
		if _, ok := forcedNames[item.Name]; ok {
			continue
		}
		env = append(env, item)
	}

	if len(packages) > 0 {
		env = append(env,
			corev1.EnvVar{
				Name:  "NIX_PROFILES",
				Value: nixLinkMount + "/profile",
			},
			corev1.EnvVar{
				Name:  "PATH",
				Value: nixLinkMount + "/profile/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin",
			},
		)
	}

	return env
}
