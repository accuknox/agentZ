package subcommands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/skill"
)

var defaultSkillPath = filepath.Join(os.Getenv("HOME"), ".agents", "skills")

const (
	defaultImmutableSkillSecretDir = "/var/run/secrets/agentz/immutable-skills-bucket"
	defaultImmutableSkillManifest  = "/etc/agentz/opencode/immutable-skills.json"
	defaultImmutableSkillTargetDir = "/var/lib/agentz/skills/immutable"
)

// SkillCmd runs skill-related commands.
var SkillCmd = &cli.Command{
	Name:  "skill",
	Usage: "Skill lifecycle commands",
	Commands: []*cli.Command{
		skillInitCmd,
		skillSyncImmutableCmd,
		skillValidateCmd,
	},
}

var skillInitCmd = &cli.Command{
	Name:      "init",
	Usage:     "Initialize a new skill directory",
	ArgsUsage: "<skill-name>",
	Flags: []cli.Flag{
		&cli.StringSliceFlag{
			Name:  "resource",
			Usage: "Optional resource directory to create. Repeat for scripts, references, or assets.",
		},
		&cli.BoolFlag{
			Name:  "examples",
			Usage: "Include example trigger text in the generated SKILL.md",
		},
	},
	Action: func(_ context.Context, c *cli.Command) error {
		if c.Args().Len() != 1 {
			return fmt.Errorf("expected exactly one skill name")
		}

		skillDir, err := skill.Init(skill.InitConfig{
			Name:      c.Args().Get(0),
			Path:      defaultSkillPath,
			Resources: c.StringSlice("resource"),
			Examples:  c.Bool("examples"),
		})
		if err != nil {
			return err
		}

		fmt.Println(skillDir)
		return nil
	},
}

var skillSyncImmutableCmd = &cli.Command{
	Name:  "sync-immutable",
	Usage: "Sync immutable skill versions from object storage",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:  "bucket-secret-dir",
			Usage: "Directory containing immutable skill bucket secret files",
			Value: defaultImmutableSkillSecretDir,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "manifest",
			Usage: "Immutable skill manifest JSON path",
			Value: defaultImmutableSkillManifest,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "target-dir",
			Usage: "Directory where immutable skills are staged",
			Value: defaultImmutableSkillTargetDir,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		cfg, err := skill.ConfigFromDir(c.String("bucket-secret-dir"))
		if err != nil {
			return err
		}
		store, err := skill.New(ctx, cfg)
		if err != nil {
			return err
		}
		if err := store.DownloadManifest(ctx, c.String("manifest"), c.String("target-dir")); err != nil {
			return err
		}
		return nil
	},
}

var skillValidateCmd = &cli.Command{
	Name:      "validate",
	Usage:     "Validate one skill directory",
	ArgsUsage: "<skill-dir>",
	Action: func(_ context.Context, c *cli.Command) error {
		if c.Args().Len() != 1 {
			return fmt.Errorf("expected exactly one skill directory")
		}

		skillDir := strings.TrimSpace(c.Args().Get(0))
		skillDir = filepath.Clean(skillDir)
		if err := skill.Validate(skillDir); err != nil {
			return err
		}

		return nil
	},
}
