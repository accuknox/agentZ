package sessionstore

import (
	"context"
	"fmt"
	"os"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/yaml"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	clientset "github.com/accuknox/clawarmor/pkg/agent-controller/clientset/versioned"
)

const (
	defaultAgentNamespace = "default"
	maxAgentNameLength    = 32

	labelManagedBy = "app.kubernetes.io/managed-by"
	labelSessionID = "clawarmor.accuknox.com/session-id"
)

type agentManager interface {
	CreateAgent(ctx context.Context, sessionID string, agentName string) error
	DeleteAgent(ctx context.Context, agentName string) error
}

type kubeAgentManagerConfig struct {
	Namespace    string
	TemplatePath string
}

type kubeAgentManager struct {
	namespace string
	template  clawarmorv1alpha1.Agent
	client    clientset.Interface
}

func newKubeAgentManager(cfg kubeAgentManagerConfig) (*kubeAgentManager, error) {
	if strings.TrimSpace(cfg.TemplatePath) == "" {
		return nil, fmt.Errorf("agent template path is required")
	}

	data, err := os.ReadFile(cfg.TemplatePath)
	if err != nil {
		return nil, fmt.Errorf("read agent template: %w", err)
	}

	var tmpl clawarmorv1alpha1.Agent
	if err := yaml.Unmarshal(data, &tmpl); err != nil {
		return nil, fmt.Errorf("decode agent template: %w", err)
	}

	namespace := strings.TrimSpace(cfg.Namespace)
	if namespace == "" {
		namespace = defaultAgentNamespace
	}

	restCfg, err := ctrl.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("load kube config: %w", err)
	}
	client, err := clientset.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("create agent clientset: %w", err)
	}

	return &kubeAgentManager{
		namespace: namespace,
		template:  tmpl,
		client:    client,
	}, nil
}

func (m *kubeAgentManager) CreateAgent(ctx context.Context, sessionID string, agentName string) error {
	agt := m.template.DeepCopy()
	agt.TypeMeta = metav1.TypeMeta{
		APIVersion: clawarmorv1alpha1.GroupVersion.String(),
		Kind:       "Agent",
	}
	agt.Name = agentName
	agt.Namespace = m.namespace
	agt.ResourceVersion = ""
	agt.UID = ""
	agt.Generation = 0
	agt.CreationTimestamp = metav1.Time{}
	agt.ManagedFields = nil
	agt.Finalizers = nil
	agt.OwnerReferences = nil
	agt.Status = clawarmorv1alpha1.AgentStatus{}
	if agt.Labels == nil {
		agt.Labels = map[string]string{}
	}
	agt.Labels[labelManagedBy] = "clawarmor-session"
	agt.Labels[labelSessionID] = sessionID
	agt.Spec.Session.ID = sessionID
	agt.Spec.Session.Enabled = true

	_, err := m.client.ApiV1alpha1().Agents(m.namespace).Create(
		ctx,
		agt,
		metav1.CreateOptions{},
	)
	return err
}

func (m *kubeAgentManager) DeleteAgent(ctx context.Context, agentName string) error {
	return m.client.ApiV1alpha1().Agents(m.namespace).Delete(
		ctx,
		agentName,
		metav1.DeleteOptions{},
	)
}

func parseAgentName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", status.Error(codes.InvalidArgument, "agent_name is required")
	}
	if len(name) > maxAgentNameLength {
		return "", status.Error(
			codes.InvalidArgument,
			"agent_name must be at most 32 characters",
		)
	}
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		return "", status.Errorf(
			codes.InvalidArgument,
			"agent_name must be a valid DNS name: %s",
			strings.Join(errs, "; "),
		)
	}
	return name, nil
}

func mapAgentError(action string, err error) error {
	if err == nil {
		return nil
	}
	if status.Code(err) != codes.Unknown {
		return err
	}
	if apierrors.IsAlreadyExists(err) {
		return status.Errorf(codes.AlreadyExists, "%s: already exists", action)
	}
	if apierrors.IsNotFound(err) {
		return status.Errorf(codes.NotFound, "%s: not found", action)
	}
	return status.Errorf(codes.Internal, "%s: %v", action, err)
}
