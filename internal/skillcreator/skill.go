package skillcreator

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/adrg/frontmatter"
	"go.yaml.in/yaml/v3"
)

const (
	skillFileName = "SKILL.md"
	maxSkillBytes = 64 * 1024
	compatibility = "opencode"
)

var (
	namePattern        = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	nameCleanupPattern = regexp.MustCompile(`[^a-z0-9]+`)
	errInvalidResource = errors.New("resource must be one of scripts, references, assets")
)

// InitConfig describes one skill scaffolding request.
type InitConfig struct {
	Name      string
	Path      string
	Resources []string
	Examples  bool
}

type skillFrontmatter struct {
	Name          string            `yaml:"name"`
	Description   string            `yaml:"description"`
	License       string            `yaml:"license,omitempty"`
	Compatibility string            `yaml:"compatibility,omitempty"`
	Metadata      map[string]string `yaml:"metadata,omitempty"`
}

type skillFile struct {
	Frontmatter skillFrontmatter
	Body        string
}

// Init creates a new skill directory and writes its initial SKILL.md.
func Init(cfg InitConfig) (string, error) {
	if strings.TrimSpace(cfg.Path) == "" {
		return "", errors.New("path must not be empty")
	}

	name := strings.Trim(strings.ToLower(cfg.Name), " -")
	name = nameCleanupPattern.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if !namePattern.MatchString(name) {
		return "", fmt.Errorf("skill name %q must match %s", name, namePattern.String())
	}
	if len(name) > 64 {
		return "", fmt.Errorf("skill name %q must be 1-64 characters", name)
	}

	root, err := filepath.Abs(cfg.Path)
	if err != nil {
		return "", fmt.Errorf("resolving skill path: %w", err)
	}

	skillDir := filepath.Join(root, name)
	_, err = os.Stat(skillDir)
	if err == nil {
		return "", fmt.Errorf("skill %q already exists at %s", name, skillDir)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("checking skill path: %w", err)
	}

	for _, resource := range cfg.Resources {
		switch resource {
		case "scripts", "references", "assets":
		default:
			return "", fmt.Errorf("%w: %q", errInvalidResource, resource)
		}
	}

	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		return "", fmt.Errorf("creating skill directory: %w", err)
	}

	for _, resource := range cfg.Resources {
		if err := os.MkdirAll(filepath.Join(skillDir, resource), 0o755); err != nil {
			return "", fmt.Errorf("creating %s directory: %w", resource, err)
		}
	}

	doc := skillFile{
		Frontmatter: skillFrontmatter{
			Name:          name,
			Description:   "Use when [TODO: describe the exact trigger and workflow].",
			Compatibility: compatibility,
		},
		Body: buildBody(name, cfg.Examples),
	}

	content, err := render(doc)
	if err != nil {
		return "", err
	}

	skillPath := filepath.Join(skillDir, skillFileName)
	if err := os.WriteFile(skillPath, content, 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", skillFileName, err)
	}

	return skillDir, nil
}

// Validate checks one skill directory for opencode-compatible structure.
func Validate(skillDir string) error {
	skillPath := filepath.Join(skillDir, skillFileName)
	content, err := os.ReadFile(skillPath)
	if err != nil {
		return fmt.Errorf("reading %s: %w", skillPath, err)
	}

	doc, err := parse(content)
	if err != nil {
		return err
	}

	issues := make([]string, 0, 6)
	if len(content) > maxSkillBytes {
		issues = append(issues, fmt.Sprintf("%s exceeds %d bytes", skillFileName, maxSkillBytes))
	}
	if !namePattern.MatchString(doc.Frontmatter.Name) {
		issues = append(
			issues,
			fmt.Sprintf("frontmatter.name must match %s", namePattern.String()),
		)
	}
	if len(doc.Frontmatter.Name) == 0 || len(doc.Frontmatter.Name) > 64 {
		issues = append(issues, "frontmatter.name must be 1-64 characters")
	}
	if doc.Frontmatter.Name != filepath.Base(skillDir) {
		issues = append(issues, "frontmatter.name must match the skill directory name")
	}
	desc := strings.TrimSpace(doc.Frontmatter.Description)
	if len(desc) == 0 || len(desc) > 1024 {
		issues = append(issues, "frontmatter.description must be 1-1024 characters")
	}
	if strings.TrimSpace(doc.Body) == "" {
		issues = append(issues, "skill body must not be empty")
	}

	if len(issues) == 0 {
		return nil
	}

	return errors.New(strings.Join(issues, "\n"))
}

