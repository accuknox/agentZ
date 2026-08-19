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
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/networkpolicy"
	"github.com/accuknox/agentz/internal/openbao"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	extAuthConditionType = mcp.ConditionExtAuthReady
	extAuthLabelName     = "agentz-extauth"
	extAuthTokenPath     = "/var/run/secrets/kubernetes.io/serviceaccount/token"
)

//go:embed policies/extauth.hcl
var extAuthPolicyTemplate string

var extAuthPolicy = template.Must(template.New("extauth-policy").Parse(extAuthPolicyTemplate))

type extAuthStatus struct {
	serviceRef    *agentzv1alpha1.MCPConnectionManagedResourceRef
	deploymentRef *agentzv1alpha1.MCPConnectionManagedResourceRef
	ready         bool
}

type extAuthPolicyData struct {
	MCPDataPath           string
	MCPMetadataPath       string
	InferenceDataPath     string
	InferenceMetadataPath string
}

type workspaceAccess struct {
	name      string
	namespace string
	owner     metav1.OwnerReference
	mcp       bool
	inference bool
}

type extAuthScope struct {
	namespace  string
	workspaces []workspaceAccess
	labels     map[string]string
	ownerRefs  []metav1.OwnerReference
}

// ExtAuthRuntimeReconciler owns the one shared ext-auth runtime in each tenant
// namespace that has MCP or subscription-inference consumers.
type ExtAuthRuntimeReconciler struct {
	client.Client
	Scheme                  *runtime.Scheme
	ControllerImage         string
	OpenBaoAddr             string
	ManagerOpenBaoAddr      string
	OpenBaoSecretMountPath  string
	OpenBaoK8sAuthRole      string
	OpenBaoK8sAuthMountPath string
	OpenBaoK8sAuthTokenPath string
}

// The runtime controller deletes obsolete scope-reader RBAC objects explicitly
// because their owner namespace can remain after the runtime is disabled.
// +kubebuilder:rbac:groups=agentz.accuknox.com,resources=inferenceproviders,verbs=get;list;watch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles;clusterrolebindings,verbs=get;list;watch;create;update;patch;delete

// SetupWithManager registers the shared runtime controller.
func (r *ExtAuthRuntimeReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Namespace{}).
		Watches(
			&agentzv1alpha1.MCPConnection{},
			handler.EnqueueRequestsFromMapFunc(r.namespaceForObject),
		).
		Watches(
			&agentzv1alpha1.InferenceProvider{},
			handler.EnqueueRequestsFromMapFunc(r.namespaceForObject),
		).
		Watches(
			&agentzv1alpha1.Workspace{},
			handler.EnqueueRequestsFromMapFunc(r.namespaceForWorkspace),
		).
		Named("extauth-runtime").
		Complete(r)
}

func (r *ExtAuthRuntimeReconciler) namespaceForWorkspace(_ context.Context, obj client.Object) []reconcile.Request {
	workspace, ok := obj.(*agentzv1alpha1.Workspace)
	if !ok {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		workspace.Spec.OrganizationID,
	)}}}
}

func (r *ExtAuthRuntimeReconciler) namespaceForObject(_ context.Context, obj client.Object) []reconcile.Request {
	return []reconcile.Request{{
		NamespacedName: types.NamespacedName{Name: obj.GetNamespace()},
	}}
}

func (r *ExtAuthRuntimeReconciler) runtimeNeeded(ctx context.Context, ns string) (bool, error) {
	connections := &agentzv1alpha1.MCPConnectionList{}
	if err := r.List(ctx, connections, client.InNamespace(ns)); err != nil {
		return false, fmt.Errorf("list mcp connections for ext auth runtime: %w", err)
	}
	for i := range connections.Items {
		if connections.Items[i].DeletionTimestamp.IsZero() {
			return true, nil
		}
	}
	providers := &agentzv1alpha1.InferenceProviderList{}
	if err := r.List(ctx, providers, client.InNamespace(ns)); err != nil {
		return false, fmt.Errorf("list inference providers for ext auth runtime: %w", err)
	}
	for i := range providers.Items {
		provider := &providers.Items[i]
		if !provider.DeletionTimestamp.IsZero() {
			continue
		}
		isCodex := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		isCopilot := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
		if isCodex || isCopilot {
			return true, nil
		}
	}
	return false, nil
}

