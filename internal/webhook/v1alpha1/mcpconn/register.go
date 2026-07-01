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

package mcpconn

import (
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// RegisterWithManager registers the MCPConnection webhook with the manager.
func RegisterWithManager(mgr ctrl.Manager, kubeClient client.Client) error {
	return ctrl.NewWebhookManagedBy(mgr, &agentzv1alpha1.MCPConnection{}).
		WithValidator(NewValidator(kubeClient)).
		WithDefaulter(NewDefaulter()).
		Complete()
}
