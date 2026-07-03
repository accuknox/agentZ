export const agentsTag = "agents"
export const sandboxesTag = "sandboxes"
export const mcpsTag = "mcps"
export const secretsTag = "secrets"
export const workflowsTag = "workflows"
export const workflowRunsTag = "workflow-runs"

export function agentSecretsTag(agentName: string) {
  return `${secretsTag}:${agentName}`
}

export function agentWorkflowsTag(agentName: string) {
  return `${workflowsTag}:${agentName}`
}

export function workflowTag(agentName: string, workflowName: string) {
  return `${workflowsTag}:${agentName}:${workflowName}`
}
