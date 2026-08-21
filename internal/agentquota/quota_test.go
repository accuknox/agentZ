package agentquota

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestEffectiveRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		resources corev1.ResourceRequirements
		cpu       string
		memory    string
	}{
		{
			name: "requests",
			resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("250m"),
				corev1.ResourceMemory: resource.MustParse("400Mi"),
			}},
			cpu:    "250m",
			memory: "400Mi",
		},
		{
			name: "limits default requests",
			resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("500m"),
				corev1.ResourceMemory: resource.MustParse("800Mi"),
			}},
			cpu:    "500m",
			memory: "800Mi",
		},
		{
			name: "explicit requests take priority",
			resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("100m"),
					corev1.ResourceMemory: resource.MustParse("200Mi"),
				},
				Limits: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("1"),
					corev1.ResourceMemory: resource.MustParse("1Gi"),
				},
			},
			cpu:    "100m",
			memory: "200Mi",
		},
		{
			name: "explicit zero request takes priority",
			resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("0")},
				Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1")},
			},
			cpu:    "0",
			memory: "0",
		},
		{name: "best effort", resources: corev1.ResourceRequirements{}, cpu: "0", memory: "0"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := EffectiveRequests(tt.resources)
			if got.CPU.Cmp(resource.MustParse(tt.cpu)) != 0 {
				t.Errorf("CPU = %s, want %s", got.CPU.String(), tt.cpu)
			}
			if got.Memory.Cmp(resource.MustParse(tt.memory)) != 0 {
				t.Errorf("memory = %s, want %s", got.Memory.String(), tt.memory)
			}
		})
	}
}

func TestResources(t *testing.T) {
	t.Parallel()

	resources := agentzv1alpha1.ComputeResources{
		CPU:    resource.MustParse("500m"),
		Memory: resource.MustParse("800Mi"),
	}
	tests := []struct {
		name         string
		qos          corev1.PodQOSClass
		wantRequests bool
		wantLimits   bool
	}{
		{name: "guaranteed", qos: corev1.PodQOSGuaranteed, wantRequests: true, wantLimits: true},
		{name: "burstable", qos: corev1.PodQOSBurstable, wantRequests: true},
		{name: "best effort", qos: corev1.PodQOSBestEffort},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := Resources(agentzv1alpha1.AgentDefaults{Resources: resources, QoSClass: tt.qos})
			if (len(got.Requests) > 0) != tt.wantRequests {
				t.Errorf("Requests present = %t, want %t", len(got.Requests) > 0, tt.wantRequests)
			}
			if (len(got.Limits) > 0) != tt.wantLimits {
				t.Errorf("Limits present = %t, want %t", len(got.Limits) > 0, tt.wantLimits)
			}
		})
	}
}

func TestUsageStatus(t *testing.T) {
	t.Parallel()

	agents := []agentzv1alpha1.Agent{
		{Spec: agentzv1alpha1.AgentSpec{Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("500m"),
			corev1.ResourceMemory: resource.MustParse("800Mi"),
		}}}},
		{Spec: agentzv1alpha1.AgentSpec{Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("750m"),
			corev1.ResourceMemory: resource.MustParse("1Gi"),
		}}}},
	}
	quota := agentzv1alpha1.AgentQuota{
		Count: 1,
		Resources: agentzv1alpha1.ComputeResources{
			CPU:    resource.MustParse("1"),
			Memory: resource.MustParse("1600Mi"),
		},
	}

	usage := Measure(agents)
	exceeded := usage.Exceeded(quota)
	if !exceeded.Count || !exceeded.CPU || !exceeded.Memory {
		t.Fatalf("Exceeded() = %#v, want every dimension exceeded", exceeded)
	}
	status := usage.Status(quota)
	if status.Count.Allocated != 2 || status.Count.Available != 0 {
		t.Errorf("count status = %#v, want allocated=2 available=0", status.Count)
	}
	if !status.Resources.Available.CPU.IsZero() || !status.Resources.Available.Memory.IsZero() {
		t.Errorf("available resources = %#v, want zero", status.Resources.Available)
	}
}
