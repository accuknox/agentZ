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

import "testing"

func TestServiceEgressRulesUseKubernetesService(t *testing.T) {
	t.Parallel()

	rules := serviceEgressRules(
		"http://inference.organisation.svc.cluster.local:80",
	)
	if len(rules) != 1 {
		t.Fatalf("serviceEgressRules() returned %d rules, want 1", len(rules))
	}
	services := rules[0].ToServices
	if len(services) != 1 || services[0].K8sService == nil {
		t.Fatalf("serviceEgressRules() services = %#v, want one Kubernetes service", services)
	}
	service := services[0].K8sService
	if service.ServiceName != "inference" || service.Namespace != "organisation" {
		t.Errorf("serviceEgressRules() service = %#v, want organisation/inference", service)
	}
}
