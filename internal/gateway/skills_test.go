package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestReadSkillUploadReportsSpoolFailureAsInternal(t *testing.T) {
	notDirectory := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notDirectory, nil, 0o600); err != nil {
		t.Fatalf("create non-directory temp path: %v", err)
	}
	t.Setenv("TMPDIR", notDirectory)

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "SKILL.md")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	content := []byte("---\nname: valid-skill\ndescription: A valid skill.\n---\n")
	if _, err := file.Write(content); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := form.Close(); err != nil {
		t.Fatalf("close multipart form: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/skill/import/preview", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	res := httptest.NewRecorder()
	if _, ok := readSkillUpload(res, req); ok {
		t.Fatal("upload succeeded")
	}
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusInternalServerError)
	}

	var response gatewayapi.Error
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != "internal_error" {
		t.Fatalf("code = %q, want internal_error", response.Code)
	}
}

func TestReadSkillUploadDiagnostics(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		filename   string
		content    []byte
		wantStatus int
		wantCode   string
		wantField  string
	}{
		{
			name:       "standalone markdown metadata",
			filename:   "SKILL.md",
			content:    []byte("---\nname: " + strings.Repeat("a", 64) + "\ndescription: Too long.\n---\n"),
			wantStatus: http.StatusBadRequest,
			wantCode:   "malformed_skill_metadata",
			wantField:  "file:SKILL.md",
		},
		{
			name:       "invalid archive",
			filename:   "skills.zip",
			content:    []byte("not a ZIP archive"),
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_archive",
			wantField:  "file:skills.zip",
		},
		{
			name:       "markdown limit",
			filename:   "SKILL.md",
			content:    bytes.Repeat([]byte("x"), (64<<10)+1),
			wantStatus: http.StatusRequestEntityTooLarge,
			wantCode:   "upload_too_large",
			wantField:  "file:SKILL.md",
		},
		{
			name:       "unsupported file",
			filename:   "SKILL.txt",
			content:    []byte("skill"),
			wantStatus: http.StatusBadRequest,
			wantCode:   "unsupported_file_type",
			wantField:  "file:SKILL.txt",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			file, err := form.CreateFormFile("file", tt.filename)
			if err != nil {
				t.Fatalf("create file part: %v", err)
			}
			if _, err := file.Write(tt.content); err != nil {
				t.Fatalf("write file part: %v", err)
			}
			if err := form.Close(); err != nil {
				t.Fatalf("close multipart form: %v", err)
			}

			req := httptest.NewRequest(http.MethodPost, "/api/skills/import", &body)
			req.Header.Set("Content-Type", form.FormDataContentType())
			res := httptest.NewRecorder()
			if _, ok := readSkillUpload(res, req); ok {
				t.Fatal("upload succeeded")
			}
			if res.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", res.Code, tt.wantStatus)
			}

			var response gatewayapi.Error
			if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q", response.Code, tt.wantCode)
			}
			if response.Errors == nil || len(*response.Errors) != 1 {
				t.Fatalf("errors = %#v, want one field error", response.Errors)
			}
			if got := (*response.Errors)[0].Field; got != tt.wantField {
				t.Fatalf("field = %q, want %q", got, tt.wantField)
			}
		})
	}
}

// skillDeleteQueries records audit results while reusing scope fixtures.
type skillDeleteQueries struct {
	sandboxQueries
	events []gatewaydb.GatewayCreateEventTrailEventParams
}

// GatewayCreateEventTrailEvent captures the handler audit without a database.
func (q *skillDeleteQueries) GatewayCreateEventTrailEvent(_ context.Context, arg gatewaydb.GatewayCreateEventTrailEventParams) (gatewaydb.EventTrailEvent, error) {
	q.events = append(q.events, arg)
	return gatewaydb.EventTrailEvent{}, nil
}

