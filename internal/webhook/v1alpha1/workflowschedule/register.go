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

package workflowschedule

import (
	ctrl "sigs.k8s.io/controller-runtime"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// RegisterWithManager registers the WorkflowSchedule webhook.
func RegisterWithManager(mgr ctrl.Manager, gatewayClient *gatewayapi.ClientWithResponses, tokenPath string) error {
	return ctrl.NewWebhookManagedBy(mgr, &agentzv1alpha1.WorkflowSchedule{}).
		WithValidator(NewValidator(gatewayClient, tokenPath)).
		WithDefaulter(&Defaulter{}).
		Complete()
}
