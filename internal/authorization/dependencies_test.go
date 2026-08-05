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

package authorization_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
)

func TestExpandPermissionDependencies(t *testing.T) {
	t.Parallel()

	organization := authorization.Scope{OrganizationID: "organization-a"}
	workspace := authorization.Scope{
		OrganizationID: "organization-a",
		WorkspaceID:    "workspace-a",
	}
	tests := []struct {
		name  string
		input []authorization.Grant
		want  map[authorization.Grant]bool
	}{
		{
			name: "Read has no dependency",
			input: []authorization.Grant{{
				Scope: organization, Resource: gatewaydb.PermissionResourceSkill,
				Action: gatewaydb.PermissionActionRead, Locked: true,
			}},
			want: map[authorization.Grant]bool{
				{Scope: organization, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}: false,
			},
		},
		{
			name: "Modify expands ordinary action chain",
			input: []authorization.Grant{{
				Scope: organization, Resource: gatewaydb.PermissionResourceSkill,
				Action: gatewaydb.PermissionActionModify,
			}},
			want: map[authorization.Grant]bool{
				{Scope: organization, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}:   true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionCreate}: true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionModify}: false,
			},
		},
		{
			name: "Delete expands every available ordinary action",
			input: []authorization.Grant{{
				Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox,
				Action: gatewaydb.PermissionActionDelete,
			}},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionRead}:           true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionCreate}:         true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionModify}:         true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionDelete}:         false,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceMcpConnection, Action: gatewaydb.PermissionActionRead}:     true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}:             true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferenceProvider, Action: gatewaydb.PermissionActionRead}: true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferencePool, Action: gatewaydb.PermissionActionRead}:     true,
			},
		},
		{
			name: "Delete skips unavailable Modify",
			input: []authorization.Grant{{
				Scope: organization, Resource: gatewaydb.PermissionResourceMcpConnection,
				Action: gatewaydb.PermissionActionDelete,
			}},
			want: map[authorization.Grant]bool{
				{Scope: organization, Resource: gatewaydb.PermissionResourceMcpConnection, Action: gatewaydb.PermissionActionRead}:   true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceMcpConnection, Action: gatewaydb.PermissionActionCreate}: true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceMcpConnection, Action: gatewaydb.PermissionActionDelete}: false,
			},
		},
		{
			name: "Organisation Sandbox omits Workspace-only Pool",
			input: []authorization.Grant{{
				Scope: organization, Resource: gatewaydb.PermissionResourceSandbox,
				Action: gatewaydb.PermissionActionCreate,
			}},
			want: map[authorization.Grant]bool{
				{Scope: organization, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionRead}:           true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionCreate}:         false,
				{Scope: organization, Resource: gatewaydb.PermissionResourceMcpConnection, Action: gatewaydb.PermissionActionRead}:     true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}:             true,
				{Scope: organization, Resource: gatewaydb.PermissionResourceInferenceProvider, Action: gatewaydb.PermissionActionRead}: true,
			},
		},
		{
			name: "Inference Pool adds Provider Read",
			input: []authorization.Grant{{
				Scope: workspace, Resource: gatewaydb.PermissionResourceInferencePool,
				Action: gatewaydb.PermissionActionModify,
			}},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferencePool, Action: gatewaydb.PermissionActionRead}:     true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferencePool, Action: gatewaydb.PermissionActionCreate}:   true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferencePool, Action: gatewaydb.PermissionActionModify}:   false,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceInferenceProvider, Action: gatewaydb.PermissionActionRead}: true,
			},
		},
		{
			name: "Agent Author adds resource Reads",
			input: []authorization.Grant{{
				Scope: workspace, Resource: gatewaydb.PermissionResourceAgent,
				Action: gatewaydb.PermissionActionAuthor,
			}},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionAuthor}: false,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSandbox, Action: gatewaydb.PermissionActionRead}: true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}:   true,
			},
		},
		{
			name: "Agent secret deletion expands full chain",
			input: []authorization.Grant{{
				Scope: workspace, Resource: gatewaydb.PermissionResourceAgent,
				Action: gatewaydb.PermissionActionDeleteSharedSecret,
			}},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionUseShared}:          true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionReadSharedSecret}:   true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionWriteSharedSecret}:  true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionDeleteSharedSecret}: false,
			},
		},
		{
			name: "Share non-authored implies Use Shared",
			input: []authorization.Grant{{
				Scope: workspace, Resource: gatewaydb.PermissionResourceAgent,
				Action: gatewaydb.PermissionActionShareNonAuthored,
			}},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionUseShared}:        true,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceAgent, Action: gatewaydb.PermissionActionShareNonAuthored}: false,
			},
		},
		{
			name: "Explicit dependency remains locked while stronger action exists",
			input: []authorization.Grant{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionCreate},
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead},
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead},
			},
			want: map[authorization.Grant]bool{
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionCreate}: false,
				{Scope: workspace, Resource: gatewaydb.PermissionResourceSkill, Action: gatewaydb.PermissionActionRead}:   true,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			expanded, err := authorization.Expand(tt.input)
			if err != nil {
				t.Fatalf("Expand() error = %v", err)
			}
			if len(expanded) != len(tt.want) {
				t.Fatalf("Expand() returned %d grants, want %d: %#v", len(expanded), len(tt.want), expanded)
			}
			for _, grant := range expanded {
				unlocked := grant
				unlocked.Locked = false
				wantLocked, ok := tt.want[unlocked]
				if !ok {
					t.Errorf("Expand() returned unexpected grant %#v", grant)
					continue
				}
				if grant.Locked != wantLocked {
					t.Errorf("Expand() grant %#v Locked = %t, want %t", unlocked, grant.Locked, wantLocked)
				}
			}
		})
	}
}

