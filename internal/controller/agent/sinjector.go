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
	"log/slog"
	"maps"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

func (r *Reconciler) reconcileSinjector(ctx context.Context, agt *clawarmorv1alpha1.Agent, allowedHosts []string) error {
	if err := r.reconcileServiceAccount(ctx, agt, agt.Name, resourceLabels(agt)); err != nil {
		return err
	}
	sipLabels := sinjectorLabels(agt)
	sipName := sinjectorName(agt)
	if err := r.reconcileServiceAccount(ctx, agt, sipName, sipLabels); err != nil {
		return err
	}

	if r.Bao != nil {
		err := r.Bao.ProvisionSinjector(ctx, r.Config, SinjectorOpenBaoOptions{
			Namespace:          agt.Namespace,
			ServiceAccountName: sipName,
			RoleName:           sinjectorName(agt),
			PolicyName:         sinjectorName(agt),
			AgentName:          agt.Name,
		})
		if err != nil {
			return err
		}
	}

	if err := r.reconcileSinjectorService(ctx, agt); err != nil {
		return err
	}
	if err := r.reconcileSinjectorDeployment(ctx, agt); err != nil {
		return err
	}
	if err := r.reconcileSinjectorPolicy(ctx, agt, allowedHosts); err != nil {
		return err
	}
	return nil
}

func (r *Reconciler) cleanupSinjector(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	if r.Bao == nil {
		slog.WarnContext(ctx, "openbao provisioner is not configured for sinjector cleanup")
		return nil
	}
	return r.Bao.CleanupSinjector(ctx, r.Config, SinjectorOpenBaoOptions{
		Namespace:          agt.Namespace,
		ServiceAccountName: sinjectorName(agt),
		RoleName:           sinjectorName(agt),
		PolicyName:         sinjectorName(agt),
	})
}

func (r *Reconciler) deleteSinjectorResources(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	ns := agt.Namespace
	name := sinjectorName(agt)

	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	if err := r.Delete(ctx, dep); err != nil && !apierr.IsNotFound(err) {
		return fmt.Errorf("delete sinjector deployment: %w", err)
	}

	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	if err := r.Delete(ctx, svc); err != nil && !apierr.IsNotFound(err) {
		return fmt.Errorf("delete sinjector service: %w", err)
	}

	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	if err := r.Delete(ctx, sa); err != nil && !apierr.IsNotFound(err) {
		return fmt.Errorf("delete sinjector serviceaccount: %w", err)
	}

	policy := &ciliumv2.CiliumNetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	if err := r.Delete(ctx, policy); err != nil && !apierr.IsNotFound(err) {
		return fmt.Errorf("delete sinjector network policy: %w", err)
	}

	return nil
}

func (r *Reconciler) reconcileServiceAccount(ctx context.Context, agt *clawarmorv1alpha1.Agent, name string, labels map[string]string) error {
	current := &corev1.ServiceAccount{}
	current.Name = name
	current.Namespace = agt.Namespace
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = labels
		current.Annotations = agt.Annotations
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch serviceaccount: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileSinjectorService(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	current := &corev1.Service{}
	current.Name = sinjectorName(agt)
	current.Namespace = agt.Namespace
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = sinjectorLabels(agt)
		current.Annotations = agt.Annotations
		current.Spec.Type = corev1.ServiceTypeClusterIP
		current.Spec.Selector = sinjectorSelectorLabels(agt)
		current.Spec.Ports = []corev1.ServicePort{{
			Name:       "http",
			Port:       4096,
			TargetPort: intstr.FromInt32(4096),
			Protocol:   corev1.ProtocolTCP,
		}}
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch sinjector service: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileSinjectorDeployment(ctx context.Context, agt *clawarmorv1alpha1.Agent) error {
	desired := r.buildSinjectorDeployment(agt)
	if err := ctrl.SetControllerReference(agt, desired, r.Scheme); err != nil {
		return fmt.Errorf("set controller reference: %w", err)
	}

	current := &appsv1.Deployment{}
	err := r.Get(ctx, client.ObjectKeyFromObject(desired), current)
	if err != nil {
		if apierr.IsNotFound(err) {
			if err := r.Create(ctx, desired); err != nil {
				return fmt.Errorf("create sinjector deployment: %w", err)
			}
			return nil
		}
		return fmt.Errorf("get sinjector deployment: %w", err)
	}
	patch := client.MergeFrom(current.DeepCopy())
	current.Spec = desired.Spec
	if current.Labels == nil {
		current.Labels = map[string]string{}
	}
	if current.Annotations == nil {
		current.Annotations = map[string]string{}
	}
	maps.Copy(current.Labels, desired.Labels)
	maps.Copy(current.Annotations, desired.Annotations)
	if err := r.Patch(ctx, current, patch); err != nil {
		return fmt.Errorf("patch sinjector deployment: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileSinjectorPolicy(ctx context.Context, agt *clawarmorv1alpha1.Agent, allowedHosts []string) error {
	egress, err := egressRulesForHosts(allowedHosts, r.automaticEgressHosts(agt))
	if err != nil {
		return err
	}
	if len(egress) == 0 {
		egress = append(egress, dnsEgressRule())
	}
	egress = append(egress, openBaoEgressRule())
	current := &ciliumv2.CiliumNetworkPolicy{}
	current.Name = sinjectorName(agt)
	current.Namespace = agt.Namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = sinjectorLabels(agt)
		current.Annotations = agt.Annotations
		current.Spec = &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(
				ciliumlabels.NewLabel(
					"clawarmor.accuknox.com/sinjector",
					agt.Name,
					ciliumlabels.LabelSourceK8s,
				),
			),
			Ingress: []ciliumapi.IngressRule{{
				IngressCommonRule: ciliumapi.IngressCommonRule{
					FromEndpoints: []ciliumapi.EndpointSelector{
						ciliumapi.NewESFromLabels(
							ciliumlabels.NewLabel(
								"io.kubernetes.pod.namespace",
								agt.Namespace,
								ciliumlabels.LabelSourceK8s,
							),
							ciliumlabels.NewLabel(
								"io.cilium.k8s.policy.serviceaccount",
								agt.Name,
								ciliumlabels.LabelSourceK8s,
							),
							ciliumlabels.NewLabel(
								"clawarmor.accuknox.com/agent",
								agt.Name,
								ciliumlabels.LabelSourceK8s,
							),
						),
					},
				},
				ToPorts: ciliumapi.PortRules{{
					Ports: []ciliumapi.PortProtocol{{
						Port:     "4096",
						Protocol: ciliumapi.ProtoTCP,
					}},
				}},
			}},
			Egress: egress,
		}
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch cilium network policy: %w", err)
	}
	return nil
}

func openBaoEgressRule() ciliumapi.EgressRule {
	return ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEndpoints: []ciliumapi.EndpointSelector{
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						"openbao",
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"app.kubernetes.io/instance",
						"openbao",
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"app.kubernetes.io/name",
						"openbao",
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"component",
						"server",
						ciliumlabels.LabelSourceK8s,
					),
				),
			},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{{
				Port:     "8200",
				Protocol: ciliumapi.ProtoTCP,
			}},
		}},
	}
}

