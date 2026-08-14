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
	"crypto/sha256"
	"encoding/hex"
)

// ResourceScope identifies the infrastructure scope containing a resource.
// +kubebuilder:validation:Enum=Organisation;Workspace
type ResourceScope string

const (
	// ResourceScopeOrganisation selects the current Organisation namespace.
	ResourceScopeOrganisation ResourceScope = "Organisation"
	// ResourceScopeWorkspace selects the current Workspace namespace.
	ResourceScopeWorkspace ResourceScope = "Workspace"
)

// ResourceReference identifies a resource by scope and metadata name.
type ResourceReference struct {
	// Scope selects the current Organisation or Workspace namespace.
	Scope ResourceScope `json:"scope"`

	// Name is the immutable Kubernetes metadata name of the resource.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Name string `json:"name"`
}

// ScopeNamespace returns the deterministic namespace for a stable scope ID.
// Hashing the typed scope keeps display names out of infrastructure identity
// and separates identical Organisation and Workspace IDs. It panics when scope
// is not a supported ResourceScope because callers must use the declared enum.
func ScopeNamespace(scope ResourceScope, stableID string) string {
	sum := sha256.Sum256([]byte(string(scope) + "\x00" + stableID))
	digest := hex.EncodeToString(sum[:16])

	switch scope {
	case ResourceScopeOrganisation:
		return "org-" + digest
	case ResourceScopeWorkspace:
		return "ws-" + digest
	default:
		panic("unsupported ResourceScope " + scope)
	}
}
