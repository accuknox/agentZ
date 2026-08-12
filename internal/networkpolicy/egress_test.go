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

package networkpolicy

import "testing"

func TestServiceEgressAllowsDNSResolution(t *testing.T) {
	t.Parallel()

	rules := ServiceEgress("agentgateway-system", "agentgateway", 9978)
	if len(rules) != 2 {
		t.Fatalf("ServiceEgress() returned %d rules, want 2", len(rules))
	}
	dns := rules[1].ToPorts
	if len(dns) != 1 || dns[0].Rules == nil || len(dns[0].Rules.DNS) != 1 {
		t.Fatalf("ServiceEgress() DNS rule = %#v, want one DNS matcher", dns)
	}
	want := "agentgateway.agentgateway-system.svc.cluster.local"
	if dns[0].Rules.DNS[0].MatchName != want {
		t.Errorf(
			"ServiceEgress() DNS name = %q, want %q",
			dns[0].Rules.DNS[0].MatchName,
			want,
		)
	}
}