func (r *Reconciler) buildSinjectorDeployment(agt *clawarmorv1alpha1.Agent) *appsv1.Deployment {
	image := r.Config.SinjectorImage
	if image == "" {
		image = r.Config.AgentDefaultImage
	}
	labels := sinjectorLabels(agt)
	podLabels := make(map[string]string, len(labels))
	maps.Copy(podLabels, labels)
	replicas := int32(1)
	grace := int64(5)
	certKey := r.Config.SinjectorCASecretCertKey
	keyKey := r.Config.SinjectorCASecretKeyKey
	certPath := r.Config.SinjectorCACertPath
	keyPath := r.Config.SinjectorCAKeyPath

	args := []string{
		"sinjector",
		"serve",
		"--agent-name", agt.Name,
		"--openbao-addr", r.Config.OpenBaoAddr,
		"--openbao-secret-mount-path", r.Config.OpenBaoSecretMountPath,
		"--openbao-k8s-auth-role", sinjectorName(agt),
		"--openbao-k8s-auth-mount-path", r.Config.OpenBaoK8sAuthMountPath,
		"--openbao-k8s-auth-token-path", r.Config.SinjectorOpenBaoK8sAuthTokenPath,
		"--ca-cert-path", certPath,
		"--ca-key-path", keyPath,
	}

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:        sinjectorName(agt),
			Namespace:   agt.Namespace,
			Labels:      labels,
			Annotations: agt.Annotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: sinjectorSelectorLabels(agt),
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      podLabels,
					Annotations: agt.Annotations,
				},
				Spec: corev1.PodSpec{
					ServiceAccountName:            sinjectorName(agt),
					AutomountServiceAccountToken:  new(true),
					TerminationGracePeriodSeconds: &grace,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: new(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes: []corev1.Volume{{
						Name: sinjectorCAVolume,
						VolumeSource: corev1.VolumeSource{
							Secret: &corev1.SecretVolumeSource{
								SecretName: r.Config.SinjectorCASecretName,
								Items: []corev1.KeyToPath{
									{Key: certKey, Path: "tls.crt"},
									{Key: keyKey, Path: "tls.key"},
								},
							},
						},
					}},
					Containers: []corev1.Container{{
						Name:            "sinjector",
						Image:           image,
						ImagePullPolicy: agt.Spec.ImagePullPolicy,
						Args:            args,
						Ports: []corev1.ContainerPort{{
							Name:          "http",
							ContainerPort: 4096,
							Protocol:      corev1.ProtocolTCP,
						}},
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: new(false),
							ReadOnlyRootFilesystem:   new(true),
							RunAsNonRoot:             new(true),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
						},
						VolumeMounts: []corev1.VolumeMount{{
							Name:      sinjectorCAVolume,
							MountPath: sinjectorCAMountPath,
							ReadOnly:  true,
						}},
					}},
				},
			},
		},
	}
}

func (r *Reconciler) sinjectorReady(ctx context.Context, agt *clawarmorv1alpha1.Agent) (bool, error) {
	dep := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{Name: sinjectorName(agt), Namespace: agt.Namespace}, dep)
	if err != nil {
		return false, client.IgnoreNotFound(err)
	}
	return dep.Status.ReadyReplicas > 0, nil
}