func TestSkillDeleteRequiresDetachment(t *testing.T) {
	for _, path := range []string{"/api/skill/used", "/api/skill"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			queries := &skillDeleteQueries{sandboxQueries: sandboxQueries{
				permissions: []gatewaydb.GatewayResolvePermissionsRow{{
					Active:      true,
					WorkspaceID: pgtype.Text{String: testWorkspaceID, Valid: true},
					Resource: gatewaydb.NullPermissionResource{
						PermissionResource: gatewaydb.PermissionResourceSkill, Valid: true,
					},
					Action: gatewaydb.NullPermissionAction{
						PermissionAction: gatewaydb.PermissionActionDelete, Valid: true,
					},
				}},
				workspace: gatewaydb.Workspace{
					ID: testWorkspaceID, OrganizationID: testOrganizationID,
					Namespace: testWorkspaceNS, State: gatewaydb.WorkspaceStateReady,
				},
			}}
			svc := sandboxTestService(t, queries)
			for _, name := range []string{"free", "used"} {
				item := &agentzv1alpha1.Skill{ObjectMeta: metav1.ObjectMeta{
					Name: name, Namespace: testWorkspaceNS,
					Finalizers: []string{"agentz.accuknox.com/immutable-skill"},
				}}
				if err := svc.k8sClient.Create(t.Context(), item); err != nil {
					t.Fatal(err)
				}
			}
			agt := &agentzv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: "consumer", Namespace: testWorkspaceNS},
				Spec: agentzv1alpha1.AgentSpec{Skills: []agentzv1alpha1.ResourceReference{{
					Name: "used", Scope: agentzv1alpha1.ResourceScopeWorkspace,
				}}},
			}
			if err := svc.k8sClient.Create(t.Context(), agt); err != nil {
				t.Fatal(err)
			}
			router := chi.NewRouter()
			gatewayapi.HandlerWithOptions(svc, gatewayapi.ChiServerOptions{
				BaseRouter: router, Middlewares: []gatewayapi.MiddlewareFunc{sandboxTestAuth},
			})
			for _, status := range []int{http.StatusConflict, http.StatusNoContent} {
				req := httptest.NewRequest(http.MethodDelete, path,
					strings.NewReader(`{"skill_names":["free","used"]}`))
				req.Header.Set("X-AgentZ-Workspace-ID", testWorkspaceID)
				req.Header.Set("Content-Type", "application/json")
				res := httptest.NewRecorder()
				router.ServeHTTP(res, req)
				if res.Code != status {
					t.Fatalf("status = %d, want %d: %s", res.Code, status, res.Body)
				}
				if status == http.StatusNoContent {
					continue
				}
				var response gatewayapi.Error
				if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if response.Code != "skill_in_use" || !strings.Contains(response.Message, "consumer") {
					t.Fatalf("conflict does not identify the consumer: %+v", response)
				}
				for _, name := range []string{"free", "used"} {
					var item agentzv1alpha1.Skill
					key := ctrlclient.ObjectKey{Namespace: testWorkspaceNS, Name: name}
					if err := svc.k8sClient.Get(t.Context(), key, &item); err != nil {
						t.Fatal(err)
					}
					if !item.DeletionTimestamp.IsZero() {
						t.Fatalf("conflicting request started deleting %q", name)
					}
				}
				if len(queries.events) != 1 || queries.events[0].Result != gatewaydb.EventTrailResultFailed {
					t.Fatalf("conflict audit = %+v", queries.events)
				}
				agt.Spec.Skills = nil
				if err := svc.k8sClient.Update(t.Context(), agt); err != nil {
					t.Fatal(err)
				}
			}
			var item agentzv1alpha1.Skill
			key := ctrlclient.ObjectKey{Namespace: testWorkspaceNS, Name: "used"}
			if err := svc.k8sClient.Get(t.Context(), key, &item); err != nil {
				t.Fatal(err)
			}
			if item.DeletionTimestamp.IsZero() {
				t.Fatal("detached skill was not deleted")
			}
		})
	}
}
