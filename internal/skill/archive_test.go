package skill

import (
	"archive/zip"
	"bytes"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

func TestParseMarkdownCompatibility(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content []byte
	}{
		{name: "LF", content: skillMarkdown("skill-name", "\n", false, "# Skill\n")},
		{name: "CRLF", content: skillMarkdown("skill-name", "\r\n", false, "# Skill\r\n")},
		{name: "BOM and LF", content: skillMarkdown("skill-name", "\n", true, "# Skill\n")},
		{name: "BOM and CRLF", content: skillMarkdown("skill-name", "\r\n", true, "# Skill\r\n")},
		{name: "empty body", content: skillMarkdown("skill-name", "\n", false, "")},
		{name: "32-character name", content: skillMarkdown(strings.Repeat("a", 32), "\n", false, "")},
		{name: "63-character name", content: skillMarkdown(strings.Repeat("a", 63), "\n", false, "")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			bundle, err := Parse("SKILL.md", bytes.NewReader(tt.content))
			if err != nil {
				t.Fatalf("parse markdown: %v", err)
			}
			content := bundle.Skills[0].Files[0].Content
			if bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}) || bytes.ContainsRune(content, '\r') {
				t.Fatalf("stored markdown is not canonical UTF-8 with LF: %q", content)
			}
		})
	}
}

func TestParseMarkdownDiagnostics(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content []byte
		kind    ImportIssueKind
		message string
	}{
		{
			name:    "64-character name",
			content: skillMarkdown(strings.Repeat("a", 64), "\n", false, ""),
			kind:    ImportIssueInvalidName,
			message: kubernetesNameLimitError,
		},
		{
			name:    "invalid leading hyphen",
			content: skillMarkdown("-skill", "\n", false, ""),
			kind:    ImportIssueInvalidName,
		},
		{
			name:    "invalid consecutive hyphens",
			content: skillMarkdown("bad--skill", "\n", false, ""),
			kind:    ImportIssueInvalidName,
		},
		{name: "invalid UTF-8", content: []byte{0xff}, kind: ImportIssueInvalidUTF8},
		{name: "missing frontmatter", content: []byte("# Skill\n"), kind: ImportIssueMalformedFrontmatter},
		{name: "unclosed frontmatter", content: []byte("---\nname: skill\n"), kind: ImportIssueMalformedFrontmatter},
		{name: "malformed frontmatter", content: []byte("---\n[\n---\n"), kind: ImportIssueMalformedFrontmatter},
		{
			name:    "missing description",
			content: []byte("---\nname: skill\n---\n"),
			kind:    ImportIssueInvalidDescription,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := Parse("SKILL.md", bytes.NewReader(tt.content))
			var issue *ImportIssue
			if !errors.As(err, &issue) {
				t.Fatalf("error = %v, want ImportIssue", err)
			}
			if issue.Kind != tt.kind {
				t.Fatalf("kind = %q, want %q", issue.Kind, tt.kind)
			}
			if issue.Path != "SKILL.md" {
				t.Fatalf("path = %q, want SKILL.md", issue.Path)
			}
			if tt.message != "" && issue.Message != tt.message {
				t.Fatalf("message = %q, want %q", issue.Message, tt.message)
			}
		})
	}
}

func TestParseZIPStrictTree(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		files []archiveFile
		want  int
		kind  ImportIssueKind
	}{
		{
			name: "single skill",
			files: []archiveFile{
				{name: "skill/SKILL.md", content: skillMarkdown("skill", "\n", false, "")},
				{name: "skill/references/doc.md", content: []byte("reference")},
			},
			want: 1,
		},
		{
			name: "multiple skills in wrapper",
			files: []archiveFile{
				{name: "bundle/one/SKILL.md", content: skillMarkdown("one", "\n", false, "")},
				{name: "bundle/two/SKILL.md", content: skillMarkdown("two", "\n", false, "")},
			},
			want: 2,
		},
		{
			name: "unclaimed file",
			files: []archiveFile{
				{name: "skill/SKILL.md", content: skillMarkdown("skill", "\n", false, "")},
				{name: ".DS_Store", content: []byte("metadata")},
			},
			kind: ImportIssueInvalidTree,
		},
		{
			name: "nested roots",
			files: []archiveFile{
				{name: "skill/SKILL.md", content: skillMarkdown("skill", "\n", false, "")},
				{name: "skill/nested/SKILL.md", content: skillMarkdown("nested", "\n", false, "")},
			},
			kind: ImportIssueInvalidTree,
		},
		{
			name: "duplicate names",
			files: []archiveFile{
				{name: "one/SKILL.md", content: skillMarkdown("same", "\n", false, "")},
				{name: "two/SKILL.md", content: skillMarkdown("same", "\n", false, "")},
			},
			kind: ImportIssueInvalidTree,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			archive := writeArchive(t, tt.files)
			bundle, err := Parse("skills.zip", bytes.NewReader(archive))
			if tt.kind == "" {
				if err != nil {
					t.Fatalf("parse ZIP: %v", err)
				}
				if len(bundle.Skills) != tt.want {
					t.Fatalf("skills = %d, want %d", len(bundle.Skills), tt.want)
				}
				return
			}
			var issue *ImportIssue
			if !errors.As(err, &issue) || issue.Kind != tt.kind {
				t.Fatalf("error = %v, want %q ImportIssue", err, tt.kind)
			}
		})
	}
}

