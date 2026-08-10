import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import { cacheLife, cacheTag } from "next/cache"
import {
  getAgentOwner,
  listAgentShares,
  listAgents,
  type Agent,
  type AgentOwner,
  type AgentShare,
  type ListAgentsData,
} from "@/lib/gateway/client"
import type { ListAgentActionResponse } from "@/data/types"
import { agentsTag } from "@/data/cache"
import { getDB, schema } from "@/db"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type AgentShareTarget = {
  id: string
  label: string
  email?: string
}

export type AgentShareRow = AgentShare & {
  target_label: string
  created_by_label: string
}

export type WorkspaceAgentDetail = {
  agent: Agent
  owner: AgentOwner
  ownerLabel: string
  creatorLabel: string
  ownerCandidates: AgentShareTarget[]
  users: AgentShareTarget[]
  teams: AgentShareTarget[]
  shares: AgentShareRow[]
}

export async function listAgentsCachedQuery(
  query?: ListAgentsData["query"],
  workspaceId?: string
): Promise<ListAgentActionResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentsTag, `${agentsTag}:${workspaceId ?? "organization"}`)

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

  const agents = data.agents.filter((agent) => agent.status !== "DELETED")
  const nextPageToken = data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    agents,
    nextPageToken,
    hasNextPage,
    error: undefined,
  } satisfies ListAgentActionResponse<Agent>
}

export async function getWorkspaceAgentDetail(
  organizationId: string,
  workspaceId: string,
  agentName: string
): Promise<WorkspaceAgentDetail | undefined> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(agentsTag, `${agentsTag}:${workspaceId}`, `${agentsTag}:${workspaceId}:${agentName}`)

  const client = getGatewayServerClient(workspaceId)
  const db = getDB()
  const [agents, ownerResult, sharesResult, members, teams, eligibleRoles] = await Promise.all([
    listAgents({ query: { limit: 500 }, client }),
    getAgentOwner({ path: { agentName }, client }),
    listAgentShares({ path: { agentName }, client }),
    db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(eq(schema.members.organizationId, organizationId), isNull(schema.members.disabledAt))
      )
      .orderBy(asc(schema.users.name), asc(schema.users.email)),
    db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.organizationId, organizationId))
      .orderBy(asc(schema.teams.name), asc(schema.teams.id)),
    db
      .selectDistinct({ id: schema.roleScopes.roleId, systemRole: schema.roleScopes.systemRole })
      .from(schema.roleScopes)
      .leftJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
          eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId)
        )
      )
      .where(
        and(
          eq(schema.roleScopes.organizationId, organizationId),
          or(
            and(
              eq(schema.roleScopes.systemRole, "superadmin"),
              isNull(schema.roleScopes.workspaceId),
              eq(schema.roleScopes.immutable, true)
            ),
            and(
              eq(schema.roleScopes.systemRole, "workspace_admin"),
              eq(schema.roleScopes.workspaceId, workspaceId),
              eq(schema.roleScopes.immutable, true)
            ),
            and(
              eq(schema.permissionGrants.workspaceId, workspaceId),
              eq(schema.permissionGrants.resource, "agent"),
              eq(schema.permissionGrants.action, "author")
            )
          )
        )
      ),
  ])

  if (agents.error || ownerResult.error || sharesResult.error) {
    return
  }

  const agent = agents.data.agents.find(
    (candidate) => candidate.name === agentName && candidate.status !== "DELETED"
  )
  if (!agent) {
    return
  }

  const userIds = new Set<string>()
  for (const share of sharesResult.data.shares) {
    if (share.target_user_id) {
      userIds.add(share.target_user_id)
    }
    userIds.add(share.created_by)
  }
  userIds.add(ownerResult.data.owner_user_id)
  userIds.add(ownerResult.data.creator_user_id)

  const knownUsers = members.map((member) => ({
    ...member,
    label: member.name ? `${member.name} (${member.email})` : member.email,
  }))
  const missingUsers = [...userIds].filter(
    (userId) => !knownUsers.some((user) => user.id === userId)
  )
  const extraUsers = missingUsers.length
    ? await getDB()
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, missingUsers))
    : []
  const userLabels = new Map(
    [...knownUsers, ...extraUsers].map((user) => [
      user.id,
      user.name ? `${user.name} (${user.email})` : user.email,
    ])
  )
  const teamLabels = new Map(teams.map((team) => [team.id, team.name]))
  const directRoleIds = eligibleRoles.map((role) => role.id)
  const teamRoleIds = eligibleRoles
    .filter((role) => role.systemRole === null)
    .map((role) => role.id)
  const [directOwners, teamOwners] = await Promise.all([
    directRoleIds.length
      ? db
          .selectDistinct({ userId: schema.members.userId })
          .from(schema.memberRoles)
          .innerJoin(
            schema.members,
            and(
              eq(schema.members.id, schema.memberRoles.memberId),
              eq(schema.members.organizationId, schema.memberRoles.organizationId),
              isNull(schema.members.disabledAt)
            )
          )
          .where(
            and(
              eq(schema.memberRoles.organizationId, organizationId),
              inArray(schema.memberRoles.roleId, directRoleIds)
            )
          )
      : [],
    teamRoleIds.length
      ? db
          .selectDistinct({ userId: schema.teamMembers.userId })
          .from(schema.teamRoles)
          .innerJoin(
            schema.teams,
            and(
              eq(schema.teams.id, schema.teamRoles.teamId),
              eq(schema.teams.organizationId, schema.teamRoles.organizationId)
            )
          )
          .innerJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teams.id))
          .innerJoin(
            schema.members,
            and(
              eq(schema.members.userId, schema.teamMembers.userId),
              eq(schema.members.organizationId, schema.teamRoles.organizationId),
              isNull(schema.members.disabledAt)
            )
          )
          .where(
            and(
              eq(schema.teamRoles.organizationId, organizationId),
              inArray(schema.teamRoles.roleId, teamRoleIds)
            )
          )
      : [],
  ])
  const eligibleOwnerIDs = new Set([
    ...directOwners.map((owner) => owner.userId),
    ...teamOwners.map((owner) => owner.userId),
  ])

  return {
    agent,
    creatorLabel:
      userLabels.get(ownerResult.data.creator_user_id) ?? ownerResult.data.creator_user_id,
    owner: ownerResult.data,
    ownerLabel: userLabels.get(ownerResult.data.owner_user_id) ?? ownerResult.data.owner_user_id,
    ownerCandidates: knownUsers.filter((user) => eligibleOwnerIDs.has(user.id)),
    shares: sharesResult.data.shares.map((share) => ({
      ...share,
      created_by_label: userLabels.get(share.created_by) ?? share.created_by,
      target_label: share.target_user_id
        ? (userLabels.get(share.target_user_id) ?? share.target_user_id)
        : (teamLabels.get(share.target_team_id ?? "") ?? share.target_team_id ?? "Unknown Team"),
    })),
    teams: teams.map((team) => ({ id: team.id, label: team.name })),
    users: knownUsers.map((user) => ({ id: user.id, label: user.label, email: user.email })),
  }
}
