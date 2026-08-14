package skill

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	maxUploadBytes    = 10 << 20
	maxExtractedBytes = 20 << 20
	maxFileBytes      = 1 << 20
	maxFiles          = 200
	maxEntries        = 400
	maxPathBytes      = 1024
	maxCanonicalBytes = maxExtractedBytes + (1 << 20)
)

// ErrLimitExceeded identifies imports whose upload or expanded contents exceed
// the public API limits.
var ErrLimitExceeded = errors.New("skill import limit exceeded")

// ErrInvalidTree identifies archives whose regular files do not form distinct
// skill roots.
var ErrInvalidTree = errors.New("invalid skill tree")

// ErrMalformedMetadata identifies invalid SKILL.md metadata or body content.
var ErrMalformedMetadata = errors.New("malformed skill metadata")

// DecisionAction describes how an imported skill is applied.
type DecisionAction string

const (
	// DecisionCreate requires the destination not to exist.
	DecisionCreate DecisionAction = "create"
	// DecisionOverwrite requires the destination to exist.
	DecisionOverwrite DecisionAction = "overwrite"
	// DecisionRename creates a skill under a different name.
	DecisionRename DecisionAction = "rename"
)

// Decision selects the destination and precondition for one imported skill.
type Decision struct {
	Action DecisionAction `json:"action"`
	Name   string         `json:"name"`
	Rename string         `json:"rename,omitempty"`
}

// File is one validated regular file in a skill tree.
type File struct {
	Path    string
	Content []byte
}

// Tree is one validated skill directory.
type Tree struct {
	Name        string
	Description string
	Files       []File
}

// Bundle is a validated set of imported skills.
type Bundle struct {
	Skills []Tree
}

// Parse reads and validates a Markdown or ZIP skill import.
func Parse(name string, r io.Reader) (_ Bundle, retErr error) {
	return parse(name, r, maxUploadBytes)
}

// ParseCanonicalZIP revalidates a gateway-generated ZIP whose size may exceed
// the public upload limit after canonical re-encoding.
func ParseCanonicalZIP(r io.Reader) (_ Bundle, retErr error) {
	return parse("skills.zip", r, maxCanonicalBytes)
}

func parse(name string, r io.Reader, maxBytes int64) (_ Bundle, retErr error) {
	spool, err := os.CreateTemp("", "agentz-skill-import-*")
	if err != nil {
		return Bundle{}, fmt.Errorf("create skill import spool: %w", err)
	}
	spoolName := spool.Name()
	defer func() {
		retErr = errors.Join(retErr, spool.Close(), os.Remove(spoolName))
	}()

	size, err := io.Copy(spool, io.LimitReader(r, maxBytes+1))
	if err != nil {
		return Bundle{}, fmt.Errorf("spool skill import: %w", err)
	}
	if size > maxBytes {
		return Bundle{}, fmt.Errorf("%w: archive exceeds its allowed size", ErrLimitExceeded)
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return Bundle{}, fmt.Errorf("rewind skill import: %w", err)
	}

	switch strings.ToLower(path.Ext(name)) {
	case ".md":
		content, err := io.ReadAll(io.LimitReader(spool, maxSkillBytes+1))
		if err != nil {
			return Bundle{}, fmt.Errorf("read skill markdown: %w", err)
		}
		if len(content) > maxSkillBytes {
			return Bundle{}, fmt.Errorf("%w: skill.md exceeds 64 kib", ErrLimitExceeded)
		}
		return parseMarkdown(content)
	case ".zip":
		return parseZIP(spool, size)
	default:
		return Bundle{}, errors.New("skill import must be markdown or zip")
	}
}

// Decide validates a complete set of import decisions and rewrites renames.
func (b Bundle) Decide(decisions []Decision) (Bundle, error) {
	if len(decisions) != len(b.Skills) || len(decisions) == 0 || len(decisions) > 200 {
		return Bundle{}, errors.New("skill import decisions are incomplete")
	}

	byName := make(map[string]Tree, len(b.Skills))
	for _, tree := range b.Skills {
		byName[tree.Name] = tree
	}
	seenSource := make(map[string]struct{}, len(decisions))
	seenDestination := make(map[string]struct{}, len(decisions))
	out := Bundle{Skills: make([]Tree, 0, len(decisions))}
	for _, decision := range decisions {
		tree, ok := byName[decision.Name]
		if !ok {
			return Bundle{}, errors.New("skill import decision references an unknown skill")
		}
		if _, ok := seenSource[decision.Name]; ok {
			return Bundle{}, errors.New("skill import decisions contain a duplicate source")
		}
		seenSource[decision.Name] = struct{}{}

		destination := decision.Name
		switch decision.Action {
		case DecisionCreate, DecisionOverwrite:
			if decision.Rename != "" {
				return Bundle{}, errors.New("skill import decision has an unexpected rename")
			}
		case DecisionRename:
			destination = decision.Rename
		default:
			return Bundle{}, errors.New("skill import decision action is invalid")
		}
		if err := ValidateName(destination); err != nil {
			return Bundle{}, err
		}
		if _, ok := seenDestination[destination]; ok {
			return Bundle{}, errors.New("skill import decisions contain a duplicate destination")
		}
		seenDestination[destination] = struct{}{}

		if destination != tree.Name {
			for i := range tree.Files {
				if tree.Files[i].Path != skillFileName {
					continue
				}
				content, err := rewriteName(tree.Files[i].Content, destination)
				if err != nil {
					return Bundle{}, err
				}
				tree.Files[i].Content = content
			}
			tree.Name = destination
		}
		out.Skills = append(out.Skills, tree)
	}
	slices.SortFunc(out.Skills, func(a, b Tree) int {
		return strings.Compare(a.Name, b.Name)
	})
	return out, nil
}

