//go:build webhook
// +build webhook

package v1alpha1

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	agentwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/agent"
)

var _ = Describe("Agent Webhook", func() {
	var (
		ctx       context.Context
		obj       *clawarmorv1alpha1.Agent
		oldObj    *clawarmorv1alpha1.Agent
		validator *agentwebhook.Validator
		defaulter *agentwebhook.Defaulter
	)

	BeforeEach(func() {
		ctx = context.Background()
		obj = &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "agent-sample",
				Namespace: "default",
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Image: "murtazau/clawarmor-agent:latest",
			},
		}
		oldObj = obj.DeepCopy()
		validator = agentwebhook.NewValidator()
		defaulter = agentwebhook.NewDefaulter(agentwebhook.WebhookConfig{
			AgentDefaultImage: "murtazau/clawarmor-agent:latest",
		})
	})

	It("defaults image pull policy and nix store size", func() {
		obj.Spec.Image = ""
		obj.Spec.ImagePullPolicy = ""

		err := defaulter.Default(ctx, obj)

		Expect(err).NotTo(HaveOccurred())
		Expect(obj.Spec.Image).To(Equal("murtazau/clawarmor-agent:latest"))
		Expect(obj.Spec.ImagePullPolicy).To(Equal(corev1.PullIfNotPresent))
		Expect(obj.Spec.NixStoreSize.String()).To(Equal("5Gi"))
	})

	It("rejects create when environment reference name is empty", func() {
		obj.Spec.EnvironmentRef = &corev1.LocalObjectReference{}

		_, err := validator.ValidateCreate(ctx, obj)

		Expect(err).To(HaveOccurred())
	})

	It("rejects updates that change nix store size", func() {
		oldObj.Spec.NixStoreSize = resource.MustParse("5Gi")
		obj.Spec.NixStoreSize = resource.MustParse("10Gi")

		_, err := validator.ValidateUpdate(ctx, oldObj, obj)

		Expect(err).To(HaveOccurred())
	})

	It("accepts valid updates", func() {
		obj.Spec.EnvironmentRef = &corev1.LocalObjectReference{Name: "python"}
		oldObj.Spec.NixStoreSize = resource.MustParse("5Gi")
		obj.Spec.NixStoreSize = resource.MustParse("5Gi")

		_, err := validator.ValidateUpdate(ctx, oldObj, obj)

		Expect(err).NotTo(HaveOccurred())
	})
})
