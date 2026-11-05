package subcommands

import (
	"context"

	"github.com/urfave/cli/v3"

	"github.com/accuknox/agentz/internal/workflow"
)

// WorkflowCmd runs workflow-related operational commands.
var WorkflowCmd = &cli.Command{
	Name:     "workflow",
	Usage:    "Workflow operational commands",
	Commands: []*cli.Command{workflowRunScheduleCmd},
}

var workflowRunScheduleCmd = &cli.Command{
	Name:  "run-schedule",
	Usage: "Create a WorkflowRun from a schedule tick and observe completion",
	Flags: []cli.Flag{
		&cli.StringFlag{
			Name:    "job-name",
			Usage:   "Stable schedule trigger identity for retry reconciliation",
			Sources: cli.EnvVars("AGENTZ_WORKFLOW_JOB_NAME"),
		},
		&cli.StringFlag{
			Name:     "namespace",
			Usage:    "Namespace for the WorkflowSchedule and WorkflowRun",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "schedule-name",
			Usage:    "Owning WorkflowSchedule name",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "agent-name",
			Usage:    "Target agent name",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:     "workflow-name",
			Usage:    "Target workflow name",
			Required: true,
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.StringFlag{
			Name:  "inputs-json",
			Usage: "JSON value copied into the WorkflowRun spec",
			Value: "null",
			Config: cli.StringConfig{
				TrimSpace: true,
			},
		},
		&cli.IntFlag{
			Name:     "timeout-seconds",
			Usage:    "WorkflowRun execution timeout in seconds",
			Required: true,
		},
	},
	Action: func(ctx context.Context, c *cli.Command) error {
		return workflow.RunSchedule(
			ctx,
			workflow.Config{
				Namespace:      c.String("namespace"),
				JobName:        c.String("job-name"),
				ScheduleName:   c.String("schedule-name"),
				AgentName:      c.String("agent-name"),
				WorkflowName:   c.String("workflow-name"),
				InputsJSON:     c.String("inputs-json"),
				TimeoutSeconds: int32(c.Int("timeout-seconds")),
			},
		)
	},
}
