package skill

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipTestFile struct {
	name    string
	content []byte
	mode    fs.FileMode
}

func TestParseMarkdown(t *testing.T) {
	t.Parallel()

	doc := "---\nname: deploy\ndescription: Deploy an application.\nowner: platform\n---\n\n# Deploy\n"
	bundle, err := Parse("deploy.md", strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(bundle.Skills) != 1 {
		t.Fatalf("len(Skills) = %d, want 1", len(bundle.Skills))
	}
	if bundle.Skills[0].Name != "deploy" {
		t.Fatalf("Name = %q, want deploy", bundle.Skills[0].Name)
	}
	if bundle.Skills[0].Description != "Deploy an application." {
		t.Fatalf("Description = %q", bundle.Skills[0].Description)
	}
}

func TestBundleDecideRenamePreservesFrontmatter(t *testing.T) {
	t.Parallel()

	doc := "---\nname: deploy\ndescription: Deploy an application.\nowner: platform\n---\n\n# Deploy\n"
	bundle, err := Parse("deploy.md", strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	renamed, err := bundle.Decide([]Decision{{
		Action: DecisionRename,
		Name:   "deploy",
		Rename: "release",
	}})
	if err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	content := string(renamed.Skills[0].Files[0].Content)
	if !strings.Contains(content, "name: release") {
		t.Fatalf("renamed SKILL.md does not contain new name:\n%s", content)
	}
	if !strings.Contains(content, "owner: platform") {
		t.Fatalf("renamed SKILL.md lost unknown frontmatter:\n%s", content)
	}
}

func TestParseZIPRejectsUnsafeTrees(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		add  func(*zip.Writer) error
		want string
	}{
		{
			name: "zip slip",
			add: func(zw *zip.Writer) error {
				_, err := zw.Create("../SKILL.md")
				return err
			},
			want: "path is invalid",
		},
		{
			name: "symlink",
			add: func(zw *zip.Writer) error {
				h := &zip.FileHeader{Name: "deploy/link"}
				h.SetMode(0o777 | fs.ModeSymlink)
				_, err := zw.CreateHeader(h)
				return err
			},
			want: "entry is not a regular file",
		},
		{
			name: "device",
			add: func(zw *zip.Writer) error {
				h := &zip.FileHeader{Name: "deploy/device"}
				h.SetMode(fs.ModeDevice | 0o600)
				_, err := zw.CreateHeader(h)
				return err
			},
			want: "entry is not a regular file",
		},
		{
			name: "long path",
			add: func(zw *zip.Writer) error {
				_, err := zw.Create(strings.Repeat("a", maxPathBytes+1))
				return err
			},
			want: "path is invalid",
		},
		{
			name: "duplicate path",
			add: func(zw *zip.Writer) error {
				if _, err := zw.Create("deploy/file"); err != nil {
					return err
				}
				_, err := zw.Create("deploy/file")
				return err
			},
			want: "duplicate file paths",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var archive bytes.Buffer
			zw := zip.NewWriter(&archive)
			if err := tt.add(zw); err != nil {
				t.Fatalf("create archive: %v", err)
			}
			if err := zw.Close(); err != nil {
				t.Fatalf("close archive: %v", err)
			}

			_, err := Parse("skills.zip", bytes.NewReader(archive.Bytes()))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Parse() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestValidateRejectsNameLongerThan32Characters(t *testing.T) {
	t.Parallel()

	name := strings.Repeat("a", 33)
	dir := t.TempDir() + "/" + name
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("create skill directory: %v", err)
	}
	doc := "---\nname: " + name + "\ndescription: description\n---\n\n# Body\n"
	if err := os.WriteFile(filepath.Join(dir, skillFileName), []byte(doc), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	if err := Validate(dir); err == nil || !strings.Contains(err.Error(), "1-32") {
		t.Fatalf("Validate() error = %v, want 1-32 character error", err)
	}
}

func TestParseZIPRejectsLimitsAndInvalidTrees(t *testing.T) {
	t.Parallel()

	doc := []byte("---\nname: deploy\ndescription: description\n---\n\n# Body\n")
	largeFiles := make([]zipTestFile, 22)
	largeFiles[0] = zipTestFile{name: "deploy/SKILL.md", content: doc}
	for i := range 20 {
		largeFiles[i+1] = zipTestFile{
			name:    fmt.Sprintf("deploy/references/%02d", i),
			content: bytes.Repeat([]byte("a"), maxFileBytes),
		}
	}
	largeFiles[21] = zipTestFile{
		name:    "deploy/references/overflow",
		content: []byte("x"),
	}

	tests := []struct {
		name  string
		files []zipTestFile
		want  string
	}{
		{
			name: "file size",
			files: []zipTestFile{
				{name: "deploy/SKILL.md", content: doc},
				{name: "deploy/references/large", content: bytes.Repeat([]byte("a"), maxFileBytes+1)},
			},
			want: "limit exceeded",
		},
		{name: "expanded size", files: largeFiles, want: "limit exceeded"},
		{
			name: "nested roots",
			files: []zipTestFile{
				{name: "deploy/SKILL.md", content: doc},
				{name: "deploy/nested/SKILL.md", content: []byte("---\nname: nested\ndescription: description\n---\n\n# Body\n")},
			},
			want: "nested skill roots",
		},
		{
			name: "duplicate skill names",
			files: []zipTestFile{
				{name: "one/SKILL.md", content: doc},
				{name: "two/SKILL.md", content: doc},
			},
			want: "duplicate skill names",
		},
		{
			name: "orphan file",
			files: []zipTestFile{
				{name: "deploy/SKILL.md", content: doc},
				{name: "orphan.txt", content: []byte("orphan")},
			},
			want: "outside a skill tree",
		},
		{
			name: "invalid utf8 metadata",
			files: []zipTestFile{{
				name: "deploy/SKILL.md", content: append(doc[:10:10], 0xff),
			}},
			want: "utf-8",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			archive := writeTestZIP(t, tt.files)
			_, err := Parse("skills.zip", bytes.NewReader(archive))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Parse() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestParseZIPRejectsEntryAndFileCounts(t *testing.T) {
	t.Parallel()

	t.Run("entries", func(t *testing.T) {
		var archive bytes.Buffer
		zw := zip.NewWriter(&archive)
		for i := 0; i <= maxEntries; i++ {
			h := &zip.FileHeader{Name: fmt.Sprintf("directory-%03d/", i)}
			h.SetMode(fs.ModeDir | 0o755)
			if _, err := zw.CreateHeader(h); err != nil {
				t.Fatalf("create directory entry: %v", err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("close archive: %v", err)
		}
		_, err := Parse("skills.zip", bytes.NewReader(archive.Bytes()))
		if err == nil || !strings.Contains(err.Error(), "too many entries") {
			t.Fatalf("Parse() error = %v, want entry count error", err)
		}
	})

	t.Run("files", func(t *testing.T) {
		doc := []byte("---\nname: deploy\ndescription: description\n---\n\n# Body\n")
		files := []zipTestFile{{name: "deploy/SKILL.md", content: doc}}
		for i := 1; i <= maxFiles; i++ {
			files = append(files, zipTestFile{
				name: fmt.Sprintf("deploy/references/%03d", i), content: []byte("x"),
			})
		}
		archive := writeTestZIP(t, files)
		_, err := Parse("skills.zip", bytes.NewReader(archive))
		if err == nil || !strings.Contains(err.Error(), "too many files") {
			t.Fatalf("Parse() error = %v, want file count error", err)
		}
	})
}

func writeTestZIP(t *testing.T, files []zipTestFile) []byte {
	t.Helper()

	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for _, file := range files {
		h := &zip.FileHeader{Name: file.name, Method: zip.Deflate}
		if file.mode != 0 {
			h.SetMode(file.mode)
		}
		entry, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatalf("create %q: %v", file.name, err)
		}
		if _, err := entry.Write(file.content); err != nil {
			t.Fatalf("write %q: %v", file.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return archive.Bytes()
}
