//go:build webhook
// +build webhook

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

package v1alpha1

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	environmentwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/environment"
)

var _ = Describe("Environment Webhook", func() {
	const namespace = "default"

	var (
		name      string
		env       *clawarmorv1alpha1.Environment
		validator *environmentwebhook.Validator
	)

	BeforeEach(func() {
		name = fmt.Sprintf("environment-%d", time.Now().UnixNano())
		env = &clawarmorv1alpha1.Environment{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name,
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.EnvironmentSpec{
				Packages: []string{"python3"},
			},
		}
		validator = environmentwebhook.NewValidator(k8sClient)
	})

	AfterEach(func() {
		deleteIfExists(ctx, types.NamespacedName{
			Name:      name + "-agent",
			Namespace: namespace,
		}, &clawarmorv1alpha1.Agent{})
		deleteIfExists(ctx, types.NamespacedName{
			Name:      name,
			Namespace: namespace,
		}, &clawarmorv1alpha1.Environment{})
	})

	It("allows deleting an unreferenced environment", func() {
		Expect(k8sClient.Create(ctx, env)).To(Succeed())

		_, err := validator.ValidateDelete(ctx, env)

		Expect(err).NotTo(HaveOccurred())
	})

	It("rejects deleting a referenced environment", func() {
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		agt := &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name + "-agent",
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				EnvironmentRef: &corev1.LocalObjectReference{Name: name},
				Server: clawarmorv1alpha1.ServerConfig{
					Address: "0.0.0.0:8080",
				},
				Model: clawarmorv1alpha1.ModelConfig{
					Name: "gpt-5.4-mini",
				},
				SummaryModel: clawarmorv1alpha1.SummaryModelConfig{
					Name: "gpt-5.4-nano",
				},
				Session: clawarmorv1alpha1.SessionConfig{
					ID: "550e8400-e29b-41d4-a716-446655440000",
				},
			},
		}
		Expect(k8sClient.Create(ctx, agt)).To(Succeed())

		_, err := validator.ValidateDelete(ctx, env)

		Expect(err).To(HaveOccurred())
	})
})
