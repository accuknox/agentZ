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
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	internalmcp "github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestWorkspaceInheritedResourcesUsesMCPProbeReadiness(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add AgentZ scheme: %v", err)
	}
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		testOrganizationID,
	)
	lastProbeTime := metav1.Now()
	conn := &agentzv1alpha1.MCPConnection{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "notion",
			Namespace: organizationNamespace,
		},
		Status: agentzv1alpha1.MCPConnectionStatus{
			State:         agentzv1alpha1.MCPConnectionStateAccepted,
			LastProbeTime: &lastProbeTime,
			Conditions: []metav1.Condition{{
				Type:   internalmcp.ConditionProbeHealthy,
				Status: metav1.ConditionTrue,
			}},
		},
	}
	svc := &Service{
		queries: &sandboxQueries{},
		cfg: Config{
			MCPProbeStaleAfter: time.Minute,
		},
		k8sClient: fake.NewClientBuilder().WithScheme(scheme).WithObjects(conn).Build(),
	}
	workspace := gatewaydb.Workspace{
		ID:             testWorkspaceID,
		OrganizationID: testOrganizationID,
		Namespace:      testWorkspaceNS,
	}

	resources, err := svc.workspaceInheritedResources(
		context.Background(),
		workspace,
		gatewayapi.InheritedResourceTypeMCPConnection,
	)
	if err != nil {
		t.Fatalf("list inherited MCP connections: %v", err)
	}
	if len(resources) != 1 {
		t.Fatalf("resources = %#v, want one MCP connection", resources)
	}
	if resources[0].Status != gatewayapi.ResourceLifecycleReady {
		t.Fatalf("status = %q, want Ready for a healthy MCP probe", resources[0].Status)
	}
}
