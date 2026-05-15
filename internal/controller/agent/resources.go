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
			{Name: nixPkgEnv, Value: strings.Join(packages, ",")},
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

		initImage := r.Config.AgentInitImage
		if initImage == "" {
			initImage = nixInitImage
		}
		initContainers = append(initContainers, corev1.Container{
			Name:            "nix-init",
			Image:           initImage,
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

		volumeMounts = append(volumeMounts,
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
					ServiceAccountName:           serviceAccountName,
					AutomountServiceAccountToken: &automount,
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

	var forced []corev1.EnvVar
	if mountConfig {
		forced = append(forced, corev1.EnvVar{
			Name:  "XDG_CONFIG_HOME",
			Value: opencodeConfigHome,
		})
	}
	if r.sinjectorEnabled() {
		forced = append(forced,
			corev1.EnvVar{Name: "https_proxy", Value: proxy},
			corev1.EnvVar{Name: "HTTPS_PROXY", Value: proxy},
			corev1.EnvVar{Name: "SSL_CERT_FILE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "REQUESTS_CA_BUNDLE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "CURL_CA_BUNDLE", Value: r.Config.AgentCABundlePath},
			corev1.EnvVar{Name: "NODE_EXTRA_CA_CERTS", Value: r.Config.AgentCABundlePath},
		)
	}

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
				Value: "/nix/profile",
			},
			corev1.EnvVar{
				Name:  "PATH",
				Value: "/nix/profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			},
		)
	}

	env = upsertTelemetryResourceAttrs(env, agt.Name)
	return env
}

func upsertTelemetryResourceAttrs(env []corev1.EnvVar, agentName string) []corev1.EnvVar {
	key := "OPENCODE_RESOURCE_ATTRIBUTES"
	attrKey := "clawarmor.agent_name"
	for i := range env {
		if env[i].Name != key {
			continue
		}
		env[i].Value = mergeResourceAttrs(env[i].Value, attrKey, agentName)
		return env
	}
	return append(env, corev1.EnvVar{
		Name:  key,
		Value: attrKey + "=" + agentName,
	})
}

func mergeResourceAttrs(raw, key, value string) string {
	items := strings.Split(raw, ",")
	out := make([]string, 0, len(items)+1)
	replaced := false
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		k, _, ok := strings.Cut(item, "=")
		if ok && strings.TrimSpace(k) == key {
			out = append(out, key+"="+value)
			replaced = true
			continue
		}
		out = append(out, item)
	}
	if !replaced {
		out = append(out, key+"="+value)
	}
	return strings.Join(out, ",")
}
