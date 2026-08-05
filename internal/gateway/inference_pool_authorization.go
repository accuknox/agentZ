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
	"errors"
	"net/http"

	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) resolveInferencePoolAccess(ctx context.Context, workspaceID, name string, operation authorization.Operation) (resourceAccess, *apiError) {
	if workspaceID == "" {
		return resourceAccess{operation: operation}, resourceForbidden(errors.New("Inference Pool requires a Workspace scope"))
	}
	req := resourceAccessRequest{
		resource:    "Inference Pool",
		workspaceID: workspaceID,
		operation:   operation,
	}
	if name != "" && (operation == authorization.OperationUpdateInferencePool || operation == authorization.OperationDeleteInferencePool) {
		req.creatorFallback = authorization.OperationCreateInferencePool
		req.isCreator = func(ctx context.Context, namespace, userID string) (bool, error) {
			pool := &agentzv1alpha1.InferencePool{}
			err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name, Namespace: namespace}, pool)
			return pool.Spec.CreatorUserID == userID, err
		}
	}
	return s.resolveResourceAccess(ctx, req)
}

func (s *Service) createInferencePoolAudit(ctx context.Context, r *http.Request, access resourceAccess, name string, result gatewaydb.AuditResult) error {
	action := "unmapped"
	switch access.operation {
	case authorization.OperationCreateInferencePool:
		action = "create"
	case authorization.OperationUpdateInferencePool:
		action = "modify"
	case authorization.OperationDeleteInferencePool:
		action = "delete"
	}
	return s.createResourceAudit(
		ctx,
		r,
		access,
		gatewaydb.AuditTargetInferencePool,
		name,
		"inference_pool",
		action,
		result,
	)
}
