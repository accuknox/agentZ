import { tool } from "@opencode-ai/plugin"

import { listWorkflowSchedules, type WorkflowSchedule, zError } from "../lib/gateway"
import { agentNameFromResourceAttributes, workflowErrorOutput } from "../lib/workflow"

const description = `
List all saved workflow schedules.

Use this tool when you need to discover or review existing workflow schedules before choosing one to update or delete. This returns concise markdown with the schedule name, workflow name, cron schedule, time zone, timeout, run history limits, and inputs for every saved schedule.

This tool takes no arguments.
`.trim()

export default tool({
  description,
  args: {},
  async execute(_, context) {
    const agentName = agentNameFromResourceAttributes(process.env.OPENCODE_RESOURCE_ATTRIBUTES)
    if (!agentName) {
      context.metadata({
        title: "Workflow schedule listing unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return (
        "Could not derive clawarmor.agent_name from " +
        "OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject " +
        "that resource attribute before using list_workflow_schedules."
      )
    }

    context.metadata({
      title: `List workflow schedules for ${agentName}`,
      metadata: {
        agent_name: agentName,
      },
    })

    const schedules: WorkflowSchedule[] = []
    let pageToken: string | undefined

    while (true) {
      const result = await listWorkflowSchedules({
        path: {
          agentName,
        },
        query: pageToken ? { page_token: pageToken, limit: 200 } : { limit: 200 },
        throwOnError: false,
      })
      if (result.data) {
        schedules.push(...result.data.workflow_schedules)
        if (!result.data.next_page_token) {
          break
        }
        pageToken = result.data.next_page_token
        continue
      }

      const error = zError.safeParse(result.error)
      if (!error.success) {
        context.metadata({
          title: "Workflow schedule listing failed",
          metadata: { agent_name: agentName, reason: "unexpected_error" },
        })
        return (
          `Workflow schedule listing failed for agent ${agentName}, and the ` +
          "service returned an unexpected error shape."
        )
      }

      context.metadata({
        title: "Workflow schedule listing failed",
        metadata: {
          agent_name: agentName,
          code: error.data.code,
          errors: error.data.errors ?? [],
        },
      })
      return workflowErrorOutput(error.data)
    }

    context.metadata({
      title: `Listed workflow schedules for ${agentName}`,
      metadata: {
        agent_name: agentName,
        workflow_schedule_count: schedules.length,
      },
    })

    if (schedules.length === 0) {
      return `No saved workflow schedules exist for agent ${agentName}.`
    }

    return schedules
      .map((schedule) => {
        const inputs = JSON.stringify(schedule.inputs)
        return [
          `- name: ${schedule.name}`,
          `workflow_name: ${schedule.workflow_name}`,
          `schedule: ${schedule.schedule}`,
          `time_zone: ${schedule.time_zone ?? "UTC"}`,
          `timeout_seconds: ${schedule.timeout_seconds}`,
          `successful_runs_history_limit: ${schedule.successful_runs_history_limit}`,
          `failed_runs_history_limit: ${schedule.failed_runs_history_limit}`,
          `inputs: ${inputs}`,
        ].join(", ")
      })
      .join("\n")
  },
})
