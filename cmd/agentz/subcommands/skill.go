package subcommands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/skillcreator"
)

var defaultSkillPath = filepath.Join(os.Getenv("HOME"), ".agents", "skills")

// SkillCmd runs skill-related commands.
var SkillCmd = &cli.Command{
	Name:  "skill",
	Usage: "Skill lifecycle commands",
	Commands: []*cli.Command{
		skillInitCmd,
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

		skillDir, err := skillcreator.Init(skillcreator.InitConfig{
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
		if err := skillcreator.Validate(skillDir); err != nil {
			return err
		}

		return nil
	},
}
