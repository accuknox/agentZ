//go:build controller
// +build controller

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
	agentconfig "github.com/accuknox/clawarmor/internal/agent/config"
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
				DefaultImage: "murtazau/clawarmor-agent:latest",
			},
		}

		Expect(k8sClient.Create(ctx, &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: namespace,
				Labels: map[string]string{
					"app.kubernetes.io/name":       "clawarmor",
					"app.kubernetes.io/managed-by": "kustomize",
				},
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Server: clawarmorv1alpha1.ServerConfig{
					Address: "0.0.0.0:8080",
					GracefulShutdownTimeout: metav1.Duration{
						Duration: 15 * time.Second,
					},
				},
				Model: clawarmorv1alpha1.ModelConfig{
					Name:   "gpt-5.4-mini",
					Stream: true,
				},
				Session: clawarmorv1alpha1.SessionConfig{
					ID: "550e8400-e29b-41d4-a716-446655440000",
				},
			},
		})).To(Succeed())
	})

	AfterEach(func() {
		deleteIfExists(ctx, key, &clawarmorv1alpha1.Agent{})
		deleteIfExists(ctx, key, &appsv1.Deployment{})
		deleteIfExists(ctx, key, &corev1.Service{})
		deleteIfExists(ctx, key, &corev1.ConfigMap{})
	})

	It("creates configmap deployment and service for an agent", func() {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		cm := &corev1.ConfigMap{}
		Expect(k8sClient.Get(ctx, key, cm)).To(Succeed())
		Expect(cm.Data[configKey]).To(ContainSubstring("id: 550e8400-e29b-41d4-a716-446655440000"))
		Expect(cm.Data[configKey]).To(ContainSubstring("gracefulShutdownTimeout: 0s"))
		Expect(cm.Data[configKey]).NotTo(ContainSubstring("apiKey"))

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		Expect(dep.Spec.Template.Spec.TerminationGracePeriodSeconds).NotTo(BeNil())
		Expect(*dep.Spec.Template.Spec.TerminationGracePeriodSeconds).To(Equal(int64(15)))
		container := dep.Spec.Template.Spec.Containers[0]
		Expect(container.WorkingDir).To(Equal(agentconfig.DefaultHomeDir))

		svc := &corev1.Service{}
		Expect(k8sClient.Get(ctx, key, svc)).To(Succeed())
		Expect(svc.Spec.Ports[0].Port).To(Equal(int32(8080)))
	})

	It("changes the config hash when runtime spec changes", func() {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		first := dep.Spec.Template.Annotations["clawarmor.accuknox.com/config-hash"]

		agt := &clawarmorv1alpha1.Agent{}
		Expect(k8sClient.Get(ctx, key, agt)).To(Succeed())
		agt.Spec.Instruction = "Be concise."
		Expect(k8sClient.Update(ctx, agt)).To(Succeed())

		_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		second := dep.Spec.Template.Annotations["clawarmor.accuknox.com/config-hash"]
		Expect(second).NotTo(Equal(first))

		cm := &corev1.ConfigMap{}
		Expect(k8sClient.Get(ctx, key, cm)).To(Succeed())
		Expect(cm.Data[configKey]).To(ContainSubstring("instruction: Be concise."))
	})

	It("preserves deployment controller annotations on repeated reconcile", func() {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		if dep.Annotations == nil {
			dep.Annotations = map[string]string{}
		}
		dep.Annotations["deployment.kubernetes.io/revision"] = "1"
		Expect(k8sClient.Update(ctx, dep)).To(Succeed())

		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		gen := dep.Generation

		_, err = reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		Expect(dep.Generation).To(Equal(gen))
		Expect(dep.Annotations).To(HaveKeyWithValue(
			"deployment.kubernetes.io/revision",
			"1",
		))
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
		Expect(agt.Status.ConfigMapName).To(Equal(name))
		Expect(agt.Status.URL).To(Equal(fmt.Sprintf(
			"http://%s.default.svc.cluster.local:8080",
			name,
		)))
		Expect(agt.Status.ObservedSessionID).To(Equal(
			"550e8400-e29b-41d4-a716-446655440000",
		))
		var ready metav1.Condition
		for _, cond := range agt.Status.Conditions {
			if cond.Type == clawarmorv1alpha1.ConditionTypeReady.String() {
				ready = cond
				break
			}
		}
		Expect(ready.Status).To(Equal(metav1.ConditionTrue))
	})
})

func deleteIfExists(ctx context.Context, key types.NamespacedName, obj client.Object) {
	err := k8sClient.Get(ctx, key, obj)
	if err == nil {
		Expect(k8sClient.Delete(ctx, obj)).To(Succeed())
	}
}
