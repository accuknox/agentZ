import { readFileSync } from "node:fs"

import { client } from "./client/client.gen"

const gatewayUrl = process.env.CLAWARMOR_GATEWAY_URL?.trim()
const gatewayBaseUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, "") : "http://localhost:8090"
const gatewayTokenPath = process.env.CLAWARMOR_GATEWAY_TOKEN_PATH?.trim()

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
  createWorkflow,
  createWorkflowSchedule,
  deleteWorkflows,
  deleteWorkflowSchedule,
  getWorkflow,
  listAgentWorkflowSchedules,
  listWorkflowSchedules,
  listWorkflowSummaries,
  patchWorkflowRunStatus,
  updateWorkflowSchedule,
  type CreateWorkflowScheduleRequest,
  type CreateWorkflowRequest,
  type DeleteWorkflowScheduleResponse,
  type DeleteWorkflowsRequest,
  type Error as GatewayError,
  type JsonValue,
  type PatchWorkflowRunStatusRequest,
  type UpdateWorkflowScheduleRequest,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSchedule,
  type WorkflowSummary,
} from "./client"
export { zError } from "./client/zod.gen"
