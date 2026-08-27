import { readFileSync } from "node:fs"

import { client } from "./client/client.gen"
import type { Error as GatewayError } from "./client/types.gen"

const gatewayUrl = process.env.AGENTZ_GATEWAY_URL?.trim()
const gatewayBaseUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, "") : "http://localhost:8090"
const gatewayTokenPath = process.env.AGENTZ_GATEWAY_TOKEN_PATH?.trim()

client.setConfig({
  auth: () => {
    if (!gatewayTokenPath) {
      return undefined
    }

    const token = readFileSync(gatewayTokenPath, "utf8").trim()
    return token || undefined
  },
  baseUrl: gatewayBaseUrl,
})

export function gatewayErrorOutput(error: GatewayError): string {
  const lines = [`${error.code}: ${error.message}`]
  for (const field of error.errors ?? []) {
    lines.push(`${field.field}: ${field.message}`)
  }
  if (error.details !== undefined) {
    lines.push(`details: ${JSON.stringify(error.details)}`)
  }
  return lines.join("\n")
}

export {
  createDashboard,
  createWorkflow,
  createWorkflowSchedule,
  deleteDashboard,
  deleteWorkflows,
  deleteWorkflowSchedule,
  getDashboard,
  getWorkflow,
  listAgentDashboards,
  listAgentWorkflowSchedules,
  listWorkflowSchedules,
  listWorkflowSummaries,
  patchWorkflowRunNodeStatus,
  patchWorkflowRunStatus,
  publishDashboardData,
  updateWorkflowSchedule,
  type CreateDashboardRequest,
  type CreateWorkflowScheduleRequest,
  type CreateWorkflowRequest,
  type Dashboard,
  type DashboardDataRecord,
  type DashboardSummary,
  type DashboardWidgetDefinition,
  type DeleteWorkflowScheduleResponse,
  type DeleteWorkflowsRequest,
  type Error as GatewayError,
  type JsonValue,
  type PatchWorkflowRunNodeStatusRequest,
  type PatchWorkflowRunStatusRequest,
  type PublishDashboardDataRequest,
  type UpdateWorkflowScheduleRequest,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSchedule,
  type WorkflowSummary,
} from "./client"
export {
  zCreateDashboardRequest,
  zDashboardName,
  zDashboardWidgetName,
  zError,
  zPublishDashboardDataRequest,
} from "./client/zod.gen"
