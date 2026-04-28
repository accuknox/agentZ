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
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

var _ = Describe("Agent Webhook", func() {
	var (
		obj       *clawarmorv1alpha1.Agent
		oldObj    *clawarmorv1alpha1.Agent
		validator AgentCustomValidator
		defaulter AgentCustomDefaulter
	)

	BeforeEach(func() {
		obj = &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "agent-sample",
				Namespace: "default",
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Image: "murtazau/clawarmor-agent:latest",
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
					ID:      "550e8400-e29b-41d4-a716-446655440000",
					Enabled: false,
				},
			},
		}
		oldObj = obj.DeepCopy()
		validator = AgentCustomValidator{}
		defaulter = AgentCustomDefaulter{DefaultImage: "murtazau/clawarmor-agent:latest"}
	})

	It("defaults image and pull policy", func() {
		obj.Spec.Image = ""
		obj.Spec.ImagePullPolicy = ""

		err := defaulter.Default(ctx, obj)

		Expect(err).NotTo(HaveOccurred())
		Expect(obj.Spec.Image).To(Equal("murtazau/clawarmor-agent:latest"))
		Expect(obj.Spec.ImagePullPolicy).To(Equal(corev1.PullIfNotPresent))
	})

	It("rejects create when session id is empty", func() {
		obj.Spec.Session.ID = ""

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects updates that change session id", func() {
		obj.Spec.Session.ID = "550e8400-e29b-41d4-a716-446655440001"

		_, err := validator.ValidateUpdate(ctx, oldObj, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when session id is not a UUIDv4", func() {
		obj.Spec.Session.ID = "not-a-uuid"

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when server address has no port", func() {
		obj.Spec.Server.Address = "localhost"

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when graceful shutdown timeout is negative", func() {
		obj.Spec.Server.GracefulShutdownTimeout = metav1.Duration{
			Duration: -time.Second,
		}

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when model name is empty", func() {
		obj.Spec.Model.Name = ""

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when enabled session has no target", func() {
		obj.Spec.Session.Enabled = true
		obj.Spec.Session.Target = ""

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects create when summary mode is invalid", func() {
		obj.Spec.Session.Summary.Mode = "sometimes"

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("accepts updates that keep session id unchanged", func() {
		obj.Spec.Image = "controller:v2"

		_, err := validator.ValidateUpdate(ctx, oldObj, obj)

		Expect(err).NotTo(HaveOccurred())
	})
})
