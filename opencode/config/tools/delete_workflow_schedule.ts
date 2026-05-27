import { tool } from "@opencode-ai/plugin"

import { deleteWorkflowSchedule, zError } from "../lib/gateway"
import { agentNameFromResourceAttributes, workflowErrorOutput } from "../lib/workflow"

const args = {
  name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("Exact workflow schedule name to delete."),
  confirmed: tool.schema
    .boolean()
    .default(false)
    .describe(
      "Set to true only when the user explicitly asked to delete this workflow schedule in the current conversation. " +
        "Leave false to surface a confirmation prompt first."
    ),
}

const description = `
Delete a workflow schedule.

Guidelines:
- If the user explicitly asked to delete the workflow schedule, set confirmed to true.
- If deletion is only inferred from cleanup, replacement, or reorganization intent, leave confirmed as false so the tool surfaces a confirmation prompt first.
- Deletion is strict. If the named workflow schedule does not exist, the call fails.
`.trim()

type DeleteWorkflowScheduleToolInput = {
  name: string
  confirmed: boolean
}

export default tool({
  description,
  args,
  async execute(args: DeleteWorkflowScheduleToolInput, context) {
    const agentName = agentNameFromResourceAttributes(process.env.OPENCODE_RESOURCE_ATTRIBUTES)
    if (!agentName) {
      context.metadata({
        title: "Workflow schedule deletion unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return (
        "Could not derive clawarmor.agent_name from " +
        "OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject " +
        "that resource attribute before using delete_workflow_schedule."
      )
    }

    context.metadata({
      title: `Delete workflow schedule ${args.name}`,
      metadata: {
        agent_name: agentName,
        name: args.name,
      },
    })

    if (!args.confirmed) {
      await context.ask({
        permission: "delete_workflow_schedule",
        patterns: [args.name],
        always: [],
        metadata: {
          agent_name: agentName,
          name: args.name,
        },
      })
    }

    const result = await deleteWorkflowSchedule({
      path: {
        agentName,
        name: args.name,
      },
      throwOnError: false,
    })
    if (!result.error) {
      context.metadata({
        title: "Workflow schedule deleted",
        metadata: {
          agent_name: agentName,
          name: args.name,
        },
      })
      return `Deleted workflow schedule ${args.name} for agent ${agentName}.`
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow schedule deletion failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return (
        `Workflow schedule deletion failed for agent ${agentName}, and the ` +
        "service returned an unexpected error shape."
      )
    }

    context.metadata({
      title: "Workflow schedule deletion failed",
      metadata: {
        agent_name: agentName,
        name: args.name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return workflowErrorOutput(error.data)
  },
})
