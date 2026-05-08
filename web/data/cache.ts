export const agentsTag = "agents"
export const environmentsTag = "environments"
export const secretsTag = "secrets"

export function sessionSecretsTag(sessionID: string) {
  return `${secretsTag}:${sessionID}`
}
