import { readFileSync } from "node:fs"

import { client } from "./client/client.gen"

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

export {
  createAgentDashboard,
  createWorkflow,
  createWorkflowSchedule,
  deleteAgentDashboard,
  deleteDashboardData,
  deleteWorkflows,
  deleteWorkflowSchedule,
  getAgentDashboard,
  getWorkflow,
  listAgentDashboards,
  listAgentWorkflowSchedules,
  listWorkflowSchedules,
  listWorkflowSummaries,
  patchWorkflowRunNodeStatus,
  patchWorkflowRunStatus,
  replaceAgentDashboard,
  updateWorkflowSchedule,
  writeDashboardData,
  type Dashboard,
  type DashboardDataRecord,
  type DashboardDefinition,
  type CreateWorkflowScheduleRequest,
  type CreateWorkflowRequest,
  type DeleteWorkflowScheduleResponse,
  type DeleteWorkflowsRequest,
  type DeleteDashboardDataRequest,
  type Error as GatewayError,
  type JsonValue,
  type PatchWorkflowRunNodeStatusRequest,
  type PatchWorkflowRunStatusRequest,
  type ReplaceDashboardRequest,
  type UpdateWorkflowScheduleRequest,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSchedule,
  type WorkflowSummary,
  type WriteDashboardDataRequest,
} from "./client"
export { zError } from "./client/zod.gen"