func buildBody(name string, examples bool) string {
	var b strings.Builder
	words := strings.Split(name, "-")
	for i, word := range words {
		if word == "" {
			continue
		}
		words[i] = strings.ToUpper(word[:1]) + word[1:]
	}
	title := strings.Join(words, " ")
	b.WriteString("# ")
	b.WriteString(title)
	b.WriteString("\n\n## Overview\n\n")
	b.WriteString("TODO: Explain what this skill enables and when it should be loaded.\n\n")
	b.WriteString("## Workflow\n\n")
	b.WriteString("1. TODO: Describe the first step.\n")
	b.WriteString("2. TODO: Describe the main execution path.\n")
	b.WriteString("3. TODO: Describe validation and handoff.\n")
	if examples {
		b.WriteString("\n## Examples\n\n")
		b.WriteString("- \"TODO: example user request\"\n")
		b.WriteString("- \"TODO: another trigger phrase\"\n")
	}
	return b.String()
}

func render(doc skillFile) ([]byte, error) {
	var front bytes.Buffer
	enc := yaml.NewEncoder(&front)
	enc.SetIndent(2)
	if err := enc.Encode(doc.Frontmatter); err != nil {
		return nil, fmt.Errorf("encoding frontmatter: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("closing frontmatter encoder: %w", err)
	}

	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(front.Bytes())
	out.WriteString("---\n\n")
	out.WriteString(strings.TrimSpace(doc.Body))
	out.WriteString("\n")
	return out.Bytes(), nil
}

func parse(content []byte) (skillFile, error) {
	text := string(content)
	if !strings.HasPrefix(text, "---\n") {
		return skillFile{}, errors.New("skill frontmatter is required")
	}

	raw := map[string]any{}
	body, err := frontmatter.Parse(bytes.NewReader(content), &raw)
	if err != nil {
		return skillFile{}, fmt.Errorf("skill frontmatter is invalid YAML: %w", err)
	}
	if len(body) == len(content) {
		return skillFile{}, errors.New("skill frontmatter is not closed")
	}

	doc := skillFile{Body: string(body)}
	if value, ok := raw["name"]; ok {
		text, ok := value.(string)
		if !ok {
			return skillFile{}, errors.New("frontmatter.name must be a string")
		}
		doc.Frontmatter.Name = text
	}
	if value, ok := raw["description"]; ok {
		text, ok := value.(string)
		if !ok {
			return skillFile{}, errors.New("frontmatter.description must be a string")
		}
		doc.Frontmatter.Description = text
	}
	if value, ok := raw["license"]; ok {
		text, ok := value.(string)
		if !ok {
			return skillFile{}, errors.New("frontmatter.license must be a string")
		}
		doc.Frontmatter.License = text
	}
	if value, ok := raw["compatibility"]; ok {
		text, ok := value.(string)
		if !ok {
			return skillFile{}, errors.New("frontmatter.compatibility must be a string")
		}
		doc.Frontmatter.Compatibility = text
	}
	if value, ok := raw["metadata"]; ok {
		meta, err := parseMetadata(value)
		if err != nil {
			return skillFile{}, err
		}
		doc.Frontmatter.Metadata = meta
	}

	return doc, nil
}

func parseMetadata(value any) (map[string]string, error) {
	items := make(map[string]string)

	switch m := value.(type) {
	case map[string]any:
		for key, item := range m {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("frontmatter.metadata values must be strings")
			}
			items[key] = text
		}
	case map[any]any:
		for key, item := range m {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("frontmatter.metadata values must be strings")
			}
			name, ok := key.(string)
			if !ok {
				return nil, errors.New("frontmatter.metadata keys must be strings")
			}
			items[name] = text
		}
	default:
		return nil, errors.New("frontmatter.metadata must be a mapping")
	}

	return items, nil
}
