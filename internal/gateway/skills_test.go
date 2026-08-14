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

package gateway

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestEffectiveAgentSkillsBeforeSandboxExists(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add AgentZ scheme: %v", err)
	}
	direct := agentzv1alpha1.ResourceReference{
		Scope: agentzv1alpha1.ResourceScopeWorkspace,
		Name:  "direct-skill",
	}
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "provisioning", Namespace: "workspace"},
		Spec: agentzv1alpha1.AgentSpec{
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeWorkspace,
				Name:  "pending-sandbox",
			},
			Skills: []agentzv1alpha1.ResourceReference{direct},
		},
	}
	s := &Service{k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(agt).Build()}

	got, err := s.effectiveAgentSkills(context.Background(), "workspace", agt.Name)
	if err != nil {
		t.Fatalf("effective Agent skills: %v", err)
	}
	if _, ok := got[direct]; !ok {
		t.Fatalf("effective Agent skills = %v, want direct Skill", got)
	}
}
