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

// Package agentquota defines Organisation-wide Agent quota accounting.
package agentquota

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Usage is the count and effective CPU and memory requests allocated to Agents.
type Usage struct {
	Count     int32
	Resources agentzv1alpha1.ComputeResources
}

// Exceeded identifies exhausted quota dimensions.
type Exceeded struct {
	Count  bool
	CPU    bool
	Memory bool
}

// Resources returns the Kubernetes resource requirements created from Tenant
// defaults. Kubernetes assigns QoS from this shape.
func Resources(defaults agentzv1alpha1.AgentDefaults) corev1.ResourceRequirements {
	requests := corev1.ResourceList{}
	limits := corev1.ResourceList{}

	switch defaults.QoSClass {
	case corev1.PodQOSGuaranteed:
		requests[corev1.ResourceCPU] = defaults.Resources.CPU.DeepCopy()
		requests[corev1.ResourceMemory] = defaults.Resources.Memory.DeepCopy()
		limits[corev1.ResourceCPU] = defaults.Resources.CPU.DeepCopy()
		limits[corev1.ResourceMemory] = defaults.Resources.Memory.DeepCopy()
	case corev1.PodQOSBurstable:
		requests[corev1.ResourceCPU] = defaults.Resources.CPU.DeepCopy()
		requests[corev1.ResourceMemory] = defaults.Resources.Memory.DeepCopy()
	case corev1.PodQOSBestEffort:
	}

	return corev1.ResourceRequirements{Limits: limits, Requests: requests}
}

// Measure calculates quota usage from live Agent resources. Kubernetes treats a
// limit as the request when that request is omitted, so limits-only resources
// consume the corresponding Tenant budget.
func Measure(agents []agentzv1alpha1.Agent) Usage {
	cpu := resource.Quantity{}
	memory := resource.Quantity{}
	for i := range agents {
		requests := EffectiveRequests(agents[i].Spec.Resources)
		cpu.Add(requests.CPU)
		memory.Add(requests.Memory)
	}

	return Usage{
		Count: int32(len(agents)),
		Resources: agentzv1alpha1.ComputeResources{
			CPU:    cpu,
			Memory: memory,
		},
	}
}

// EffectiveRequests returns the CPU and memory requests Kubernetes reserves.
func EffectiveRequests(resources corev1.ResourceRequirements) agentzv1alpha1.ComputeResources {
	cpu, ok := resources.Requests[corev1.ResourceCPU]
	if !ok {
		cpu = resources.Limits[corev1.ResourceCPU]
	}
	memory, ok := resources.Requests[corev1.ResourceMemory]
	if !ok {
		memory = resources.Limits[corev1.ResourceMemory]
	}

	return agentzv1alpha1.ComputeResources{
		CPU:    cpu.DeepCopy(),
		Memory: memory.DeepCopy(),
	}
}

// Agents returns every Agent allocated to a Tenant, including terminating
// Agents. Organisation and Workspace namespaces carry the Tenant identity.
func Agents(ctx context.Context, reader client.Reader, tenantName string) ([]agentzv1alpha1.Agent, error) {
	var namespaces corev1.NamespaceList
	if err := reader.List(
		ctx,
		&namespaces,
		client.MatchingLabels{agentzv1alpha1.TenantOrganizationIDLabel: tenantName},
	); err != nil {
		return nil, fmt.Errorf("list Tenant namespaces: %w", err)
	}

	tenantNamespaces := make(map[string]struct{}, len(namespaces.Items))
	for i := range namespaces.Items {
		tenantNamespaces[namespaces.Items[i].Name] = struct{}{}
	}
	var allAgents agentzv1alpha1.AgentList
	if err := reader.List(ctx, &allAgents); err != nil {
		return nil, fmt.Errorf("list Agents: %w", err)
	}
	agents := make([]agentzv1alpha1.Agent, 0)
	for i := range allAgents.Items {
		if _, ok := tenantNamespaces[allAgents.Items[i].Namespace]; ok {
			agents = append(agents, allAgents.Items[i])
		}
	}
	return agents, nil
}

// TenantForNamespace resolves the Tenant identity carried by an AgentZ scope
// namespace.
func TenantForNamespace(ctx context.Context, reader client.Reader, namespace string) (*agentzv1alpha1.Tenant, error) {
	var ns corev1.Namespace
	if err := reader.Get(ctx, client.ObjectKey{Name: namespace}, &ns); err != nil {
		return nil, fmt.Errorf("get Agent namespace: %w", err)
	}
	tenantName := ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel]
	if tenantName == "" {
		return nil, fmt.Errorf("namespace %q has no Tenant identity", namespace)
	}

	var tenant agentzv1alpha1.Tenant
	if err := reader.Get(ctx, client.ObjectKey{Name: tenantName}, &tenant); err != nil {
		return nil, fmt.Errorf("get Tenant %q: %w", tenantName, err)
	}
	return &tenant, nil
}

// Add returns usage with one prospective Agent allocation.
func (u Usage) Add(resources corev1.ResourceRequirements) Usage {
	requests := EffectiveRequests(resources)
	u.Count++
	u.Resources.CPU.Add(requests.CPU)
	u.Resources.Memory.Add(requests.Memory)
	return u
}

// Exceeded reports which dimensions exceed the Tenant quota.
func (u Usage) Exceeded(quota agentzv1alpha1.AgentQuota) Exceeded {
	return Exceeded{
		Count:  u.Count > quota.Count,
		CPU:    u.Resources.CPU.Cmp(quota.Resources.CPU) > 0,
		Memory: u.Resources.Memory.Cmp(quota.Resources.Memory) > 0,
	}
}

// Status returns the complete Tenant status snapshot for this usage.
func (u Usage) Status(quota agentzv1alpha1.AgentQuota) agentzv1alpha1.AgentQuotaStatus {
	availableCount := max(quota.Count-u.Count, 0)
	availableCPU := quota.Resources.CPU.DeepCopy()
	availableCPU.Sub(u.Resources.CPU)
	if availableCPU.Sign() < 0 {
		availableCPU.Set(0)
	}
	availableMemory := quota.Resources.Memory.DeepCopy()
	availableMemory.Sub(u.Resources.Memory)
	if availableMemory.Sign() < 0 {
		availableMemory.Set(0)
	}

	return agentzv1alpha1.AgentQuotaStatus{
		Count: agentzv1alpha1.QuotaCount{
			Limit:     quota.Count,
			Allocated: u.Count,
			Available: availableCount,
		},
		Resources: agentzv1alpha1.QuotaResources{
			Limit: agentzv1alpha1.ComputeResources{
				CPU:    quota.Resources.CPU.DeepCopy(),
				Memory: quota.Resources.Memory.DeepCopy(),
			},
			Allocated: agentzv1alpha1.ComputeResources{
				CPU:    u.Resources.CPU.DeepCopy(),
				Memory: u.Resources.Memory.DeepCopy(),
			},
			Available: agentzv1alpha1.ComputeResources{
				CPU:    availableCPU,
				Memory: availableMemory,
			},
		},
	}
}
