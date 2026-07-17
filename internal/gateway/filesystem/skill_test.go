package filesystem

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/skill"
)

func TestMutableSkillsListDeleteAndExport(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	for _, name := range []string{"deploy", "release"} {
		skillDir := filepath.Join(dir, ".agents", "skills", name)
		if err := os.MkdirAll(skillDir, 0o755); err != nil {
			t.Fatalf("create skill directory: %v", err)
		}
		doc := "---\nname: " + name + "\ndescription: description\n---\n\n# Body\n"
		if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(doc), 0o644); err != nil {
			t.Fatalf("write skill: %v", err)
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Errorf("close root: %v", err)
		}
	})
	svc := &service{root: root}

	list := httptest.NewRecorder()
	svc.routes().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/skill?limit=1", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}
	var page gatewayapi.ListMutableSkillsResponse
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(page.Skills) != 1 || page.Skills[0].Name != "deploy" || page.NextPageToken == "" {
		t.Fatalf("page = %#v", page)
	}

	body, err := json.Marshal(gatewayapi.ExportSkillsRequest{SkillNames: []gatewayapi.SkillName{"release"}})
	if err != nil {
		t.Fatalf("encode export request: %v", err)
	}
	exported := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/skill/export", bytes.NewReader(body))
	svc.routes().ServeHTTP(exported, req)
	if exported.Code != http.StatusOK {
		t.Fatalf("export status = %d, body = %s", exported.Code, exported.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(exported.Body.Bytes()), int64(exported.Body.Len()))
	if err != nil {
		t.Fatalf("read export: %v", err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "release/SKILL.md" {
		t.Fatalf("export entries = %#v", zr.File)
	}
	body, err = json.Marshal(gatewayapi.DeleteSkillsRequest{SkillNames: []gatewayapi.SkillName{"deploy"}})
	if err != nil {
		t.Fatalf("encode delete request: %v", err)
	}
	deleted := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/skill", bytes.NewReader(body))
	svc.routes().ServeHTTP(deleted, req)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, ".agents", "skills", "deploy")); !os.IsNotExist(err) {
		t.Fatalf("deleted skill stat error = %v", err)
	}
}

func TestMutableSkillsImportCanonicalTree(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Errorf("close root: %v", err)
		}
	})
	svc := &service{root: root}

	doc := "---\nname: deploy\ndescription: description\n---\n\n# Body\n"
	bundle, err := skill.Parse("deploy.md", bytes.NewBufferString(doc))
	if err != nil {
		t.Fatalf("parse skill: %v", err)
	}
	bundle.Skills[0].Files = append(
		bundle.Skills[0].Files,
		skill.File{Path: "scripts/run", Content: []byte("#!/bin/sh\nexit 0\n")},
		skill.File{Path: "scripts/readme", Content: []byte("not executable\n")},
	)
	var archive bytes.Buffer
	if err := bundle.WriteZIP(&archive); err != nil {
		t.Fatalf("write archive: %v", err)
	}
	decisions, err := json.Marshal([]skill.Decision{{
		Action: skill.DecisionCreate,
		Name:   "deploy",
	}})
	if err != nil {
		t.Fatalf("encode decisions: %v", err)
	}

	imported := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/skill/import", bytes.NewReader(archive.Bytes()))
	req.Header.Set("X-Agentz-Skill-Decisions", string(decisions))
	svc.routes().ServeHTTP(imported, req)
	if imported.Code != http.StatusNoContent {
		t.Fatalf("import status = %d, body = %s", imported.Code, imported.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(dir, ".agents", "skills", "deploy", "scripts", "run"))
	if err != nil {
		t.Fatalf("read imported file: %v", err)
	}
	if string(content) != "#!/bin/sh\nexit 0\n" {
		t.Fatalf("imported content = %q", content)
	}
}

func TestMutableSkillsImportEnforcesLiveDecisions(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Errorf("close root: %v", err)
		}
	})
	svc := &service{root: root}
	doc := "---\nname: deploy\ndescription: description\n---\n\n# Body\n"
	bundle, err := skill.Parse("deploy.md", bytes.NewBufferString(doc))
	if err != nil {
		t.Fatalf("parse skill: %v", err)
	}

	created := requestSkillImport(t, svc, bundle, []skill.Decision{{
		Action: skill.DecisionCreate, Name: "deploy",
	}})
	if created.Code != http.StatusNoContent {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body)
	}
	conflict := requestSkillImport(t, svc, bundle, []skill.Decision{{
		Action: skill.DecisionCreate, Name: "deploy",
	}})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("second create status = %d, body = %s", conflict.Code, conflict.Body)
	}
	overwritten := requestSkillImport(t, svc, bundle, []skill.Decision{{
		Action: skill.DecisionOverwrite, Name: "deploy",
	}})
	if overwritten.Code != http.StatusNoContent {
		t.Fatalf("overwrite status = %d, body = %s", overwritten.Code, overwritten.Body)
	}

	renamed, err := bundle.Decide([]skill.Decision{{
		Action: skill.DecisionRename, Name: "deploy", Rename: "release",
	}})
	if err != nil {
		t.Fatalf("rename bundle: %v", err)
	}
	renamedResult := requestSkillImport(t, svc, renamed, []skill.Decision{{
		Action: skill.DecisionRename, Name: "deploy", Rename: "release",
	}})
	if renamedResult.Code != http.StatusNoContent {
		t.Fatalf("rename status = %d, body = %s", renamedResult.Code, renamedResult.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, ".agents", "skills", "release", "SKILL.md")); err != nil {
		t.Fatalf("stat renamed skill: %v", err)
	}
}

func requestSkillImport(t *testing.T, svc *service, bundle skill.Bundle, decisions []skill.Decision) *httptest.ResponseRecorder {
	t.Helper()

	var archive bytes.Buffer
	if err := bundle.WriteZIP(&archive); err != nil {
		t.Fatalf("write skill archive: %v", err)
	}
	header, err := json.Marshal(decisions)
	if err != nil {
		t.Fatalf("encode decisions: %v", err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/skill/import", &archive)
	req.Header.Set("X-Agentz-Skill-Decisions", string(header))
	svc.routes().ServeHTTP(recorder, req)
	return recorder
}