// Reconcile creates or removes the namespace-shared ext-auth runtime.
func (r *ExtAuthRuntimeReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	ns := &corev1.Namespace{}
	if err := r.Get(ctx, client.ObjectKey{Name: req.Name}, ns); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if ns.Labels[agentzv1alpha1.TenantManagedByLabel] != agentzv1alpha1.TenantManagedByValue {
		return ctrl.Result{}, nil
	}
	needed, err := r.runtimeNeeded(ctx, ns.Name)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !needed {
		return ctrl.Result{}, r.deleteExtAuthRuntime(ctx, ns.Name)
	}
	if strings.TrimSpace(r.ControllerImage) == "" {
		return ctrl.Result{}, fmt.Errorf("controller image is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoAddr) == "" {
		return ctrl.Result{}, fmt.Errorf("openbao addr is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoSecretMountPath) == "" {
		return ctrl.Result{}, fmt.Errorf("openbao secret mount path is required for ext auth runtime")
	}
	if strings.TrimSpace(r.OpenBaoK8sAuthRole) == "" {
		return ctrl.Result{}, fmt.Errorf("openbao kubernetes auth role is required for ext auth runtime")
	}
	ownerRefs := []metav1.OwnerReference{*metav1.NewControllerRef(ns, corev1.SchemeGroupVersion.WithKind("Namespace"))}

	labels := map[string]string{
		"app.kubernetes.io/name":       extAuthLabelName,
		"app.kubernetes.io/managed-by": "agentz-extauth-controller",
		"agentz.accuknox.com/managed":  "true",
	}
	workspaces, err := r.workspaceAccess(ctx, ns)
	if err != nil {
		return ctrl.Result{}, err
	}
	scope := extAuthScope{
		namespace: ns.Name, workspaces: workspaces, labels: labels, ownerRefs: ownerRefs,
	}

	if err := r.reconcileExtAuthServiceAccount(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthRole(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthRoleBinding(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthScopeReader(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthWorkspaceAccess(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthOpenBao(ctx, ns.Name); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthService(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthPolicy(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileExtAuthDeployment(ctx, scope); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *ExtAuthRuntimeReconciler) workspaceAccess(ctx context.Context, ns *corev1.Namespace) ([]workspaceAccess, error) {
	if ns.Labels[agentzv1alpha1.WorkspaceNameLabel] != "" {
		return nil, nil
	}
	organizationID := ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation]
	if organizationID == "" {
		return nil, fmt.Errorf("tenant namespace has no organization identity")
	}
	providers := &agentzv1alpha1.InferenceProviderList{}
	if err := r.List(ctx, providers, client.InNamespace(ns.Name)); err != nil {
		return nil, fmt.Errorf("list organization inference providers: %w", err)
	}
	subscriptions := make(map[string]struct{}, len(providers.Items))
	for i := range providers.Items {
		provider := &providers.Items[i]
		isCodex := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		isCopilot := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
		if isCodex || isCopilot {
			subscriptions[provider.Name] = struct{}{}
		}
	}
	workspaces := &agentzv1alpha1.WorkspaceList{}
	if err := r.List(ctx, workspaces); err != nil {
		return nil, fmt.Errorf("list organization workspaces: %w", err)
	}

	access := make([]workspaceAccess, 0, len(workspaces.Items))
	for i := range workspaces.Items {
		workspace := &workspaces.Items[i]
		if workspace.Spec.OrganizationID != organizationID {
			continue
		}
		expected := agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeWorkspace,
			workspace.Spec.WorkspaceID,
		)
		if workspace.Name != expected {
			continue
		}
		mcpAccess := len(workspace.Spec.SelectedOrganizationResources.MCPConnections) > 0
		inferenceAccess := slices.ContainsFunc(
			workspace.Spec.SelectedOrganizationResources.InferenceProviders,
			func(name string) bool {
				_, ok := subscriptions[name]
				return ok
			},
		)
		access = append(
			access,
			workspaceAccess{
				name:      workspace.Name,
				namespace: expected,
				mcp:       mcpAccess,
				inference: inferenceAccess,
				owner: *metav1.NewControllerRef(
					workspace,
					agentzv1alpha1.SchemeGroupVersion.WithKind("Workspace"),
				),
			},
		)
	}
	slices.SortFunc(
		access,
		func(a, b workspaceAccess) int {
			return strings.Compare(a.namespace, b.namespace)
		},
	)
	return access, nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthServiceAccount(ctx context.Context, scope extAuthScope) error {
	ns, labels, ownerRefs := scope.namespace, scope.labels, scope.ownerRefs
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		sa,
		func() error {
			sa.Labels = maps.Clone(labels)
			sa.OwnerReferences = ownerRefs
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth service account: %w", err)
	}

	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthRole(ctx context.Context, scope extAuthScope) error {
	ns, labels, ownerRefs := scope.namespace, scope.labels, scope.ownerRefs
	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		role,
		func() error {
			role.Labels = maps.Clone(labels)
			role.OwnerReferences = ownerRefs
			role.Rules = []rbacv1.PolicyRule{
				{
					APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
					Resources: []string{"sandboxes", "inferenceproviders", "inferencepools"},
					Verbs:     []string{"get"},
				},
				{
					APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
					Resources: []string{"mcpconnections"},
					Verbs:     []string{"get", "list", "watch"},
				},
				{
					APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
					Resources: []string{"mcpconnections/status"},
					Verbs:     []string{"get", "update", "patch"},
				},
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth role: %w", err)
	}

	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthScopeReader(ctx context.Context, scope extAuthScope) error {
	ns, workspaces := scope.namespace, scope.workspaces
	labels, ownerRefs := scope.labels, scope.ownerRefs
	name := mcp.ExtAuthOpenBaoName(ns) + "-scope-reader"
	namespaces := make([]string, 1, len(workspaces)+1)
	namespaces[0] = ns
	workspaceNames := make([]string, 0, len(workspaces))
	for _, workspace := range workspaces {
		if !workspace.mcp && !workspace.inference {
			continue
		}
		namespaces = append(namespaces, workspace.namespace)
		workspaceNames = append(workspaceNames, workspace.name)
	}
	role := &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: name}}
	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		role,
		func() error {
			role.Labels = maps.Clone(labels)
			role.OwnerReferences = ownerRefs
			role.Rules = []rbacv1.PolicyRule{
				{
					APIGroups:     []string{""},
					Resources:     []string{"namespaces"},
					ResourceNames: namespaces,
					Verbs:         []string{"get"},
				},
			}
			if len(workspaceNames) > 0 {
				role.Rules = append(
					role.Rules,
					rbacv1.PolicyRule{
						APIGroups:     []string{"agentz.accuknox.com"},
						Resources:     []string{"workspaces"},
						ResourceNames: workspaceNames,
						Verbs:         []string{"get"},
					},
				)
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth scope reader role: %w", err)
	}

	binding := &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: name}}
	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		binding,
		func() error {
			binding.Labels = maps.Clone(labels)
			binding.OwnerReferences = ownerRefs
			binding.RoleRef = rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "ClusterRole",
				Name:     name,
			}
			binding.Subjects = []rbacv1.Subject{{
				Kind:      rbacv1.ServiceAccountKind,
				Name:      mcp.ExtAuthServiceName,
				Namespace: ns,
			}}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth scope reader binding: %w", err)
	}
	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthWorkspaceAccess(ctx context.Context, scope extAuthScope) error {
	org, workspaces, labels := scope.namespace, scope.workspaces, scope.labels
	name := mcp.ExtAuthOpenBaoName(org)
	for _, workspace := range workspaces {
		grant := &gwv1.ReferenceGrant{ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName + "-" + workspace.name,
			Namespace: org,
		}}
		if workspace.mcp {
			_, err := ctrlutil.CreateOrPatch(
				ctx,
				r.Client,
				grant,
				func() error {
					service := gwv1.ObjectName(mcp.ExtAuthServiceName)
					grant.Labels = maps.Clone(labels)
					grant.OwnerReferences = []metav1.OwnerReference{workspace.owner}
					grant.Spec = gwv1.ReferenceGrantSpec{
						From: []gwv1.ReferenceGrantFrom{{
							Group:     "agentgateway.dev",
							Kind:      "AgentgatewayPolicy",
							Namespace: gwv1.Namespace(workspace.namespace),
						}},
						To: []gwv1.ReferenceGrantTo{{
							Kind: "Service",
							Name: &service,
						}},
					}
					return nil
				},
			)
			if err != nil {
				return fmt.Errorf("reconcile workspace ext auth reference grant: %w", err)
			}
		}
		if !workspace.mcp {
			err := r.Delete(ctx, grant)
			if err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("delete workspace ext auth reference grant: %w", err)
			}
		}

		role := &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: workspace.namespace,
		}}
		binding := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: workspace.namespace,
		}}
		if !workspace.mcp && !workspace.inference {
			if err := r.Delete(ctx, binding); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("delete workspace ext auth role binding: %w", err)
			}
			if err := r.Delete(ctx, role); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("delete workspace ext auth role: %w", err)
			}
			continue
		}
		_, err := ctrlutil.CreateOrPatch(
			ctx,
			r.Client,
			role,
			func() error {
				role.Labels = maps.Clone(labels)
				role.OwnerReferences = []metav1.OwnerReference{workspace.owner}
				resources := []string{"sandboxes"}
				if workspace.inference {
					resources = append(resources, "inferencepools")
				}
				role.Rules = []rbacv1.PolicyRule{{
					APIGroups: []string{agentzv1alpha1.SchemeGroupVersion.Group},
					Resources: resources,
					Verbs:     []string{"get"},
				}}
				return nil
			},
		)
		if err != nil {
			return fmt.Errorf("reconcile workspace ext auth role: %w", err)
		}

		_, err = ctrlutil.CreateOrPatch(
			ctx,
			r.Client,
			binding,
			func() error {
				binding.Labels = maps.Clone(labels)
				binding.OwnerReferences = []metav1.OwnerReference{workspace.owner}
				binding.RoleRef = rbacv1.RoleRef{
					APIGroup: rbacv1.GroupName,
					Kind:     "Role",
					Name:     name,
				}
				binding.Subjects = []rbacv1.Subject{{
					Kind:      rbacv1.ServiceAccountKind,
					Name:      mcp.ExtAuthServiceName,
					Namespace: org,
				}}
				return nil
			},
		)
		if err != nil {
			return fmt.Errorf("reconcile workspace ext auth role binding: %w", err)
		}
	}
	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthRoleBinding(ctx context.Context, scope extAuthScope) error {
	ns, labels, ownerRefs := scope.namespace, scope.labels, scope.ownerRefs
	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		roleBinding,
		func() error {
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
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth role binding: %w", err)
	}

	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthService(ctx context.Context, scope extAuthScope) error {
	ns, labels, ownerRefs := scope.namespace, scope.labels, scope.ownerRefs
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		svc,
		func() error {
			svc.Labels = maps.Clone(labels)
			svc.OwnerReferences = ownerRefs
			svc.Spec = corev1.ServiceSpec{
				Selector: maps.Clone(labels),
				Ports: []corev1.ServicePort{
					{
						Name:        "grpc",
						Port:        mcp.ExtAuthPort,
						Protocol:    corev1.ProtocolTCP,
						AppProtocol: new("kubernetes.io/h2c"),
					},
					{
						Name:        "mcp",
						Port:        mcp.ExtAuthMCPPort,
						Protocol:    corev1.ProtocolTCP,
						AppProtocol: new(mcp.AppProtocolMCP),
					},
				},
			}
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth service: %w", err)
	}

	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthDeployment(ctx context.Context, scope extAuthScope) error {
	ns := scope.namespace
	labels, ownerRefs := scope.labels, scope.ownerRefs
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
		"--addr",
		"0.0.0.0:18081",
		"--namespace",
		ns,
		"--openbao-addr",
		r.OpenBaoAddr,
		"--openbao-secret-mount-path",
		r.OpenBaoSecretMountPath,
		"--openbao-k8s-auth-role",
		mcp.ExtAuthOpenBaoName(ns),
		"--openbao-k8s-auth-mount-path",
		r.OpenBaoK8sAuthMountPath,
		"--openbao-k8s-auth-token-path",
		extAuthTokenPath,
	}

	_, err := ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		deployment,
		func() error {
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
							Ports: []corev1.ContainerPort{
								{
									Name:          "grpc",
									ContainerPort: mcp.ExtAuthPort,
									Protocol:      corev1.ProtocolTCP,
								},
								{
									Name:          "mcp",
									ContainerPort: mcp.ExtAuthMCPPort,
									Protocol:      corev1.ProtocolTCP,
								},
							},
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
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth deployment: %w", err)
	}

	return nil
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthPolicy(ctx context.Context, scope extAuthScope) error {
	ns, workspaces := scope.namespace, scope.workspaces
	labels, ownerRefs := scope.labels, scope.ownerRefs
	policy := &ciliumv2.CiliumNetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      mcp.ExtAuthServiceName,
			Namespace: ns,
		},
	}

	connections := &agentzv1alpha1.MCPConnectionList{}
	err := r.List(ctx, connections, client.InNamespace(ns))
	if err != nil {
		return fmt.Errorf("list ext auth MCP connections: %w", err)
	}
	targets := make([]networkpolicy.Target, 0, len(connections.Items)*2)
	for i := range connections.Items {
		target, err := mcp.ParseTarget(&connections.Items[i])
		if err != nil {
			return fmt.Errorf("resolve ext auth MCP target: %w", err)
		}
		targets = append(
			targets,
			networkpolicy.Target{
				Host: target.Host,
				Port: target.Port,
			},
		)
		auth := connections.Items[i].Spec.Auth
		if auth == nil || auth.OAuth == nil || auth.OAuth.TokenEndpoint == "" {
			continue
		}
		tokenTarget, err := networkpolicy.URLTarget(auth.OAuth.TokenEndpoint)
		if err != nil {
			return fmt.Errorf("resolve ext auth OAuth target: %w", err)
		}
		targets = append(targets, tokenTarget)
	}
	providers := &agentzv1alpha1.InferenceProviderList{}
	if err := r.List(ctx, providers, client.InNamespace(ns)); err != nil {
		return fmt.Errorf("list ext auth inference providers: %w", err)
	}
	hasCodexProvider := slices.ContainsFunc(
		providers.Items,
		func(provider agentzv1alpha1.InferenceProvider) bool {
			return provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		},
	)
	if hasCodexProvider {
		target, err := networkpolicy.URLTarget(inference.OpenAICodexTokenEndpoint)
		if err != nil {
			return fmt.Errorf("resolve OpenAI Codex token target: %w", err)
		}
		targets = append(targets, target)
	}
	openBao, err := networkpolicy.URLTarget(r.OpenBaoAddr)
	if err != nil {
		return fmt.Errorf("resolve ext auth OpenBao target: %w", err)
	}

	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		policy,
		func() error {
			policy.Labels = maps.Clone(labels)
			policy.OwnerReferences = ownerRefs
			policy.Spec = extAuthPolicySpec(ns, workspaces)
			policy.Spec.Egress = append(
				policy.Spec.Egress,
				networkpolicy.ExternalEgress(targets)...,
			)
			parts := strings.Split(openBao.Host, ".")
			if len(parts) >= 4 && parts[2] == "svc" {
				policy.Spec.Egress = append(
					policy.Spec.Egress,
					networkpolicy.ServiceEgress(parts[1], parts[0], openBao.Port)...,
				)
				return nil
			}
			policy.Spec.Egress = append(
				policy.Spec.Egress,
				networkpolicy.ExternalEgress([]networkpolicy.Target{openBao})...,
			)
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch ext auth cilium network policy: %w", err)
	}

	return nil
}

func extAuthPolicySpec(ns string, workspaces []workspaceAccess) *ciliumapi.Rule {
	mcpGateways := []ciliumapi.EndpointSelector{
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
	}
	inferenceGateways := []ciliumapi.EndpointSelector{
		ciliumapi.NewESFromLabels(
			ciliumlabels.NewLabel(
				"io.kubernetes.pod.namespace",
				ns,
				ciliumlabels.LabelSourceK8s,
			),
			ciliumlabels.NewLabel(
				"gateway.networking.k8s.io/gateway-name",
				inference.GatewayName,
				ciliumlabels.LabelSourceK8s,
			),
		),
	}
	for _, workspace := range workspaces {
		if workspace.mcp {
			mcpGateways = append(
				mcpGateways,
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						workspace.namespace,
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
			)
		}
		if workspace.inference {
			inferenceGateways = append(
				inferenceGateways,
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						workspace.namespace,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"gateway.networking.k8s.io/gateway-name",
						inference.GatewayName,
						ciliumlabels.LabelSourceK8s,
					),
				),
			)
		}
	}
	return &ciliumapi.Rule{
		EndpointSelector: ciliumapi.NewESFromLabels(
			ciliumlabels.NewLabel(
				"app.kubernetes.io/name",
				extAuthLabelName,
				ciliumlabels.LabelSourceK8s,
			),
		),
		Ingress: []ciliumapi.IngressRule{
			{
				IngressCommonRule: ciliumapi.IngressCommonRule{
					FromEndpoints: mcpGateways,
				},
				ToPorts: ciliumapi.PortRules{{
					Ports: []ciliumapi.PortProtocol{
						{Port: "18081", Protocol: ciliumapi.ProtoTCP},
						{Port: "18082", Protocol: ciliumapi.ProtoTCP},
					},
				}},
			},
			{
				IngressCommonRule: ciliumapi.IngressCommonRule{
					FromEndpoints: inferenceGateways,
				},
				ToPorts: ciliumapi.PortRules{{
					Ports: []ciliumapi.PortProtocol{{
						Port:     "18081",
						Protocol: ciliumapi.ProtoTCP,
					}},
				}},
			},
		},
		Egress: []ciliumapi.EgressRule{
			{
				EgressCommonRule: ciliumapi.EgressCommonRule{
					ToEndpoints: []ciliumapi.EndpointSelector{
						ciliumapi.NewESFromK8sLabelSelector(
							ciliumlabels.LabelSourceK8sKeyPrefix,
							&slimv1.LabelSelector{},
						),
					},
				},
			},
			{
				EgressCommonRule: ciliumapi.EgressCommonRule{
					ToEntities: ciliumapi.EntitySlice{ciliumapi.EntityKubeAPIServer},
				},
			},
		},
	}
}

