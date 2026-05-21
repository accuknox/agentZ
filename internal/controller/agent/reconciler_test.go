//go:build controller
// +build controller

package agent

import (
	"context"
	"fmt"
	"time"

	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
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
				GatewayURL:        "http://gateway.default.svc.cluster.local:8090",
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
				Model:       "openai/gpt-5",
				SmallModel:  "openai/gpt-5-mini",
				Instruction: "Follow repository instructions strictly.",
				Providers: map[string]clawarmorv1alpha1.OpencodeProviderConfig{
					"openai": {
						Env:     []string{"OPENAI_API_KEY"},
						BaseURL: "https://api.openai.com/v1",
					},
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

		pvc := &corev1.PersistentVolumeClaim{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{
			Name:      name + "-nix",
			Namespace: namespace,
		}, pvc)).To(Succeed())

		cm := &corev1.ConfigMap{}
		Expect(k8sClient.Get(ctx, key, cm)).To(Succeed())
		Expect(cm.Data).To(HaveKey(opencodeConfigKey))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"model": "openai/gpt-5"`))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"small_model": "openai/gpt-5-mini"`))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"instructions": [`))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(opencodeInstructionPath))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"tools": {`))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"create_workflow": true`))
		Expect(cm.Data).To(HaveKeyWithValue(
			opencodeInstructionKey,
			"Follow repository instructions strictly.",
		))
		Expect(cm.Data[opencodeConfigKey]).To(ContainSubstring(`"baseURL": "https://api.openai.com/v1"`))

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, key, dep)).To(Succeed())
		Expect(dep.Spec.Template.Spec.InitContainers).To(HaveLen(1))
		Expect(dep.Spec.Template.Spec.InitContainers[0].VolumeMounts).To(
			ContainElement(corev1.VolumeMount{
				Name:      nixAgentVolume,
				MountPath: nixVolumeRootMount,
			}),
		)

		container := dep.Spec.Template.Spec.Containers[0]
		Expect(container.WorkingDir).To(Equal("/home/clawarmor"))
		Expect(container.Args).To(ContainElement("serve"))
		Expect(container.Env).To(ContainElement(
			corev1.EnvVar{
				Name:  "OPENCODE_CONFIG",
				Value: opencodeConfigDir + "/" + opencodeConfigKey,
			},
		))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_ENABLE_TELEMETRY",
			Value: "true",
		}))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_OTLP_PROTOCOL",
			Value: "grpc",
		}))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_OTLP_ENDPOINT",
			Value: "http://observer.default.svc.cluster.local:4317",
		}))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_RESOURCE_ATTRIBUTES",
			Value: "clawarmor.agent_name=" + name,
		}))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{
			Name:  "CLAWARMOR_GATEWAY_URL",
			Value: "http://gateway.default.svc.cluster.local:8090",
		}))
		Expect(container.VolumeMounts).To(ContainElement(corev1.VolumeMount{
			Name:      configVolume,
			MountPath: opencodeConfigDir,
			ReadOnly:  true,
		}))
		Expect(container.VolumeMounts).To(ContainElement(corev1.VolumeMount{
			Name:      nixAgentVolume,
			MountPath: "/home/clawarmor",
			SubPath:   nixHomeSubPath,
		}))

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
		Expect(dep.Spec.Template.Spec.InitContainers).To(HaveLen(3))
		Expect(dep.Spec.Template.Spec.InitContainers[1].Name).To(Equal("nix-store-init"))
		Expect(dep.Spec.Template.Spec.InitContainers[2].SecurityContext.Capabilities).NotTo(BeNil())
		Expect(dep.Spec.Template.Spec.InitContainers[2].SecurityContext.Capabilities.Add).To(
			ContainElement(corev1.Capability("DAC_OVERRIDE")),
		)
		Expect(dep.Spec.Template.Spec.InitContainers[2].Env).To(ContainElement(
			corev1.EnvVar{Name: nixPkgEnv, Value: "python3,ripgrep"},
		))
		Expect(dep.Spec.Template.Spec.InitContainers[2].VolumeMounts).To(
			ContainElement(corev1.VolumeMount{
				Name:      nixAgentVolume,
				MountPath: nixAgentMount,
				SubPath:   nixStoreSubPath,
			}),
		)
		Expect(dep.Spec.Template.Spec.Containers[0].VolumeMounts).To(
			ContainElement(corev1.VolumeMount{
				Name:      nixRuntimeStoreVolume,
				MountPath: nixRuntimeStoreMount,
			}),
		)
		Expect(dep.Spec.Template.Spec.Containers[0].VolumeMounts).To(
			ContainElement(corev1.VolumeMount{
				Name:      nixAgentVolume,
				MountPath: nixAgentMount,
				SubPath:   nixStoreSubPath,
				ReadOnly:  true,
			}),
		)
		Expect(dep.Spec.Template.Spec.Containers[0].Env).To(ContainElement(
			corev1.EnvVar{Name: "NIX_PROFILES", Value: nixLinkMount + "/profile"},
		))
	})

	It("adds no_proxy for the telemetry endpoint when sinjector is enabled", func() {
		reconciler.Config.SinjectorImage = "murtazau/clawarmor-sinjector:latest"
		reconciler.Config.AgentCABundlePath = "/etc/clawarmor/sinjector-ca/ca.crt"

		agt := &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name + "-proxy",
				Namespace: namespace,
			},
			Spec: clawarmorv1alpha1.AgentSpec{
				Telemetry: clawarmorv1alpha1.TelemetryConfig{
					Enabled:       true,
					TraceEndpoint: "172.18.0.1:4317",
				},
			},
		}

		env := reconciler.agentEnv(agt, nil, false)
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "NO_PROXY",
			Value: "127.0.0.1,::1,localhost,.cluster.local,.svc,172.18.0.1",
		}))
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "no_proxy",
			Value: "127.0.0.1,::1,localhost,.cluster.local,.svc,172.18.0.1",
		}))
	})

	It("injects gateway and disabled telemetry env", func() {
		agt := &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name + "-workflow",
				Namespace: namespace,
			},
		}

		env := reconciler.agentEnv(agt, nil, false)
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_ENABLE_TELEMETRY",
			Value: "false",
		}))
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_OTLP_PROTOCOL",
			Value: "grpc",
		}))
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_OTLP_ENDPOINT",
			Value: "",
		}))
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "OPENCODE_RESOURCE_ATTRIBUTES",
			Value: "clawarmor.agent_name=" + agt.Name,
		}))
		Expect(env).To(ContainElement(corev1.EnvVar{
			Name:  "CLAWARMOR_GATEWAY_URL",
			Value: "http://gateway.default.svc.cluster.local:8090",
		}))
	})

	It("adds the gateway host to automatic egress rules", func() {
		agt := &clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{
				Name:      name + "-egress",
				Namespace: namespace,
			},
		}

		spec, err := reconciler.buildEgressPolicySpec(agt, []string{"example.com"})
		Expect(err).NotTo(HaveOccurred())

		var fqdns ciliumapi.FQDNSelectorSlice
		for _, rule := range spec.Egress {
			fqdns = append(fqdns, rule.ToFQDNs...)
		}

		Expect(fqdns).To(ContainElement(ciliumapi.FQDNSelector{
			MatchName: "gateway.default.svc.cluster.local",
		}))
	})
})

func deleteIfExists(ctx context.Context, key types.NamespacedName, obj client.Object) {
	err := k8sClient.Get(ctx, key, obj)
	if err == nil {
		Expect(k8sClient.Delete(ctx, obj)).To(Succeed())
	}
}
