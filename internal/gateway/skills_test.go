package gateway

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestReadSkillUploadSpoolsMultipartAndPreservesFields(t *testing.T) {
	t.Parallel()

	doc := []byte("---\nname: deploy\ndescription: Deploy safely.\n---\n\n# Deploy\n")
	req := skillUploadRequest(t, "deploy.md", doc, map[string][]string{
		"agents": {"agent-one", "agent-two"},
	})
	recorder := httptest.NewRecorder()
	bundle, ok := readSkillUpload(recorder, req)
	if !ok {
		t.Fatalf("readSkillUpload() status = %d, body = %s", recorder.Code, recorder.Body)
	}
	if len(bundle.Skills) != 1 || bundle.Skills[0].Name != "deploy" {
		t.Fatalf("bundle = %#v", bundle)
	}
	if got := req.MultipartForm.Value["agents"]; len(got) != 2 {
		t.Fatalf("agents = %#v, want two values", got)
	}
}

func TestReadSkillUploadReturnsStableMetadataError(t *testing.T) {
	t.Parallel()

	req := skillUploadRequest(t, "deploy.md", []byte("not frontmatter"), nil)
	recorder := httptest.NewRecorder()
	if _, ok := readSkillUpload(recorder, req); ok {
		t.Fatal("readSkillUpload() succeeded, want malformed metadata error")
	}
	var body gatewayapi.Error
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if recorder.Code != 400 || body.Code != "malformed_skill_metadata" {
		t.Fatalf("status = %d, code = %q", recorder.Code, body.Code)
	}
}

func skillUploadRequest(t *testing.T, filename string, content []byte, fields map[string][]string) *http.Request {
	t.Helper()

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	file, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := file.Write(content); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	for name, values := range fields {
		for _, value := range values {
			if err := w.WriteField(name, value); err != nil {
				t.Fatalf("write %s field: %v", name, err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart body: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/skill/import/preview", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req
}
