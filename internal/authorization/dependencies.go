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

package authorization

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

// ErrInvalidGrant identifies a resource, action, or scope outside the permission matrix.
var ErrInvalidGrant = errors.New("invalid permission grant")

// Grant is one expanded allow-only capability in an exact scope.
type Grant struct {
	Scope    Scope
	Resource gatewaydb.PermissionResource
	Action   gatewaydb.PermissionAction
	Locked   bool
}

// Expand validates grants and returns their complete dependency closure.
// Locked is recomputed and is true while another selected grant implies the row.
func Expand(grants []Grant) ([]Grant, error) {
	selected := make(map[Grant]struct{}, len(grants))
	locked := map[Grant]struct{}{}
	queue := make([]Grant, 0, len(grants))
	for _, grant := range grants {
		grant.Locked = false
		if err := validateGrant(grant); err != nil {
			return nil, err
		}
		if _, ok := selected[grant]; ok {
			continue
		}
		selected[grant] = struct{}{}
		queue = append(queue, grant)
	}

	for len(queue) > 0 {
		grant := queue[0]
		queue = queue[1:]
		for _, dependency := range dependencies(grant) {
			locked[dependency] = struct{}{}
			if _, ok := selected[dependency]; ok {
				continue
			}
			selected[dependency] = struct{}{}
			queue = append(queue, dependency)
		}
	}

	expanded := make([]Grant, 0, len(selected))
	for grant := range selected {
		_, grant.Locked = locked[grant]
		expanded = append(expanded, grant)
	}
	slices.SortFunc(expanded, func(a, b Grant) int {
		if cmp := strings.Compare(a.Scope.OrganizationID, b.Scope.OrganizationID); cmp != 0 {
			return cmp
		}
		if cmp := strings.Compare(a.Scope.WorkspaceID, b.Scope.WorkspaceID); cmp != 0 {
			return cmp
		}
		if cmp := strings.Compare(string(a.Resource), string(b.Resource)); cmp != 0 {
			return cmp
		}
		return strings.Compare(string(a.Action), string(b.Action))
	})
	return expanded, nil
}

func validateGrant(grant Grant) error {
	if grant.Scope.OrganizationID == "" {
		return fmt.Errorf("%w: Organisation ID is required", ErrInvalidGrant)
	}
	if !resourceAvailable(grant.Resource, grant.Scope.WorkspaceID != "") {
		return fmt.Errorf(
			"%w: resource %q is unavailable in the selected scope",
			ErrInvalidGrant,
			grant.Resource,
		)
	}
	if !actionAvailable(grant.Resource, grant.Action) {
		return fmt.Errorf(
			"%w: action %q is unavailable for resource %q",
			ErrInvalidGrant,
			grant.Action,
			grant.Resource,
		)
	}
	return nil
}

func resourceAvailable(resource gatewaydb.PermissionResource, workspace bool) bool {
	switch resource {
	case gatewaydb.PermissionResourceMcpConnection,
		gatewaydb.PermissionResourceSkill,
		gatewaydb.PermissionResourceSandbox,
		gatewaydb.PermissionResourceInferenceProvider:
		return true
	case gatewaydb.PermissionResourceInferencePool,
		gatewaydb.PermissionResourceAgent,
		gatewaydb.PermissionResourceApiKey,
		gatewaydb.PermissionResourceObservability:
		return workspace
	default:
		return false
	}
}

func actionAvailable(resource gatewaydb.PermissionResource, action gatewaydb.PermissionAction) bool {
	switch resource {
	case gatewaydb.PermissionResourceMcpConnection, gatewaydb.PermissionResourceApiKey:
		return action == gatewaydb.PermissionActionRead ||
			action == gatewaydb.PermissionActionCreate ||
			action == gatewaydb.PermissionActionDelete
	case gatewaydb.PermissionResourceSkill,
		gatewaydb.PermissionResourceSandbox,
		gatewaydb.PermissionResourceInferenceProvider,
		gatewaydb.PermissionResourceInferencePool:
		return action == gatewaydb.PermissionActionRead ||
			action == gatewaydb.PermissionActionCreate ||
			action == gatewaydb.PermissionActionModify ||
			action == gatewaydb.PermissionActionDelete
	case gatewaydb.PermissionResourceObservability:
		return action == gatewaydb.PermissionActionRead
	case gatewaydb.PermissionResourceAgent:
		switch action {
		case gatewaydb.PermissionActionAuthor,
			gatewaydb.PermissionActionShareAuthored,
			gatewaydb.PermissionActionShareNonAuthored,
			gatewaydb.PermissionActionUseShared,
			gatewaydb.PermissionActionReadSharedSecret,
			gatewaydb.PermissionActionWriteSharedSecret,
			gatewaydb.PermissionActionDeleteSharedSecret:
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func dependencies(grant Grant) []Grant {
	dependency := func(resource gatewaydb.PermissionResource, action gatewaydb.PermissionAction) Grant {
		return Grant{Scope: grant.Scope, Resource: resource, Action: action}
	}

	result := []Grant{}
	switch grant.Action {
	case gatewaydb.PermissionActionCreate:
		result = append(result, dependency(grant.Resource, gatewaydb.PermissionActionRead))
	case gatewaydb.PermissionActionModify:
		result = append(result, dependency(grant.Resource, gatewaydb.PermissionActionCreate))
	case gatewaydb.PermissionActionDelete:
		if grant.Resource != gatewaydb.PermissionResourceAgent {
			result = append(result, dependency(grant.Resource, gatewaydb.PermissionActionCreate))
			if actionAvailable(grant.Resource, gatewaydb.PermissionActionModify) {
				result = append(result, dependency(grant.Resource, gatewaydb.PermissionActionModify))
			}
		}
	case gatewaydb.PermissionActionAuthor:
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceSandbox, gatewaydb.PermissionActionRead),
			dependency(gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionRead),
		)
	case gatewaydb.PermissionActionShareNonAuthored,
		gatewaydb.PermissionActionReadSharedSecret:
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionUseShared),
		)
	case gatewaydb.PermissionActionWriteSharedSecret:
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionReadSharedSecret),
		)
	case gatewaydb.PermissionActionDeleteSharedSecret:
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceAgent, gatewaydb.PermissionActionWriteSharedSecret),
		)
	}

	if grant.Resource == gatewaydb.PermissionResourceSandbox &&
		(grant.Action == gatewaydb.PermissionActionCreate ||
			grant.Action == gatewaydb.PermissionActionModify) {
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceMcpConnection, gatewaydb.PermissionActionRead),
			dependency(gatewaydb.PermissionResourceSkill, gatewaydb.PermissionActionRead),
			dependency(gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionRead),
		)
		if grant.Scope.WorkspaceID != "" {
			result = append(
				result,
				dependency(gatewaydb.PermissionResourceInferencePool, gatewaydb.PermissionActionRead),
			)
		}
	}
	if grant.Resource == gatewaydb.PermissionResourceInferencePool &&
		(grant.Action == gatewaydb.PermissionActionCreate ||
			grant.Action == gatewaydb.PermissionActionModify) {
		result = append(
			result,
			dependency(gatewaydb.PermissionResourceInferenceProvider, gatewaydb.PermissionActionRead),
		)
	}
	return result
}
