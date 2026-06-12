import { client } from "./client/client.gen"

const gatewayUrl = process.env.CLAWARMOR_GATEWAY_URL?.trim()
const gatewayBaseUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, "") : "http://localhost:8090"

// Configure the generated fetch client lazily from the agent runtime so tool
// calls use the gateway workflow API without extra feature flags.
client.setConfig({
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
