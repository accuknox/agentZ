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
  deleteWorkflows,
  getWorkflow,
  listWorkflowSummaries,
  patchWorkflowRunStatus,
  type CreateWorkflowRequest,
  type DeleteWorkflowsRequest,
  type Error as GatewayError,
  type PatchWorkflowRunStatusRequest,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSummary,
} from "./client"
export { zError } from "./client/zod.gen"
