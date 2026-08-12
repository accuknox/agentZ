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
	"fmt"
	"net/http"

	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) resolveMCPAccess(ctx context.Context, workspaceID, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	creatorFallback := authorization.Operation("")
	switch operation {
	case authorization.OperationListMCPConnections,
		authorization.OperationWatchMCPConnections,
		authorization.OperationGetMCPConnection,
		authorization.OperationCreateMCPConnection:
	case authorization.OperationDeleteMCPConnection:
		creatorFallback = authorization.OperationCreateMCPConnection
	default:
		return resourceAccess{workspaceID: workspaceID, operation: operation},
			resourceForbidden(fmt.Errorf("MCP Connection operation %q is unknown", operation))
	}
	_, mapped := operation.BearerScope()
	if !mapped {
		return resourceAccess{workspaceID: workspaceID, operation: operation},
			resourceForbidden(fmt.Errorf("MCP Connection operation %q is unmapped", operation))
	}

	return s.resolveResourceAccess(ctx, resourceAccessRequest{
		resource:        "MCP Connection",
		workspaceID:     workspaceID,
		operation:       operation,
		creatorFallback: creatorFallback,
		isCreator: func(ctx context.Context, namespace, userID string) (bool, error) {
			conn := &agentzv1alpha1.MCPConnection{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name, Namespace: namespace}, conn)
			if err != nil {
				return false, err
			}
			return conn.Spec.CreatorUserID == userID, nil
		},
	})
}

func (s *Service) createMCPEventTrail(ctx context.Context, r *http.Request, access resourceAccess, name string, result gatewaydb.EventTrailResult) error {
	return s.createResourceEventTrail(
		ctx,
		r,
		access,
		gatewaydb.EventTrailTargetMcpConnection,
		name,
		"mcp_connection",
		mcpOperationAction(access.operation),
		result,
	)
}

func mcpOperationAction(operation authorization.Operation) string {
	switch operation {
	case authorization.OperationCreateMCPConnection:
		return "create"
	case authorization.OperationDeleteMCPConnection:
		return "delete"
	default:
		return "unmapped"
	}
}
