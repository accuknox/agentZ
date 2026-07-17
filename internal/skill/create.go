package skill

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

const (
	skillFileName = "SKILL.md"
	maxSkillBytes = 64 * 1024
	compatibility = "opencode"
)

var (
	namePattern        = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
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

	name := cfg.Name
	if err := ValidateName(name); err != nil {
		return "", err
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

	name, _, err := inspectSkillFile(content)
	if err != nil {
		return err
	}
	if name != filepath.Base(skillDir) {
		return errors.New("frontmatter.name must match the skill directory name")
	}
	return nil
}

// ValidateName checks the canonical 32-character skill name contract.
func ValidateName(name string) error {
	if len(name) == 0 || len(name) > 32 {
		return errors.New("skill name must be 1-32 characters")
	}
	if !namePattern.MatchString(name) {
		return fmt.Errorf("skill name must match %s", namePattern.String())
	}
	return nil
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
