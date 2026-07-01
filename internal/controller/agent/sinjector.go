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

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/agentz/internal/envutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (r *Reconciler) reconcileSinjector(ctx context.Context, agt *agentzv1alpha1.Agent, allowedHosts []string) error {
	sipLabels := sinjectorLabels(agt)
	sipName := sinjectorName(agt)
	if err := r.reconcileServiceAccount(ctx, agt, sipName, sipLabels); err != nil {
		return err
	}
	if err := r.reconcileSinjectorAccess(ctx, agt); err != nil {
		return err
	}
	if r.Bao == nil {
		return fmt.Errorf("openbao provisioner is not configured")
	}
	baoName := openBaoSinjectorName(agt)
	err := r.Bao.ProvisionSinjector(ctx, r.Config, SinjectorOpenBaoOptions{
		Namespace:          agt.Namespace,
		ServiceAccountName: sipName,
		RoleName:           baoName,
		PolicyName:         baoName,
		AgentName:          agt.Name,
	})
	if err != nil {
		return err
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

func (r *Reconciler) cleanupSinjector(ctx context.Context, agt *agentzv1alpha1.Agent) error {
	if r.Bao == nil {
		return fmt.Errorf("openbao provisioner is not configured")
	}
	baoName := openBaoSinjectorName(agt)
	return r.Bao.CleanupSinjector(ctx, r.Config, SinjectorOpenBaoOptions{
		Namespace:          agt.Namespace,
		ServiceAccountName: sinjectorName(agt),
		RoleName:           baoName,
		PolicyName:         baoName,
	})
}

func (r *Reconciler) reconcileServiceAccount(ctx context.Context, agt *agentzv1alpha1.Agent, name string, labels map[string]string) error {
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

func (r *Reconciler) reconcileGatewayAccess(ctx context.Context, agt *agentzv1alpha1.Agent) error {
	role := &rbacv1.Role{}
	role.Name = agt.Name + gatewayRoleNameSuffix
	role.Namespace = agt.Namespace
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Labels = resourceLabels(agt)
		role.Annotations = agt.Annotations
		role.Rules = []rbacv1.PolicyRule{{
			APIGroups:     []string{agentzv1alpha1.SchemeGroupVersion.Group},
			Resources:     []string{"agents"},
			ResourceNames: []string{agt.Name},
			Verbs: []string{
				"create-workflow",
				"create-workflow-schedule",
				"delete-workflow-schedule",
				"delete-workflows",
				"get-workflow",
				"list-workflow-schedules",
				"list-workflows",
				"set-workflowrun-status",
				"update-workflow-schedule",
			},
		}}
		return ctrl.SetControllerReference(agt, role, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch gateway role: %w", err)
	}

	binding := &rbacv1.RoleBinding{}
	binding.Name = agt.Name + gatewayRoleNameSuffix
	binding.Namespace = agt.Namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, binding, func() error {
		binding.Labels = resourceLabels(agt)
		binding.Annotations = agt.Annotations
		binding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "Role",
			Name:     role.Name,
		}
		binding.Subjects = []rbacv1.Subject{{
			Kind:      rbacv1.ServiceAccountKind,
			Name:      agt.Name,
			Namespace: agt.Namespace,
		}}
		return ctrl.SetControllerReference(agt, binding, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch gateway rolebinding: %w", err)
	}

	return nil
}

func (r *Reconciler) reconcileSinjectorService(ctx context.Context, agt *agentzv1alpha1.Agent) error {
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

func (r *Reconciler) reconcileSinjectorDeployment(ctx context.Context, agt *agentzv1alpha1.Agent) error {
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

func (r *Reconciler) reconcileSinjectorAccess(ctx context.Context, agt *agentzv1alpha1.Agent) error {
	role := &rbacv1.Role{}
	role.Name = sinjectorName(agt)
	role.Namespace = agt.Namespace
	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Labels = sinjectorLabels(agt)
		role.Annotations = agt.Annotations
		role.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
				Resources: []string{"secrets"},
				Verbs:     []string{"get", "list", "watch"},
			},
			{
				APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
				Resources: []string{"secrets/status"},
				Verbs:     []string{"get", "update", "patch"},
			},
		}
		return ctrl.SetControllerReference(agt, role, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch sinjector role: %w", err)
	}

	binding := &rbacv1.RoleBinding{}
	binding.Name = sinjectorName(agt)
	binding.Namespace = agt.Namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, binding, func() error {
		binding.Labels = sinjectorLabels(agt)
		binding.Annotations = agt.Annotations
		binding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "Role",
			Name:     role.Name,
		}
		binding.Subjects = []rbacv1.Subject{{
			Kind:      rbacv1.ServiceAccountKind,
			Name:      sinjectorName(agt),
			Namespace: agt.Namespace,
		}}
		return ctrl.SetControllerReference(agt, binding, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch sinjector rolebinding: %w", err)
	}
	return nil
}

func (r *Reconciler) reconcileSinjectorPolicy(ctx context.Context, agt *agentzv1alpha1.Agent, allowedHosts []string) error {
	hosts, err := envutil.ParseHostList(allowedHosts)
	if err != nil {
		return err
	}
	dnsHosts := append([]envutil.Host{}, hosts...)
	dnsHosts = append(dnsHosts, dnsHostForEndpoint(r.Config.OpenBaoAddr)...)
	egress := buildHostEgressRules(uniqueHosts(hosts), uniqueHosts(dnsHosts))
	egress = append(egress, openBaoEgressRule())
	egress = append(egress, kubeAPIServerEgressRule())
	current := &ciliumv2.CiliumNetworkPolicy{}
	current.Name = sinjectorName(agt)
	current.Namespace = agt.Namespace
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = sinjectorLabels(agt)
		current.Annotations = agt.Annotations
		current.Spec = &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(
				ciliumlabels.NewLabel(
					"agentz.accuknox.com/sinjector",
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
								"agentz.accuknox.com/agent",
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

func kubeAPIServerEgressRule() ciliumapi.EgressRule {
	return ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEntities: ciliumapi.EntitySlice{
				ciliumapi.EntityKubeAPIServer,
			},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{
				{
					Port:     "443",
					Protocol: ciliumapi.ProtoTCP,
				},
				{
					Port:     "6443",
					Protocol: ciliumapi.ProtoTCP,
				},
			},
		}},
	}
}

func (r *Reconciler) buildSinjectorDeployment(agt *agentzv1alpha1.Agent) *appsv1.Deployment {
	labels := sinjectorLabels(agt)
	podLabels := make(map[string]string, len(labels))
	maps.Copy(podLabels, labels)
	baoName := openBaoSinjectorName(agt)

	args := []string{
		"sinjector",
		"serve",
		"--agent-name", agt.Name,
		"--openbao-addr", r.Config.OpenBaoAddr,
		"--openbao-secret-mount-path", r.Config.OpenBaoSecretMountPath,
		"--openbao-k8s-auth-role", baoName,
		"--openbao-k8s-auth-mount-path", r.Config.OpenBaoK8sAuthMountPath,
		"--openbao-k8s-auth-token-path", r.Config.SinjectorOpenBaoK8sAuthTokenPath,
		"--ca-cert-path", r.Config.SinjectorCACertPath,
		"--ca-key-path", r.Config.SinjectorCAKeyPath,
	}

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:        sinjectorName(agt),
			Namespace:   agt.Namespace,
			Labels:      labels,
			Annotations: agt.Annotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: new(int32(1)),
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
					TerminationGracePeriodSeconds: new(int64(5)),
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
									{Key: r.Config.SinjectorCASecretCertKey, Path: "tls.crt"},
									{Key: r.Config.SinjectorCASecretKeyKey, Path: "tls.key"},
								},
							},
						},
					}},
					Containers: []corev1.Container{{
						Name:            "sinjector",
						Image:           r.Config.SinjectorImage,
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

func (r *Reconciler) sinjectorReady(ctx context.Context, agt *agentzv1alpha1.Agent) (bool, error) {
	dep := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{Name: sinjectorName(agt), Namespace: agt.Namespace}, dep)
	if err != nil {
		return false, client.IgnoreNotFound(err)
	}
	return dep.Status.ReadyReplicas > 0, nil
}
