import { client } from "./client/client.gen"

function gatewayBaseUrl() {
  const gatewayUrl = process.env.CLAWARMOR_GATEWAY_URL?.trim()
  if (gatewayUrl) {
    return gatewayUrl.replace(/\/+$/, "")
  }
  return "http://localhost:8090"
}

// Configure the generated fetch client lazily from the agent runtime so tool
// calls use the gateway workflow API without extra feature flags.
client.setConfig({
  baseUrl: gatewayBaseUrl(),
})

export {
  createWorkflow,
  getWorkflow,
  listWorkflowSummaries,
  type CreateWorkflowRequest,
  type Error as GatewayError,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSummary,
} from "./client"
export { zError } from "./client/zod.gen"
