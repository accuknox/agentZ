package workspace

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type validateWorkspaceCreateCase struct {
	name       string
	objectName string
	wantErr    bool
}

func TestValidatorBindsWorkspaceNameToStableID(t *testing.T) {
	t.Parallel()

	workspaceID := "workspace_01k1qj89d7n39xbwwkz0pxz5k2"
	validName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		workspaceID,
	)
	tests := []validateWorkspaceCreateCase{
		{name: "stable workspace identity", objectName: validName},
		{
			name: "organization scope hash",
			objectName: agentzv1alpha1.ScopeNamespace(
				agentzv1alpha1.ResourceScopeOrganisation,
				workspaceID,
			),
			wantErr: true,
		},
		{name: "display alias", objectName: "platform-team", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(
			tt.name,
			func(t *testing.T) {
				t.Parallel()
				obj := &agentzv1alpha1.Workspace{
					ObjectMeta: metav1.ObjectMeta{Name: tt.objectName},
					Spec: agentzv1alpha1.WorkspaceSpec{
						WorkspaceID:    workspaceID,
						OrganizationID: "organization_01k1qj8ke5vsxg64ns0g13m87v",
					},
				}

				_, err := (&Validator{}).ValidateCreate(context.Background(), obj)
				if (err != nil) != tt.wantErr {
					t.Fatalf("ValidateCreate() error = %v, wantErr %v", err, tt.wantErr)
				}
			},
		)
	}
}
