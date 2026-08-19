import { cacheLife, cacheTag } from "next/cache"
import {
  getAgentOwner,
  listAgentAccessTargets,
  listAgentShares,
  listAgents,
  type Agent,
  type AgentAccessTarget,
  type AgentOwner,
  type AgentShare,
  type ListAgentsData,
} from "@/lib/gateway/client"
import type { ListAgentActionResponse } from "@/data/types"
import { agentsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type AgentShareTarget = AgentAccessTarget

export type AgentShareRow = AgentShare & {
  target_label: string
  target_email?: string
  target_image?: string
  created_by_label: string
  created_by_email?: string
  created_by_image?: string
}

export type WorkspaceAgentDetail = {
  agent: Agent
  owner: AgentOwner
  ownerTarget?: AgentAccessTarget
  ownerLabel: string
  creatorTarget?: AgentAccessTarget
  creatorLabel: string
  ownerCandidates: AgentAccessTarget[]
  users: AgentAccessTarget[]
  teams: AgentAccessTarget[]
  shares: AgentShareRow[]
  sharesNextPageToken: string
}

export async function listAgentsCachedQuery(
  query: ListAgentsData["query"] | undefined,
  workspaceId: string
): Promise<ListAgentActionResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentsTag, `${agentsTag}:${workspaceId}`)

  const { data, error } = await listAgents({
    query,
    client: getGatewayServerClient(workspaceId),
  })
  if (error) {
    return {
      agents: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error,
    }
  }

  const nextPageToken = data.next_page_token

  return {
    agents: data.agents,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
}

export async function getWorkspaceAgentDetail(
  workspaceId: string,
  agentName: string,
  sharePageToken?: string
): Promise<WorkspaceAgentDetail | undefined> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentsTag, `${agentsTag}:${workspaceId}`, `${agentsTag}:${workspaceId}:${agentName}`)

  const client = getGatewayServerClient(workspaceId)
  const agents = await listAgents({ query: { agent_name: [agentName], limit: 1 }, client })
  const agent = agents.data?.agents.find((item) => item.name === agentName)
  if (agents.error || !agent) return undefined

  const canManageAccess = agent.capabilities.share || agent.capabilities.manage_ownership
  const [owner, targets, shares] = await Promise.all([
    getAgentOwner({ path: { agentName }, client }),
    canManageAccess ? listAgentAccessTargets({ path: { agentName }, client }) : undefined,
    agent.capabilities.share
      ? listAgentShares({
          path: { agentName },
          query: { limit: 50, page_token: sharePageToken },
          client,
        })
      : undefined,
  ])
  if (owner.error || targets?.error || shares?.error) return undefined

  const accessTargets = targets?.data.targets ?? []
  const targetsByID = new Map(accessTargets.map((target) => [target.id, target]))
  const shareRows = shares?.data.shares ?? []

  return {
    agent,
    creatorTarget: targetsByID.get(owner.data.creator_user_id),
    creatorLabel: targetsByID.get(owner.data.creator_user_id)?.label ?? owner.data.creator_user_id,
    owner: owner.data,
    ownerTarget: targetsByID.get(owner.data.owner_user_id),
    ownerLabel: targetsByID.get(owner.data.owner_user_id)?.label ?? owner.data.owner_user_id,
    ownerCandidates: accessTargets.filter((target) => target.kind === "user" && target.can_own),
    shares: shareRows.map((share) => {
      const targetID = share.target_user_id ?? share.target_team_id
      const target = targetID ? targetsByID.get(targetID) : undefined
      const creator = targetsByID.get(share.created_by)
      return {
        ...share,
        created_by_email: creator?.email ?? undefined,
        created_by_image: creator?.image ?? undefined,
        created_by_label: creator?.label ?? share.created_by,
        target_email: target?.email ?? undefined,
        target_image: target?.image ?? undefined,
        target_label: target?.label ?? targetID ?? "Unknown target",
      }
    }),
    sharesNextPageToken: shares?.data.next_page_token ?? "",
    teams: accessTargets.filter(
      (target) => target.kind === "team" && target.capabilities.length > 0
    ),
    users: accessTargets.filter(
      (target) => target.kind === "user" && target.capabilities.length > 0
    ),
  }
}
