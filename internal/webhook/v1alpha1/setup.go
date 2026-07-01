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

package v1alpha1

import (
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	agentwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/agent"
	environmentwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/environment"
	mcpconnwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/mcpconn"
	secretwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/secret"
	tenantwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/tenant"
	workflowrunwebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/workflowrun"
	workflowschedulewebhook "github.com/accuknox/clawarmor/internal/webhook/v1alpha1/workflowschedule"
)

// AgentWebhookConfig configures Agent defaulting behavior.
type AgentWebhookConfig = agentwebhook.WebhookConfig

// SetupAgentWebhookWithManager registers the webhook for Agent in the manager.
func SetupAgentWebhookWithManager(mgr ctrl.Manager, cfg AgentWebhookConfig) error {
	return agentwebhook.RegisterWithManager(mgr, cfg)
}

// SetupEnvironmentWebhookWithManager registers the webhook for Environment in the manager.
func SetupEnvironmentWebhookWithManager(mgr ctrl.Manager) error {
	return environmentwebhook.RegisterWithManager(mgr)
}

// SetupWorkflowScheduleWebhookWithManager registers the WorkflowSchedule webhook.
func SetupWorkflowScheduleWebhookWithManager(mgr ctrl.Manager, gatewayClient *gatewayapi.ClientWithResponses, tokenPath string) error {
	return workflowschedulewebhook.RegisterWithManager(mgr, gatewayClient, tokenPath)
}

// SetupWorkflowRunWebhookWithManager registers the WorkflowRun webhook.
func SetupWorkflowRunWebhookWithManager(mgr ctrl.Manager, gatewayClient *gatewayapi.ClientWithResponses, tokenPath string) error {
	return workflowrunwebhook.RegisterWithManager(mgr, gatewayClient, tokenPath)
}

// SetupMCPConnectionWebhookWithManager registers the MCPConnection webhook.
func SetupMCPConnectionWebhookWithManager(mgr ctrl.Manager, kubeClient client.Client) error {
	return mcpconnwebhook.RegisterWithManager(mgr, kubeClient)
}

// SetupTenantWebhookWithManager registers the Tenant webhook.
func SetupTenantWebhookWithManager(mgr ctrl.Manager) error {
	return tenantwebhook.RegisterWithManager(mgr)
}

// SetupSecretWebhookWithManager registers the Secret webhook.
func SetupSecretWebhookWithManager(mgr ctrl.Manager) error {
	return secretwebhook.RegisterWithManager(mgr)
}
