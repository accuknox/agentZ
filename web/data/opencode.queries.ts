import { createAgentOpencodeClient, createAgentOpencodeClientV2 } from "@/lib/opencode/client"
import type {
  ListAgentProvidersActionResponse,
  ListAgentSessionActionResponse,
  ProviderModelItem,
} from "@/data/types"
import { sortAgentSessions, toAgentSessionListItem } from "@/lib/opencode/session-list"

// listAgentSessionsQuery returns sidebar-ready OpenCode sessions for one agent.
export async function listAgentSessionsQuery(
  agentName: string
): Promise<ListAgentSessionActionResponse> {
  try {
    const client = createAgentOpencodeClient(agentName)
    const result = await client.session.list()
    const sessions = result.data

    if (!sessions) {
      return {
        sessions: undefined,
        error: {
          code: "OPENCODE_SESSION_LIST_ERROR",
          message: "Failed to load sessions",
        },
      }
    }

    return {
      sessions: sortAgentSessions(sessions.map(toAgentSessionListItem)),
      error: undefined,
    }
  } catch (err) {
    return {
      sessions: undefined,
      error: {
        code: "OPENCODE_SESSION_LIST_ERROR",
        message: err instanceof Error ? err.message : "Failed to load sessions",
      },
    }
  }
}

// listAgentProvidersQuery fetches available AI providers and their models for one agent.
export async function listAgentProvidersQuery(
  agentName: string
): Promise<ListAgentProvidersActionResponse> {
  try {
    const client = createAgentOpencodeClientV2(agentName)
    const result = await client.config.providers()

    if (result.error || !result.data) {
      const errorMessage =
        result.error &&
        typeof result.error === "object" &&
        "message" in result.error &&
        typeof result.error.message === "string"
          ? result.error.message
          : "Failed to load providers"

      return {
        models: undefined,
        chefs: undefined,
        error: {
          code: "OPENCODE_PROVIDER_LIST_ERROR",
          message: errorMessage,
        },
      }
    }

    const models: ProviderModelItem[] = []
    for (const provider of result.data.providers) {
      for (const model of Object.values(provider.models)) {
        models.push({
          chef: provider.name,
          chefSlug: provider.id,
          contextLimit: model.limit?.context,
          id: `${provider.id}:${model.id}`,
          modelID: model.id,
          name: model.name,
          providerID: provider.id,
        })
      }
    }

    const chefs = [...new Set(models.map((m) => m.chef))]

    return { models, chefs, error: undefined }
  } catch (err) {
    return {
      models: undefined,
      chefs: undefined,
      error: {
        code: "OPENCODE_PROVIDER_LIST_ERROR",
        message: err instanceof Error ? err.message : "Failed to load providers",
      },
    }
  }
}
