export const agentsTag = "agents"
export const apiKeysTag = "api-keys"
export const sandboxesTag = "sandboxes"
export const skillsTag = "skills"
export const mcpsTag = "mcps"
export const secretsTag = "secrets"
export const workflowsTag = "workflows"
export const workflowRunsTag = "workflow-runs"
export const inferenceProvidersTag = "inference-providers"
export const inferencePoolsTag = "inference-pools"

export function agentSecretsTag(agentName: string) {
  return `${secretsTag}:${agentName}`
}

export function agentWorkflowsTag(agentName: string) {
  return `${workflowsTag}:${agentName}`
}

export function workflowTag(agentName: string, workflowName: string) {
  return `${workflowsTag}:${agentName}:${workflowName}`
}