func TestExpandIsIdempotent(t *testing.T) {
	t.Parallel()

	scope := authorization.Scope{
		OrganizationID: "organization-a",
		WorkspaceID:    "workspace-a",
	}
	first, err := authorization.Expand([]authorization.Grant{
		{
			Scope: scope, Resource: gatewaydb.PermissionResourceSandbox,
			Action: gatewaydb.PermissionActionModify,
		},
		{
			Scope: scope, Resource: gatewaydb.PermissionResourceAgent,
			Action: gatewaydb.PermissionActionDeleteSharedSecret,
		},
		{
			Scope: scope, Resource: gatewaydb.PermissionResourceAgent,
			Action: gatewaydb.PermissionActionShareAuthored,
		},
	})
	if err != nil {
		t.Fatalf("first Expand() error = %v", err)
	}
	second, err := authorization.Expand(first)
	if err != nil {
		t.Fatalf("second Expand() error = %v", err)
	}
	if !slices.Equal(first, second) {
		t.Fatalf("Expand(Expand(grants)) = %#v, want %#v", second, first)
	}
}

func TestExpandRejectsInvalidMatrixEntries(t *testing.T) {
	t.Parallel()

	workspace := authorization.Scope{
		OrganizationID: "organization-a",
		WorkspaceID:    "workspace-a",
	}
	tests := []struct {
		name  string
		grant authorization.Grant
	}{
		{
			name: "Missing Organisation",
			grant: authorization.Grant{
				Scope:    authorization.Scope{WorkspaceID: "workspace-a"},
				Resource: gatewaydb.PermissionResourceSkill,
				Action:   gatewaydb.PermissionActionRead,
			},
		},
		{
			name: "Workspace-only resource in Organisation",
			grant: authorization.Grant{
				Scope:    authorization.Scope{OrganizationID: "organization-a"},
				Resource: gatewaydb.PermissionResourceInferencePool,
				Action:   gatewaydb.PermissionActionRead,
			},
		},
		{
			name: "Unavailable Modify",
			grant: authorization.Grant{
				Scope: workspace, Resource: gatewaydb.PermissionResourceMcpConnection,
				Action: gatewaydb.PermissionActionModify,
			},
		},
		{
			name: "Observability mutation",
			grant: authorization.Grant{
				Scope: workspace, Resource: gatewaydb.PermissionResourceObservability,
				Action: gatewaydb.PermissionActionCreate,
			},
		},
		{
			name: "Ordinary Agent action",
			grant: authorization.Grant{
				Scope: workspace, Resource: gatewaydb.PermissionResourceAgent,
				Action: gatewaydb.PermissionActionRead,
			},
		},
		{
			name: "Unknown resource",
			grant: authorization.Grant{
				Scope: workspace, Resource: "unknown",
				Action: gatewaydb.PermissionActionRead,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := authorization.Expand([]authorization.Grant{tt.grant})
			if !errors.Is(err, authorization.ErrInvalidGrant) {
				t.Fatalf("Expand() error = %v, want ErrInvalidGrant", err)
			}
		})
	}
}