// WriteZIP writes a canonical, portable archive without buffering the output.
func (b Bundle) WriteZIP(w io.Writer) error {
	zw := zip.NewWriter(w)
	for _, tree := range b.Skills {
		for _, file := range tree.Files {
			h := &zip.FileHeader{
				Name:   path.Join(tree.Name, file.Path),
				Method: zip.Deflate,
			}
			entry, err := zw.CreateHeader(h)
			if err != nil {
				return errors.Join(fmt.Errorf("create skill archive entry: %w", err), zw.Close())
			}
			if _, err := entry.Write(file.Content); err != nil {
				return errors.Join(fmt.Errorf("write skill archive entry: %w", err), zw.Close())
			}
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("close skill archive: %w", err)
	}
	return nil
}

// ValidateNames checks the count, canonical syntax, and uniqueness of a skill
// name set used by batch operations.
func ValidateNames(names []string) error {
	if len(names) == 0 || len(names) > 200 {
		return errors.New("skill names must contain 1-200 names")
	}
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if err := ValidateName(name); err != nil {
			return err
		}
		if _, ok := seen[name]; ok {
			return errors.New("skill names must be unique")
		}
		seen[name] = struct{}{}
	}
	return nil
}

func parseMarkdown(content []byte) (Bundle, error) {
	name, description, err := inspectSkillFile(content)
	if err != nil {
		return Bundle{}, errors.Join(ErrMalformedMetadata, err)
	}
	return Bundle{Skills: []Tree{{
		Name:        name,
		Description: description,
		Files:       []File{{Path: skillFileName, Content: content}},
	}}}, nil
}

