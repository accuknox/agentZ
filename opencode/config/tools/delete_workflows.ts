import { tool } from "@opencode-ai/plugin"

import { deleteWorkflows, type DeleteWorkflowsRequest } from "../lib/gateway"
import { zError } from "../lib/gateway"
import { agentNameFromResourceAttributes, workflowErrorOutput } from "../lib/workflow"

const deleteWorkflowsArgs = {
  workflow_names: tool.schema
    .array(
      tool.schema
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    )
    .min(1)
    .describe("Exact saved workflow names to delete. Multiple names are allowed."),
  confirmed: tool.schema
    .boolean()
    .default(false)
    .describe(
      "Set to true only when the user explicitly asked to delete these workflows in the current conversation. " +
        "Leave false to surface a confirmation prompt before deletion."
    ),
}

const description = `
Delete one or more workflows.

Guidelines:
- If the user explicitly asked to delete the workflows, set confirmed to true.
- If deletion is only inferred from cleanup, replacement, or reorganization intent, leave confirmed as false so the tool surfaces a confirmation prompt first.
- Deletion is strict. If any named workflow does not exist, the entire call fails and nothing is deleted.

Example:
The user says "delete the repo-triage and incident-intake workflows". Call delete_workflows tool with:
- workflow_names: ["repo-triage", "incident-intake"]
- confirmed: true
`.trim()

type DeleteWorkflowsToolInput = {
  workflow_names: DeleteWorkflowsRequest["workflow_names"]
  confirmed: boolean
}

export default tool({
  description,
  args: deleteWorkflowsArgs,
  async execute(args: DeleteWorkflowsToolInput, context) {
    const agentName = agentNameFromResourceAttributes(process.env.OPENCODE_RESOURCE_ATTRIBUTES)
    if (!agentName) {
      context.metadata({
        title: "Workflow deletion unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "Could not derive clawarmor.agent_name from OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject that resource attribute before using delete_workflows."
    }

    const workflowNames = Array.from(new Set(args.workflow_names))

    context.metadata({
      title: `Delete workflows for ${agentName}`,
      metadata: {
        agent_name: agentName,
        workflow_names: workflowNames,
      },
    })

    if (!args.confirmed) {
      await context.ask({
        permission: "delete_workflows",
        patterns: workflowNames,
        always: [],
        metadata: {
          agent_name: agentName,
          workflow_names: workflowNames,
        },
      })
    }

    const body = {
      workflow_names: workflowNames,
    } satisfies DeleteWorkflowsRequest

    const result = await deleteWorkflows({
      path: {
        agentName,
      },
      body,
      throwOnError: false,
    })
    if (!result.error) {
      context.metadata({
        title: "Workflows deleted",
        metadata: {
          agent_name: agentName,
          workflow_names: workflowNames,
          deleted_count: workflowNames.length,
        },
      })
      return `Deleted workflows ${workflowNames.map((name) => `"${name}"`).join(", ")} for agent ${agentName}.`
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow deletion failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return `Workflow deletion failed for agent ${agentName}, and the service returned an unexpected error shape.`
    }

    context.metadata({
      title: "Workflow deletion failed",
      metadata: {
        agent_name: agentName,
        workflow_names: workflowNames,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return workflowErrorOutput(error.data)
  },
})
