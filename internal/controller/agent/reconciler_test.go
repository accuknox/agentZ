//go:build controller
// +build controller

package agent

import (
	"context"
	"fmt"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

var _ = Describe("Agent Controller", func() {
	const namespace = "default"

	var (
		ctx        context.Context
		key        types.NamespacedName
		name       string
		reconciler *Reconciler
	)

	BeforeEach(func() {
		ctx = context.Background()
		name = fmt.Sprintf("agent-%d", time.Now().UnixNano())
		key = types.NamespacedName{Name: name, Namespace: namespace}
		reconciler = &Reconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
			Config: RuntimeConfig{
				AgentDefaultImage: "murtazau/clawarmor-agent:latest",
			},
		}

		Expect(k8sClient.Create(ctx, &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Image: "murtazau/clawarmor-agent:latest",
				Telemetry: clawarmorv1alpha1.TelemetryConfig{
					Enabled:       true,
					TraceEndpoint: "observer.default.svc.cluster.local:4317",
				},
			},
		})).To(Succeed())
	})

	AfterEach(func() {
		deleteIfExists(ctx, key, &clawarmorv1alpha1.Agent{})
		deleteIfExists(ctx, key, &clawarmorv1alpha1.Environment{})
		deleteIfExists(ctx, key, &appsv1.Deployment{})
		deleteIfExists(ctx, key, &corev1.Service{})
		deleteIfExists(ctx, key, &corev1.ConfigMap{})
		deleteIfExists(ctx, types.NamespacedName{
			Name:      name + "-nix",
			Namespace: namespace,
		}, &corev1.PersistentVolumeClaim{})
	})

	It("creates configmap deployment and service for an agent", func() {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		cm := &corev1.ConfigMap{}
		Expect(k8sClient.Get(ctx, key, cm)).To(Succeed())
		Expect(cm.Data[configKey]).To(ContainSubstring("traceEndpoint: observer.default.svc.cluster.local:4317"))

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		container := dep.Spec.Template.Spec.Containers[0]
		Expect(container.WorkingDir).To(Equal("/home/clawarmor"))
		Expect(container.Args).To(ContainElement("serve"))

		svc := &corev1.Service{}
		Expect(k8sClient.Get(ctx, key, svc)).To(Succeed())
		Expect(svc.Spec.Ports[0].Port).To(Equal(int32(4096)))
	})

	It("updates ready status once deployment reports ready replicas", func() {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		dep.Status.Replicas = 1
		dep.Status.ReadyReplicas = 1
		dep.Status.AvailableReplicas = 1
		Expect(k8sClient.Status().Update(ctx, dep)).To(Succeed())

		_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		agt := &clawarmorv1alpha1.Agent{}
		Expect(k8sClient.Get(ctx, key, agt)).To(Succeed())
		Expect(agt.Status.ServiceName).To(Equal(name))
		Expect(agt.Status.URL).To(Equal(fmt.Sprintf(
			"http://%s.default.svc.cluster.local:4096",
			name,
		)))
		Expect(agt.Status.ObservedGeneration).To(Equal(agt.Generation))
	})

	It("bootstraps nix packages from a referenced environment", func() {
		env := &clawarmorv1alpha1.Environment{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.EnvironmentSpec{
				Packages: []string{"python3", "ripgrep"},
			},
		}
		Expect(k8sClient.Create(ctx, env)).To(Succeed())

		agt := &clawarmorv1alpha1.Agent{}
		Expect(k8sClient.Get(ctx, key, agt)).To(Succeed())
		agt.Spec.EnvironmentRef = &corev1.LocalObjectReference{Name: name}
		Expect(k8sClient.Update(ctx, agt)).To(Succeed())

		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		pvc := &corev1.PersistentVolumeClaim{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{
			Name:      name + "-nix",
			Namespace: namespace,
		}, pvc)).To(Succeed())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		Expect(dep.Spec.Template.Spec.InitContainers).To(HaveLen(1))
		Expect(dep.Spec.Template.Spec.InitContainers[0].Env).To(ContainElement(
			corev1.EnvVar{Name: nixPkgEnv, Value: "python3,ripgrep"},
		))
		Expect(dep.Spec.Template.Spec.Containers[0].Env).To(ContainElement(
			corev1.EnvVar{Name: "NIX_PROFILES", Value: "/nix/profile"},
		))
	})
})

func deleteIfExists(ctx context.Context, key types.NamespacedName, obj client.Object) {
	err := k8sClient.Get(ctx, key, obj)
	if err == nil {
		Expect(k8sClient.Delete(ctx, obj)).To(Succeed())
	}
}
