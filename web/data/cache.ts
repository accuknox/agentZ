export const agentsTag = "agents"
export const environmentsTag = "environments"
export const secretsTag = "secrets"

export function agentSecretsTag(agentName: string) {
  return `${secretsTag}:${agentName}`
}