func (r *ExtAuthRuntimeReconciler) reconcileExtAuthOpenBao(ctx context.Context, ns string) error {
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
	policy, err := renderExtAuthPolicy(r.OpenBaoSecretMountPath, ns)
	if err != nil {
		return err
	}
	if err := baoClient.Sys().PutPolicyWithContext(ctx, name, policy); err != nil {
		return fmt.Errorf("put ext auth openbao policy: %w", err)
	}

	path := fmt.Sprintf("auth/%s/role/%s", strings.Trim(r.OpenBaoK8sAuthMountPath, "/"), name)
	_, err = baoClient.Logical().WriteWithContext(
		ctx,
		path,
		map[string]any{
			"bound_service_account_names":      mcp.ExtAuthServiceName,
			"bound_service_account_namespaces": ns,
			"policies":                         name,
			"token_period":                     "1h",
			"token_type":                       "service",
		},
	)
	if err != nil {
		return fmt.Errorf("put ext auth openbao kubernetes role: %w", err)
	}

	return nil
}

func renderExtAuthPolicy(mount, namespace string) (string, error) {
	mcpPrefix := mcp.SecretPath(namespace, "*")
	inferencePrefix := namespace + "/" + inference.SubscriptionCredentialPathDir + "/*"
	data := extAuthPolicyData{
		MCPDataPath: fmt.Sprintf(
			"%s/data/%s",
			strings.Trim(mount, "/"),
			mcpPrefix,
		),
		MCPMetadataPath: fmt.Sprintf(
			"%s/metadata/%s",
			strings.Trim(mount, "/"),
			mcpPrefix,
		),
		InferenceDataPath: fmt.Sprintf(
			"%s/data/%s",
			strings.Trim(mount, "/"),
			inferencePrefix,
		),
		InferenceMetadataPath: fmt.Sprintf(
			"%s/metadata/%s",
			strings.Trim(mount, "/"),
			inferencePrefix,
		),
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

func (r *ExtAuthRuntimeReconciler) deleteExtAuthRuntime(ctx context.Context, ns string) error {
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

	accessName := mcp.ExtAuthOpenBaoName(ns)
	managed := client.MatchingLabels{
		"app.kubernetes.io/managed-by": "agentz-extauth-controller",
	}
	bindings := &rbacv1.RoleBindingList{}
	if err := r.List(ctx, bindings, managed); err != nil {
		return fmt.Errorf("list workspace ext auth role bindings: %w", err)
	}
	for i := range bindings.Items {
		if bindings.Items[i].Name != accessName {
			continue
		}
		if err := r.Delete(ctx, &bindings.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete workspace ext auth role binding: %w", err)
		}
	}
	roles := &rbacv1.RoleList{}
	if err := r.List(ctx, roles, managed); err != nil {
		return fmt.Errorf("list workspace ext auth roles: %w", err)
	}
	for i := range roles.Items {
		if roles.Items[i].Name != accessName {
			continue
		}
		if err := r.Delete(ctx, &roles.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("delete workspace ext auth role: %w", err)
		}
	}

	scopeReaderName := accessName + "-scope-reader"
	scopeReaderBinding := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: scopeReaderName},
	}
	if err := r.Delete(ctx, scopeReaderBinding); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth scope reader binding: %w", err)
	}
	scopeReader := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: scopeReaderName},
	}
	if err := r.Delete(ctx, scopeReader); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete ext auth scope reader role: %w", err)
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

func (r *ExtAuthRuntimeReconciler) managerOpenBaoAddr() string {
	addr := strings.TrimSpace(r.ManagerOpenBaoAddr)
	if addr != "" {
		return addr
	}
	return strings.TrimSpace(r.OpenBaoAddr)
}
