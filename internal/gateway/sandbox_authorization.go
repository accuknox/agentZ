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
	"net/http"

	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type sandboxAudit struct {
	access resourceAccess
	name   string
	result gatewaydb.AuditResult
}

func (s *Service) resolveSandboxAccess(ctx context.Context, workspaceID, sandboxName string, operation authorization.Operation) (resourceAccess, *apiError) {
	creatorFallback := authorization.Operation("")
	var isCreator func(context.Context, string, string) (bool, error)
	if sandboxName != "" && (operation == authorization.OperationUpdateSandbox || operation == authorization.OperationDeleteSandbox) {
		creatorFallback = authorization.OperationCreateSandbox
		isCreator = func(ctx context.Context, namespace, userID string) (bool, error) {
			sandbox := &agentzv1alpha1.Sandbox{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: sandboxName, Namespace: namespace}, sandbox)
			return sandbox.Spec.CreatorUserID == userID, err
		}
	}
	access, apiErr := s.resolveResourceAccess(ctx, resourceAccessRequest{
		resource:        "Sandbox",
		workspaceID:     workspaceID,
		operation:       operation,
		creatorFallback: creatorFallback,
		isCreator:       isCreator,
	})
	return access, apiErr
}

func (s *Service) createSandboxAudit(ctx context.Context, r *http.Request, audit sandboxAudit) error {
	return s.createResourceAudit(
		ctx,
		r,
		audit.access,
		gatewaydb.AuditTargetSandbox,
		audit.name,
		"sandbox",
		sandboxOperationAction(audit.access.operation),
		audit.result,
	)
}

func sandboxOperationAction(operation authorization.Operation) string {
	switch operation {
	case authorization.OperationCreateSandbox:
		return "create"
	case authorization.OperationUpdateSandbox:
		return "modify"
	case authorization.OperationDeleteSandbox:
		return "delete"
	default:
		return "unmapped"
	}
}