func parseZIP(content io.ReaderAt, size int64) (Bundle, error) {
	zr, err := zip.NewReader(content, size)
	if err != nil {
		return Bundle{}, fmt.Errorf("open skill archive: %w", err)
	}
	if len(zr.File) > maxEntries {
		return Bundle{}, errors.New("skill archive contains too many entries")
	}

	files := make(map[string][]byte, min(len(zr.File), maxFiles))
	roots := []string{}
	var extracted uint64
	for _, entry := range zr.File {
		name := strings.TrimSuffix(entry.Name, "/")
		if entry.Flags&1 != 0 {
			return Bundle{}, errors.New("encrypted skill archive entries are unsupported")
		}
		if entry.NonUTF8 || !utf8.ValidString(entry.Name) || len(entry.Name) > maxPathBytes {
			return Bundle{}, errors.New("skill archive entry path is invalid")
		}
		if !fs.ValidPath(name) || strings.ContainsRune(name, '\\') {
			return Bundle{}, errors.New("skill archive entry path is invalid")
		}
		mode := entry.Mode()
		if mode.IsDir() {
			continue
		}
		if mode.Type() != 0 {
			return Bundle{}, errors.New("skill archive entry is not a regular file")
		}
		if len(files) == maxFiles {
			return Bundle{}, errors.New("skill archive contains too many files")
		}
		if _, ok := files[name]; ok {
			return Bundle{}, errors.New("skill archive contains duplicate file paths")
		}

		limit := uint64(maxFileBytes)
		if name == skillFileName || strings.HasSuffix(name, "/"+skillFileName) {
			limit = maxSkillBytes
			roots = append(roots, strings.TrimSuffix(name, skillFileName))
		}
		if entry.UncompressedSize64 > limit || extracted+entry.UncompressedSize64 > maxExtractedBytes {
			return Bundle{}, fmt.Errorf("%w: archive expands beyond its allowed size", ErrLimitExceeded)
		}
		f, err := entry.Open()
		if err != nil {
			return Bundle{}, fmt.Errorf("open skill archive entry: %w", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(f, int64(limit)+1))
		closeErr := f.Close()
		if err := errors.Join(readErr, closeErr); err != nil {
			return Bundle{}, fmt.Errorf("read skill archive entry: %w", err)
		}
		if len(data) > int(limit) {
			return Bundle{}, fmt.Errorf("%w: archive entry exceeds its allowed size", ErrLimitExceeded)
		}
		extracted += uint64(len(data))
		files[name] = data
	}
	if len(roots) == 0 {
		return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains no skills"))
	}

	slices.Sort(roots)
	for i, root := range roots {
		if i > 0 && root == roots[i-1] {
			return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains duplicate skill roots"))
		}
		for _, other := range roots[i+1:] {
			if root == "" || strings.HasPrefix(other, root) {
				return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains nested skill roots"))
			}
		}
	}

	bundle := Bundle{Skills: make([]Tree, 0, len(roots))}
	seenNames := make(map[string]struct{}, len(roots))
	claimed := make(map[string]struct{}, len(files))
	for _, root := range roots {
		tree := Tree{Files: []File{}}
		for name, content := range files {
			if root != "" && !strings.HasPrefix(name, root) {
				continue
			}
			rel := strings.TrimPrefix(name, root)
			if rel == "" {
				continue
			}
			tree.Files = append(tree.Files, File{Path: rel, Content: content})
			claimed[name] = struct{}{}
		}
		slices.SortFunc(tree.Files, func(a, b File) int {
			return strings.Compare(a.Path, b.Path)
		})
		skillFile, ok := files[root+skillFileName]
		if !ok {
			return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains an invalid skill tree"))
		}
		tree.Name, tree.Description, err = inspectSkillFile(skillFile)
		if err != nil {
			return Bundle{}, errors.Join(ErrMalformedMetadata, err)
		}
		if _, ok := seenNames[tree.Name]; ok {
			return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains duplicate skill names"))
		}
		seenNames[tree.Name] = struct{}{}
		bundle.Skills = append(bundle.Skills, tree)
	}
	if len(claimed) != len(files) {
		return Bundle{}, errors.Join(ErrInvalidTree, errors.New("skill archive contains files outside a skill tree"))
	}
	slices.SortFunc(bundle.Skills, func(a, b Tree) int {
		return strings.Compare(a.Name, b.Name)
	})
	return bundle, nil
}

func inspectSkillFile(content []byte) (string, string, error) {
	if len(content) > maxSkillBytes {
		return "", "", errors.New("skill.md exceeds 64 kib")
	}
	if !utf8.Valid(content) {
		return "", "", errors.New("skill.md must be utf-8")
	}
	front, body, err := splitSkillFile(content)
	if err != nil {
		return "", "", err
	}
	var metadata skillFrontmatter
	if err := yaml.Unmarshal(front, &metadata); err != nil {
		return "", "", fmt.Errorf("decode skill frontmatter: %w", err)
	}
	if err := ValidateName(metadata.Name); err != nil {
		return "", "", err
	}
	description := strings.TrimSpace(metadata.Description)
	if description == "" || len(description) > 1024 {
		return "", "", errors.New("skill description must be 1-1024 characters")
	}
	if strings.TrimSpace(string(body)) == "" {
		return "", "", errors.New("skill body is required")
	}
	return metadata.Name, description, nil
}

func splitSkillFile(content []byte) ([]byte, []byte, error) {
	if !bytes.HasPrefix(content, []byte("---\n")) {
		return nil, nil, errors.New("skill frontmatter is required")
	}
	end := bytes.Index(content[4:], []byte("\n---\n"))
	if end < 0 {
		return nil, nil, errors.New("skill frontmatter is not closed")
	}
	end += 4
	return content[4:end], content[end+5:], nil
}

func rewriteName(content []byte, name string) ([]byte, error) {
	front, body, err := splitSkillFile(content)
	if err != nil {
		return nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(front, &doc); err != nil {
		return nil, fmt.Errorf("decode skill frontmatter: %w", err)
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("skill frontmatter must be a mapping")
	}
	mapping := doc.Content[0]
	for i := 0; i < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == "name" {
			mapping.Content[i+1].Kind = yaml.ScalarNode
			mapping.Content[i+1].Tag = "!!str"
			mapping.Content[i+1].Value = name
			break
		}
	}
	var frontmatter bytes.Buffer
	enc := yaml.NewEncoder(&frontmatter)
	enc.SetIndent(2)
	encodeErr := enc.Encode(mapping)
	closeErr := enc.Close()
	if err := errors.Join(encodeErr, closeErr); err != nil {
		return nil, fmt.Errorf("encode skill frontmatter: %w", err)
	}
	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(frontmatter.Bytes())
	out.WriteString("---\n")
	out.Write(body)
	if out.Len() > maxSkillBytes {
		return nil, errors.New("renamed skill.md exceeds 64 kib")
	}
	return out.Bytes(), nil
}
