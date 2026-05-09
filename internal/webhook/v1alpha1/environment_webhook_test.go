//go:build webhook
// +build webhook

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

	It("allows valid allowed hosts", func() {
		env.Spec.AllowedHosts = []string{
			"api.github.com",
			"*.github.com",
			"10.0.0.0/24",
			"2001:db8::/32",
		}

		_, err := validator.ValidateCreate(ctx, env)

		Expect(err).NotTo(HaveOccurred())
	})

	It("rejects invalid allowed hosts", func() {
		env.Spec.AllowedHosts = []string{
			"api.*.github.com",
			"10.0.0.1",
		}

		_, err := validator.ValidateCreate(ctx, env)

		Expect(err).To(HaveOccurred())
	})

	It("rejects deleting a referenced environment", func() {
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		agt := &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name + "-agent",
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Image:          "murtazau/clawarmor-agent:latest",
				EnvironmentRef: &corev1.LocalObjectReference{Name: name},
			},
		}
		Expect(k8sClient.Create(ctx, agt)).To(Succeed())

		_, err := validator.ValidateDelete(ctx, env)

		Expect(err).To(HaveOccurred())
	})
})
