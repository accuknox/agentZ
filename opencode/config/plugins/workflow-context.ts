import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { listWorkflowSummaries, type WorkflowSummary } from "../lib/gateway"
import { agentNameFromResourceAttributes } from "../lib/workflow"

const descriptionLimit = 240

type WorkflowContextSnapshot =
  | {
      kind: "ready"
      workflows: WorkflowSummary[]
    }
  | {
      kind: "unavailable"
    }

type WorkflowGateway = (input: { agentName: string }) => Promise<WorkflowSummary[] | undefined>

type WorkflowContextDeps = {
  listSummaries: WorkflowGateway
  resourceAttributes: string | undefined
}

function createWorkflowContextPlugin(
  _input: PluginInput,
  deps: WorkflowContextDeps
): ReturnType<Plugin> {
  const agentName = agentNameFromResourceAttributes(deps.resourceAttributes)
  const snapshots = new Map<string, WorkflowContextSnapshot>()
  const inflight = new Map<string, Promise<WorkflowContextSnapshot>>()

  const loadSnapshot = async (sessionID: string) => {
    const cached = snapshots.get(sessionID)
    if (cached) {
      return cached
    }

    const running = inflight.get(sessionID)
    if (running) {
      return running
    }

    const next = deps
      .listSummaries({ agentName })
      .then((workflows) => {
        const snapshot: WorkflowContextSnapshot = workflows
          ? {
              kind: "ready",
              workflows,
            }
          : {
              kind: "unavailable",
            }

        snapshots.set(sessionID, snapshot)
        inflight.delete(sessionID)
        return snapshot
      })
      .catch(() => {
        const snapshot: WorkflowContextSnapshot = { kind: "unavailable" }
        snapshots.set(sessionID, snapshot)
        inflight.delete(sessionID)
        return snapshot
      })

    inflight.set(sessionID, next)
    return next
  }

  return Promise.resolve({
    async event(input) {
      const sessionID = createdSessionID(input.event)
      if (!agentName || !sessionID) {
        return
      }

      await loadSnapshot(sessionID)
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!agentName || !input.sessionID) {
        return
      }

      const snapshot = await loadSnapshot(input.sessionID)
      if (snapshot.kind !== "ready") {
        return
      }

      output.system.push(formatWorkflowContext(snapshot.workflows))
    },
  })
}

function formatWorkflowContext(workflows: WorkflowSummary[]) {
  const lines = [
    "Saved workflows are reusable execution playbooks for this agent.",
    "Call get_workflow with a workflow_name when the current task matches one of the saved workflows below.",
    "<available_workflows>",
  ]

  for (const workflow of workflows) {
    lines.push("  <workflow>")
    lines.push(`    <name>${escapeXML(workflow.workflow_name)}</name>`)
    lines.push(`    <title>${escapeXML(workflow.title)}</title>`)
    lines.push(`    <description>${escapeXML(trimDescription(workflow.summary))}</description>`)
    lines.push("  </workflow>")
  }

  lines.push("</available_workflows>")
  return lines.join("\n")
}

function trimDescription(summary: string) {
  if (summary.length <= descriptionLimit) {
    return summary
  }

  return summary.slice(0, descriptionLimit - 1).trimEnd() + "…"
}

function escapeXML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export default (async (input) =>
  createWorkflowContextPlugin(input, {
    listSummaries: async ({ agentName }) => {
      const result = await listWorkflowSummaries({
        path: {
          agentName,
        },
        throwOnError: false,
      })

      return result.data
    },
    resourceAttributes: process.env.OPENCODE_RESOURCE_ATTRIBUTES,
  })) satisfies Plugin

function createdSessionID(event: { type: string; properties: unknown }) {
  if (event.type !== "session.created") {
    return ""
  }

  if (typeof event.properties !== "object" || event.properties === null) {
    return ""
  }

  if (!("sessionID" in event.properties)) {
    return ""
  }

  return typeof event.properties.sessionID === "string" ? event.properties.sessionID : ""
}
