package mcpconn

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"maps"
	"slices"
	"strings"
	"text/template"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/clawarmor/internal/mcp"
	"github.com/accuknox/clawarmor/internal/openbao"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	extAuthConditionType = "ExtAuthReady"
	extAuthLabelName     = "clawarmor-extauth"
	extAuthTokenPath     = "/var/run/secrets/kubernetes.io/serviceaccount/token"
)

//go:embed policies/extauth.hcl
var extAuthPolicyTemplate string

var extAuthPolicy = template.Must(template.New("extauth-policy").Parse(extAuthPolicyTemplate))

type extAuthStatus struct {
	serviceRef    *clawarmorv1alpha1.MCPConnectionManagedResourceRef
	deploymentRef *clawarmorv1alpha1.MCPConnectionManagedResourceRef
	ready         bool
}

type extAuthPolicyData struct {
	DataPath     string
	MetadataPath string
}

func (r *MCPConnectionReconciler) extAuthConnections(ctx context.Context, ns string) ([]clawarmorv1alpha1.MCPConnection, error) {
	list := &clawarmorv1alpha1.MCPConnectionList{}
	if err := r.List(ctx, list, client.InNamespace(ns)); err != nil {
		return nil, fmt.Errorf("list mcp connections: %w", err)
	}
	slices.SortFunc(list.Items, func(a, b clawarmorv1alpha1.MCPConnection) int {
		return strings.Compare(a.Name, b.Name)
	})

	envs := &clawarmorv1alpha1.EnvironmentList{}
	if err := r.List(ctx, envs, client.InNamespace(ns)); err != nil {
		return nil, fmt.Errorf("list environments for ext auth: %w", err)
	}

	referenced := make(map[string]struct{})
	for _, env := range envs.Items {
		for _, name := range mcp.MCPConnectionRefNames(&env) {
			referenced[name] = struct{}{}
		}
	}

	active := make([]clawarmorv1alpha1.MCPConnection, 0, len(list.Items))
	for _, conn := range list.Items {
		if conn.Spec.Auth == nil {
			continue
		}
		if _, ok := referenced[conn.Name]; !ok {
			continue
		}
		active = append(active, conn)
	}

	return active, nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthRuntime(ctx context.Context, ns string, conns []clawarmorv1alpha1.MCPConnection) (*extAuthStatus, error) {
	if len(conns) == 0 {
		return nil, nil
	}

	if strings.TrimSpace(r.ControllerImage) == "" {
		return nil, fmt.Errorf("controller image is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoAddr) == "" {
		return nil, fmt.Errorf("openbao addr is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoSecretMountPath) == "" {
		return nil, fmt.Errorf("openbao secret mount path is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoK8sAuthRole) == "" {
		return nil, fmt.Errorf("openbao kubernetes auth role is required for ext auth runtime")
	}

	ownerRefs := make([]metav1.OwnerReference, 0, len(conns))
	for _, conn := range conns {
		if !conn.DeletionTimestamp.IsZero() {
			continue
		}
		ownerRefs = append(ownerRefs, metav1.OwnerReference{
			APIVersion: clawarmorv1alpha1.SchemeGroupVersion.String(),
			Kind:       "MCPConnection",
			Name:       conn.Name,
			UID:        conn.UID,
		})
	}
	if len(ownerRefs) == 0 {
		return nil, nil
	}

	labels := map[string]string{
		"app.kubernetes.io/name":         extAuthLabelName,
		"app.kubernetes.io/managed-by":   "clawarmor-mcp-controller",
		"clawarmor.accuknox.com/managed": "true",
	}

	if err := r.reconcileExtAuthServiceAccount(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthRole(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthRoleBinding(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthOpenBao(ctx, ns); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthService(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthPolicy(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}
	if err := r.reconcileExtAuthDeployment(ctx, ns, labels, ownerRefs); err != nil {
		return nil, err
	}

	ready, err := r.extAuthReady(ctx, ns)
	if err != nil {
		return nil, err
	}

	return &extAuthStatus{
		serviceRef:    mcp.ManagedRef(ns, mcp.ExtAuthServiceName),
		deploymentRef: mcp.ManagedRef(ns, mcp.ExtAuthServiceName),
		ready:         ready,
	}, nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthServiceAccount(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, sa, func() error {
		sa.Labels = maps.Clone(labels)
		sa.OwnerReferences = ownerRefs
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth service account: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthRole(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Labels = maps.Clone(labels)
		role.OwnerReferences = ownerRefs
		role.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{""},
				Resources: []string{"pods"},
				Verbs:     []string{"get", "list"},
			},
			{
				APIGroups: []string{"clawarmor.accuknox.com"},
				Resources: []string{"agents", "envs", "mcpconnections"},
				Verbs:     []string{"get"},
			},
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth role: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthRoleBinding(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, roleBinding, func() error {
		roleBinding.Labels = maps.Clone(labels)
		roleBinding.OwnerReferences = ownerRefs
		roleBinding.RoleRef = rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     "Role",
			Name:     mcp.ExtAuthServiceName,
		}
		roleBinding.Subjects = []rbacv1.Subject{{
			Kind:      "ServiceAccount",
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		}}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth role binding: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthService(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, svc, func() error {
		svc.Labels = maps.Clone(labels)
		svc.OwnerReferences = ownerRefs
		svc.Spec = corev1.ServiceSpec{
			Selector: maps.Clone(labels),
			Ports: []corev1.ServicePort{{
				Name:        "grpc",
				Port:        mcp.ExtAuthPort,
				Protocol:    corev1.ProtocolTCP,
				AppProtocol: new("kubernetes.io/h2c"),
			}},
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth service: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthDeployment(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	replicas := int32(1)
	grace := int64(5)
	readOnly := true
	runAsNonRoot := true
	allowPrivilegeEscalation := false
	automountServiceAccountToken := true
	args := []string{
		"extauth",
		"serve",
		"--addr", "0.0.0.0:18081",
		"--namespace", ns,
		"--openbao-addr", r.OpenBaoAddr,
		"--openbao-secret-mount-path", r.OpenBaoSecretMountPath,
		"--openbao-k8s-auth-role", mcp.ExtAuthOpenBaoName(ns),
		"--openbao-k8s-auth-mount-path", r.OpenBaoK8sAuthMountPath,
		"--openbao-k8s-auth-token-path", extAuthTokenPath,
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, deployment, func() error {
		deployment.Labels = maps.Clone(labels)
		deployment.OwnerReferences = ownerRefs
		deployment.Spec = appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: maps.Clone(labels),
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: maps.Clone(labels),
				},
				Spec: corev1.PodSpec{
					ServiceAccountName:            mcp.ExtAuthServiceName,
					AutomountServiceAccountToken:  &automountServiceAccountToken,
					TerminationGracePeriodSeconds: &grace,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: &runAsNonRoot,
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{{
						Name:            "extauth",
						Image:           r.ControllerImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Args:            args,
						Ports: []corev1.ContainerPort{{
							Name:          "grpc",
							ContainerPort: mcp.ExtAuthPort,
							Protocol:      corev1.ProtocolTCP,
						}},
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: &allowPrivilegeEscalation,
							ReadOnlyRootFilesystem:   &readOnly,
							RunAsNonRoot:             &runAsNonRoot,
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
						},
					}},
				},
			},
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth deployment: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthPolicy(ctx context.Context, ns string, labels map[string]string, ownerRefs []metav1.OwnerReference) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(ctx, r.Client, policy, func() error {
		policy.Labels = maps.Clone(labels)
		policy.OwnerReferences = ownerRefs
		policy.Spec = &ciliumapi.Rule{
			EndpointSelector: ciliumapi.NewESFromLabels(
				ciliumlabels.NewLabel(
					"app.kubernetes.io/name",
					extAuthLabelName,
					ciliumlabels.LabelSourceK8s,
				),
			),
			Ingress: []ciliumapi.IngressRule{{
				IngressCommonRule: ciliumapi.IngressCommonRule{
					FromEndpoints: []ciliumapi.EndpointSelector{
						ciliumapi.NewESFromLabels(
							ciliumlabels.NewLabel(
								"io.kubernetes.pod.namespace",
								ns,
								ciliumlabels.LabelSourceK8s,
							),
							ciliumlabels.NewLabel(
								"app.kubernetes.io/name",
								mcp.GatewayName,
								ciliumlabels.LabelSourceK8s,
							),
							ciliumlabels.NewLabel(
								"gateway.networking.k8s.io/gateway-name",
								mcp.GatewayName,
								ciliumlabels.LabelSourceK8s,
							),
						),
					},
				},
				ToPorts: ciliumapi.PortRules{{
					Ports: []ciliumapi.PortProtocol{{
						Port:     "18081",
						Protocol: ciliumapi.ProtoTCP,
					}},
				}},
			}},
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create or patch ext auth cilium network policy: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) reconcileExtAuthOpenBao(ctx context.Context, ns string) error {
	baoClient, err := openbao.NewClient(
		ctx,
		r.managerOpenBaoAddr(),
		r.OpenBaoK8sAuthRole,
		r.OpenBaoK8sAuthMountPath,
		r.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return fmt.Errorf("create openbao client for ext auth: %w", err)
	}

	name := mcp.ExtAuthOpenBaoName(ns)
	policy, err := renderExtAuthPolicy(r.OpenBaoSecretMountPath)
	if err != nil {
		return err
	}
	if err := baoClient.Sys().PutPolicyWithContext(ctx, name, policy); err != nil {
		return fmt.Errorf("put ext auth openbao policy: %w", err)
	}

	path := fmt.Sprintf("auth/%s/role/%s", strings.Trim(r.OpenBaoK8sAuthMountPath, "/"), name)
	_, err = baoClient.Logical().WriteWithContext(ctx, path, map[string]any{
		"bound_service_account_names":      mcp.ExtAuthServiceName,
		"bound_service_account_namespaces": ns,
		"policies":                         name,
		"token_period":                     "1h",
		"token_type":                       "service",
	})
	if err != nil {
		return fmt.Errorf("put ext auth openbao kubernetes role: %w", err)
	}

	return nil
}

func renderExtAuthPolicy(mount string) (string, error) {
	data := extAuthPolicyData{
		DataPath:     fmt.Sprintf("%s/data/mcp-connections/*", strings.Trim(mount, "/")),
		MetadataPath: fmt.Sprintf("%s/metadata/mcp-connections/*", strings.Trim(mount, "/")),
	}

	var out bytes.Buffer
	err := extAuthPolicy.Execute(&out, data)
	if err != nil {
		return "", fmt.Errorf("render ext auth openbao policy: %w", err)
	}
	return out.String(), nil
}

func (r *MCPConnectionReconciler) extAuthReady(ctx context.Context, ns string) (bool, error) {
	deployment := &appsv1.Deployment{}
	key := types.NamespacedName{
		Namespace: ns,
		Name:      mcp.ExtAuthServiceName,
	}
	err := r.Get(ctx, key, deployment)
	if err != nil {
		return false, client.IgnoreNotFound(err)
	}
	return deployment.Status.ReadyReplicas > 0, nil
}

func (r *MCPConnectionReconciler) deleteExtAuthRuntime(ctx context.Context, ns string) error {
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, policy); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth cilium network policy: %w", err)
	}

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, deployment); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth deployment: %w", err)
	}

	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, service); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth service: %w", err)
	}

	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, roleBinding); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth role binding: %w", err)
	}

	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, role); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth role: %w", err)
	}

	serviceAccount := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}
	if err := r.Delete(ctx, serviceAccount); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth service account: %w", err)
	}

	if strings.TrimSpace(r.managerOpenBaoAddr()) == "" || strings.TrimSpace(r.OpenBaoK8sAuthRole) == "" {
		return nil
	}

	baoClient, err := openbao.NewClient(
		ctx,
		r.managerOpenBaoAddr(),
		r.OpenBaoK8sAuthRole,
		r.OpenBaoK8sAuthMountPath,
		r.OpenBaoK8sAuthTokenPath,
	)
	if err != nil {
		return fmt.Errorf("create openbao client for ext auth cleanup: %w", err)
	}

	name := mcp.ExtAuthOpenBaoName(ns)
	path := fmt.Sprintf("auth/%s/role/%s", strings.Trim(r.OpenBaoK8sAuthMountPath, "/"), name)
	if _, err := baoClient.Logical().DeleteWithContext(ctx, path); err != nil {
		return fmt.Errorf("delete ext auth openbao role: %w", err)
	}
	if err := baoClient.Sys().DeletePolicyWithContext(ctx, name); err != nil {
		return fmt.Errorf("delete ext auth openbao policy: %w", err)
	}

	return nil
}

func (r *MCPConnectionReconciler) managerOpenBaoAddr() string {
	addr := strings.TrimSpace(r.ManagerOpenBaoAddr)
	if addr != "" {
		return addr
	}
	return strings.TrimSpace(r.OpenBaoAddr)
}
