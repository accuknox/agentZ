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

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/skill"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (r *Reconciler) reconcilePackageJob(ctx context.Context, agt *agentzv1alpha1.Agent, envCfg sandboxConfig) (bool, error) {
	desired, err := r.buildPackageJob(agt, envCfg)
	if err != nil {
		return false, err
	}
	if err := ctrl.SetControllerReference(agt, desired, r.Scheme); err != nil {
		return false, fmt.Errorf("set controller reference: %w", err)
	}

	current := &batchv1.Job{}
	err = r.Get(ctx, client.ObjectKeyFromObject(desired), current)
	if err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.Create(ctx, desired); err != nil {
				return false, fmt.Errorf("create package job: %w", err)
			}
			return false, nil
		}
		return false, fmt.Errorf("get package job: %w", err)
	}

	desiredHash := desired.Annotations[packageJobHashAnnotation]
	currentHash := current.Annotations[packageJobHashAnnotation]
	if currentHash != desiredHash {
		err := r.Delete(
			ctx,
			current,
			client.PropagationPolicy(metav1.DeletePropagationBackground),
		)
		if err != nil && !apierrors.IsNotFound(err) {
			return false, fmt.Errorf("delete package job: %w", err)
		}
		return false, nil
	}

	if current.DeletionTimestamp != nil {
		return false, nil
	}

	failed := findJobCondition(current, batchv1.JobFailed)
	if failed != nil && failed.Status == corev1.ConditionTrue {
		msg := strings.TrimSpace(failed.Message)
		if msg == "" {
			msg = strings.TrimSpace(failed.Reason)
		}
		if msg == "" {
			msg = "package preparation job failed"
		}
		return false, fmt.Errorf("%w: %s", errPackageJobFailed, msg)
	}

	complete := findJobCondition(current, batchv1.JobComplete)
	if complete != nil && complete.Status == corev1.ConditionTrue {
		return true, nil
	}

	return false, nil
}

func (r *Reconciler) buildPackageJob(agt *agentzv1alpha1.Agent, envCfg sandboxConfig) (*batchv1.Job, error) {
	image := r.Config.AgentInitImage
	if image == "" {
		image = nixInitImage
	}

	hash, err := packageJobHash(image, r.Config.SkillStore, envCfg)
	if err != nil {
		return nil, err
	}
	labels := packageJobLabels(agt)
	podLabels := make(map[string]string, len(labels))
	maps.Copy(podLabels, labels)

	backoffLimit := int32(1)
	volumes := []corev1.Volume{{
		Name: packageJobRootVolume,
		VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: agt.Name + "-nix",
			},
		},
	}}
	volumeMounts := []corev1.VolumeMount{{
		Name:      packageJobRootVolume,
		MountPath: nixVolumeRootMount,
	}}
	env := []corev1.EnvVar{{
		Name:  "AGENTZ_NIX_ROOT",
		Value: nixVolumeRootMount + "/" + nixStoreSubPath,
	}}
	initContainers := make([]corev1.Container, 0, 1)

	if len(envCfg.Packages) > 0 {
		env = append(env, corev1.EnvVar{
			Name:  nixPkgEnv,
			Value: strings.Join(envCfg.Packages, ","),
		})
	}
	if r.Config.SharedNixPVC != "" && len(envCfg.Packages) > 0 {
		volumes = append(volumes, corev1.Volume{
			Name: packageJobSharedVolume,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: r.Config.SharedNixPVC,
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      packageJobSharedVolume,
			MountPath: "/nix-shared",
		})
		env = append(env, corev1.EnvVar{
			Name:  "NIX_SHARED_PVC",
			Value: r.Config.SharedNixPVC,
		})
	}
	immutableArgs := []string{"clear-immutable-skills"}
	immutableMounts := []corev1.VolumeMount{{
		Name: packageJobRootVolume, MountPath: nixVolumeRootMount,
	}}
	if len(envCfg.Skills) > 0 {
		immutableArgs = []string{"sync-immutable-skills"}
		volumes = append(volumes, corev1.Volume{
			Name: configVolume,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{
						Name: agt.Name,
					},
				},
			},
		}, corev1.Volume{
			Name: immutableSkillsBucketVolume,
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: skill.BucketSecretName,
				},
			},
		})
		immutableMounts = append(immutableMounts,
			corev1.VolumeMount{Name: configVolume, MountPath: opencodeConfigDir, ReadOnly: true},
			corev1.VolumeMount{
				Name: immutableSkillsBucketVolume, MountPath: immutableSkillsSecretMount, ReadOnly: true,
			},
		)
	}
	initContainers = append(initContainers, corev1.Container{
		Name:            immutableSkillsInitName,
		Image:           image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Args:            immutableArgs,
		Env: []corev1.EnvVar{{
			Name:  "AGENTZ_IMMUTABLE_SKILLS_TARGET",
			Value: nixVolumeRootMount + "/" + immutableSkillsSubPath,
		}},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: ptr.To(false),
			RunAsUser:                ptr.To(agentRuntimeUID),
			RunAsGroup:               ptr.To(agentRuntimeGID),
			RunAsNonRoot:             ptr.To(true),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
		},
		VolumeMounts: immutableMounts,
	})

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      packageJobName(agt),
			Namespace: agt.Namespace,
			Labels:    labels,
			Annotations: map[string]string{
				packageJobHashAnnotation: hash,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoffLimit,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      podLabels,
					Annotations: map[string]string{},
				},
				Spec: corev1.PodSpec{
					ServiceAccountName:           agt.Name,
					AutomountServiceAccountToken: new(bool),
					RestartPolicy:                corev1.RestartPolicyNever,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: new(bool),
						FSGroup:      ptr.To(agentRuntimeGID),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes:        volumes,
					InitContainers: initContainers,
					Containers: []corev1.Container{{
						Name:            "nix-prepare",
						Image:           image,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Env:             env,
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: new(bool),
							RunAsUser:                new(int64),
							RunAsGroup:               new(int64),
							RunAsNonRoot:             new(bool),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
								Add:  []corev1.Capability{"DAC_OVERRIDE"},
							},
						},
						VolumeMounts: volumeMounts,
					}},
				},
			},
		},
	}, nil
}

func findJobCondition(job *batchv1.Job, typ batchv1.JobConditionType) *batchv1.JobCondition {
	for i := range job.Status.Conditions {
		cond := &job.Status.Conditions[i]
		if cond.Type == typ {
			return cond
		}
	}
	return nil
}