func TestBundleExportRoundTrip(t *testing.T) {
	t.Parallel()

	original, err := Parse(
		"skill.md",
		bytes.NewReader(skillMarkdown("round-trip", "\r\n", true, "# Round trip\r\n")),
	)
	if err != nil {
		t.Fatalf("parse markdown: %v", err)
	}
	var archive bytes.Buffer
	if err := original.WriteZIP(&archive); err != nil {
		t.Fatalf("write ZIP: %v", err)
	}
	reimported, err := ParseCanonicalZIP(bytes.NewReader(archive.Bytes()))
	if err != nil {
		t.Fatalf("re-import ZIP: %v", err)
	}
	if reimported.Skills[0].Name != original.Skills[0].Name ||
		!bytes.Equal(reimported.Skills[0].Files[0].Content, original.Skills[0].Files[0].Content) {
		t.Fatal("export and re-import changed the skill")
	}
}

func TestParseZIPRejectsInvalidEntries(t *testing.T) {
	t.Parallel()

	validSkill := archiveFile{
		name: "skill/SKILL.md", content: skillMarkdown("skill", "\n", false, ""),
	}
	tests := []struct {
		name  string
		files []archiveFile
		kind  ImportIssueKind
	}{
		{
			name:  "traversal",
			files: []archiveFile{{name: "../SKILL.md", content: validSkill.content}},
			kind:  ImportIssueInvalidTree,
		},
		{
			name:  "backslash",
			files: []archiveFile{{name: `skill\SKILL.md`, content: validSkill.content}},
			kind:  ImportIssueInvalidTree,
		},
		{
			name: "duplicate path",
			files: []archiveFile{
				validSkill,
				validSkill,
			},
			kind: ImportIssueInvalidTree,
		},
		{
			name: "symbolic link",
			files: []archiveFile{
				validSkill,
				{name: "skill/link", content: []byte("target"), mode: fs.ModeSymlink | 0o777},
			},
			kind: ImportIssueInvalidTree,
		},
		{
			name: "encrypted entry",
			files: []archiveFile{
				validSkill,
				{name: "skill/secret", content: []byte("secret"), flags: 1},
			},
			kind: ImportIssueInvalidArchive,
		},
		{
			name: "file limit",
			files: []archiveFile{
				validSkill,
				{name: "skill/assets/large", content: bytes.Repeat([]byte("x"), (1<<20)+1)},
			},
			kind: ImportIssueLimitExceeded,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := Parse("skills.zip", bytes.NewReader(writeArchive(t, tt.files)))
			var issue *ImportIssue
			if !errors.As(err, &issue) || issue.Kind != tt.kind {
				t.Fatalf("error = %v, want %q ImportIssue", err, tt.kind)
			}
		})
	}
}

func TestBundleDecisionRenameRevalidatesName(t *testing.T) {
	t.Parallel()

	bundle, err := Parse(
		"SKILL.md",
		bytes.NewReader(skillMarkdown("original", "\n", false, "")),
	)
	if err != nil {
		t.Fatalf("parse skill: %v", err)
	}
	renamed, err := bundle.Decide([]Decision{{
		Action: DecisionRename,
		Name:   "original",
		Rename: strings.Repeat("a", 63),
	}})
	if err != nil {
		t.Fatalf("rename skill: %v", err)
	}
	reparsed, err := Parse("SKILL.md", bytes.NewReader(renamed.Skills[0].Files[0].Content))
	if err != nil {
		t.Fatalf("reparse renamed skill: %v", err)
	}
	if got := reparsed.Skills[0].Name; got != strings.Repeat("a", 63) {
		t.Fatalf("name = %q", got)
	}

	_, err = bundle.Decide([]Decision{{
		Action: DecisionRename,
		Name:   "original",
		Rename: strings.Repeat("a", 64),
	}})
	if err == nil || err.Error() != kubernetesNameLimitError {
		t.Fatalf("error = %v, want Kubernetes name limit", err)
	}
}

type archiveFile struct {
	name    string
	content []byte
	flags   uint16
	mode    fs.FileMode
}

func skillMarkdown(name, newline string, bom bool, body string) []byte {
	content := "---" + newline + "name: " + name + newline +
		"description: A valid skill description." + newline + "---" + newline + body
	if bom {
		content = "\ufeff" + content
	}
	return []byte(content)
}

func writeArchive(t *testing.T, files []archiveFile) []byte {
	t.Helper()

	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for _, file := range files {
		header := &zip.FileHeader{Name: file.name, Method: zip.Deflate, Flags: file.flags}
		if file.mode != 0 {
			header.SetMode(file.mode)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("create %s: %v", file.name, err)
		}
		if _, err := entry.Write(file.content); err != nil {
			t.Fatalf("write %s: %v", file.name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close ZIP: %v", err)
	}
	return archive.Bytes()
}
