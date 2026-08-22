package gateway

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
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
