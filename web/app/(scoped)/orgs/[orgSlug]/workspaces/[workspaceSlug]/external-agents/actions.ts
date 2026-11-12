"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { getWorkspaceScope } from "@/data/workspaces"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import {
  listCopilotStudioIntegrations,
  getCopilotStudioIntegration,
  listCopilotStudioAgents,
  createCopilotStudioIntegration,
  updateCopilotStudioIntegration,
  listGuardrailPolicies,
  getGuardrailSettings,
  type CopilotStudioIntegrationInput,
} from "@/lib/gateway/client"
import { zCopilotStudioIntegrationInput } from "@/lib/gateway/client/zod.gen"
import {
  createExternalAgent,
  changeExternalAgent,
  listExternalAgents,
} from "@/data/external-agents"
import type { externalAgentInput } from "@/data/schema"

export async function listExternalAgentsAction(orgSlug: string, workspaceSlug: string) {
  const result = await listExternalAgents(orgSlug, workspaceSlug)
  return { agents: result?.agents ?? [], integrations: result?.integrations ?? [] }
}

export async function createExternalAgentAction(
  orgSlug: string,
  workspaceSlug: string,
  input: z.input<typeof externalAgentInput>
) {
  try {
    const result = await createExternalAgent(orgSlug, workspaceSlug, input)
    revalidatePath("/orgs", "layout")
    return result
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The agent could not be created." }
  }
}

export async function changeExternalAgentAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string,
  operation: "rename" | "disconnect" | "reconnect" | "delete",
  name?: string
) {
  try {
    await changeExternalAgent(orgSlug, workspaceSlug, clientId, operation, name)
    revalidatePath("/orgs", "layout")
    revalidatePath("/settings/applications")
    return { updated: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The agent could not be updated." }
  }
}

export async function loadExternalAgentAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string
) {
  const id = z.string().min(1).max(512).parse(clientId)
  const result = await listExternalAgents(orgSlug, workspaceSlug, [id])
  const agent = result?.agents[0]
  if (!agent) throw new Error("Agent unavailable.")
  return agent
}

export async function listCopilotStudioAgentsAction(
  orgSlug: string,
  workspaceSlug: string,
  integrationId: string,
  pageToken?: string
) {
  const id = z.uuid().parse(integrationId)
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.external_agents.read)
    throw new Error("Workspace unavailable.")
  const result = await listCopilotStudioAgents({
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    path: { integrationId: id },
    query: { limit: 10, page_token: pageToken || undefined },
  })
  if (result.error) throw new Error(result.error.message)
  if (result.data.agents.length === 0)
    return { agents: [], nextPageToken: result.data.next_page_token }
  const records = await listExternalAgents(
    orgSlug,
    workspaceSlug,
    result.data.agents.map((agent) => agent.client_id)
  )
  const byClient = new Map(records?.agents.map((agent) => [agent.clientId, agent]))
  return {
    agents: result.data.agents.flatMap((row) => {
      const agent = byClient.get(row.client_id)
      return agent ? [agent] : []
    }),
    nextPageToken: result.data.next_page_token,
  }
}

export async function loadCopilotStudioAction(
  orgSlug: string,
  workspaceSlug: string,
  integrationId?: string
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") throw new Error("Workspace unavailable.")
  const client = getGatewayServerClient(scope.workspace.id)
  const headers = { "X-AgentZ-Workspace-ID": scope.workspace.id }
  const [platform, integration, policies, settings] = await Promise.all([
    listCopilotStudioIntegrations({ client, headers, query: { limit: 1 } }),
    integrationId
      ? getCopilotStudioIntegration({ client, headers, path: { integrationId } })
      : undefined,
    listGuardrailPolicies({ client, headers }),
    getGuardrailSettings({ client, headers }),
  ])
  if (platform.error) throw new Error(platform.error.message)
  if (integration?.error) throw new Error(integration.error.message)
  if (policies.error) throw new Error(policies.error.message)
  if (settings.error) throw new Error(settings.error.message)
  return {
    enabled: platform.data.enabled,
    audience: platform.data.audience,
    baseURL: platform.data.base_url,
    integration: integration?.data,
    policies: policies.data.items,
    settings: settings.data,
  }
}

export async function saveCopilotStudioAction(
  orgSlug: string,
  workspaceSlug: string,
  input: CopilotStudioIntegrationInput,
  id?: string
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return { error: "Workspace unavailable." }
  const parsed = zCopilotStudioIntegrationInput.safeParse(input)
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Check the connection fields." }
  const options = {
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    body: parsed.data,
  }
  const result = id
    ? await updateCopilotStudioIntegration({ ...options, path: { integrationId: id } })
    : await createCopilotStudioIntegration(options)
  if (result.error) return { error: result.error.message }
  revalidatePath("/orgs", "layout")
  return { data: result.data }
}
