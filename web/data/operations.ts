import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"
import { getAuth } from "@/lib/auth"

export type DestructiveTarget =
  | {
      operation: "membership_disable" | "membership_remove"
      targetId: string
      targetType: "organization_membership"
    }
  | { operation: "team_delete"; targetId: string; targetType: "team" }
  | { operation: "role_reduce"; targetId: string; targetType: "role" }
  | { operation: "access_revoke"; targetId: string; targetType: "workspace_access" }
  | { operation: "workspace_delete"; targetId: string; targetType: "workspace" }

export type DestructiveImpactItem = {
  id: string
  detail: string
  group: "Access loss" | "Owned Agents" | "API keys" | "Consumers" | "External cleanup"
  href?: string
  label: string
  severity: "critical" | "warning" | "info"
}

export type DestructiveImpact = {
  confirmation: string
  fingerprint: string
  items: DestructiveImpactItem[]
  target: DestructiveTarget
  targetLabel: string
}

export type CleanupRow = {
  id: string
  operation: string
  targetType: string
  targetId: string
  state: "pending" | "running" | "retrying" | "failed" | "succeeded"
  impact: string[]
  attempts: number
  scheduledAt: string | null
  lastError: string | null
  createdAt: string
  completedAt: string | null
}

type ImpactDatabase = Pick<ReturnType<typeof getDB>, "select">

export async function analyzeDestructiveImpact(
  db: ImpactDatabase,
  organizationId: string,
  orgSlug: string,
  target: DestructiveTarget
): Promise<DestructiveImpact | null> {
  const items: DestructiveImpactItem[] = []
  let targetLabel: string

  if (target.operation === "membership_disable" || target.operation === "membership_remove") {
    const [member] = await db
      .select({
        email: schema.users.email,
        name: schema.users.name,
        userId: schema.members.userId,
      })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.members.id, target.targetId)
        )
      )
      .limit(1)
    if (!member) return null
    targetLabel = member.name

    const [roles, teams, agents, keys, shares] = await Promise.all([
      db
        .select({ id: schema.roleScopes.roleId, name: schema.roleScopes.displayName })
        .from(schema.memberRoles)
        .innerJoin(
          schema.roleScopes,
          and(
            eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
            eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
          )
        )
        .where(
          and(
            eq(schema.memberRoles.organizationId, organizationId),
            eq(schema.memberRoles.memberId, target.targetId)
          )
        )
        .orderBy(asc(schema.roleScopes.displayName))
        .limit(500),
      db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(
          and(
            eq(schema.teams.organizationId, organizationId),
            eq(schema.teamMembers.userId, member.userId)
          )
        )
        .orderBy(asc(schema.teams.name))
        .limit(500),
      db
        .select({
          name: schema.agentOwners.agentName,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.agentOwners)
        .innerJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.agentOwners.workspaceId),
            eq(schema.workspaces.organizationId, schema.agentOwners.organizationId)
          )
        )
        .where(
          and(
            eq(schema.agentOwners.organizationId, organizationId),
            eq(schema.agentOwners.ownerUserId, member.userId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.agentOwners.agentName))
        .limit(500),
      db
        .select({ id: schema.apiKeyScopes.apiKeyId, name: schema.apikeys.name })
        .from(schema.apiKeyScopes)
        .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, organizationId),
            eq(schema.apiKeyScopes.creatorUserId, member.userId),
            isNull(schema.apiKeyScopes.revokedAt)
          )
        )
        .orderBy(asc(schema.apikeys.name), asc(schema.apiKeyScopes.apiKeyId))
        .limit(500),
      db
        .select({
          id: schema.agentShares.id,
          name: schema.agentShares.agentName,
          workspace: schema.workspaces.name,
        })
        .from(schema.agentShares)
        .innerJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.agentShares.workspaceId),
            eq(schema.workspaces.organizationId, schema.agentShares.organizationId)
          )
        )
        .where(
          and(
            eq(schema.agentShares.organizationId, organizationId),
            eq(schema.agentShares.targetUserId, member.userId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.agentShares.agentName))
        .limit(500),
    ])
    items.push(
      ...roles.map((role) => ({
        detail: "Direct Role assignment is removed from the effective permission union.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/roles/${role.id}`,
        id: `role:${role.id}`,
        label: role.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Team-derived Roles and Agent Shares stop contributing access.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...shares.map((share) => ({
        detail: `Direct Agent Share in ${share.workspace} is revoked.`,
        group: "Access loss" as const,
        id: `share:${share.id}`,
        label: share.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail: `${agent.workspace}; Kubernetes and secret resources are queued for cleanup.`,
        group: "Owned Agents" as const,
        href: `/orgs/${orgSlug}/workspaces/${agent.workspaceSlug}/agents/${encodeURIComponent(agent.name)}`,
        id: `agent:${agent.workspaceSlug}:${agent.name}`,
        label: agent.name,
        severity: "critical" as const,
      })),
      ...keys.map((key) => ({
        detail: "The credential is revoked in the same transaction as access removal.",
        group: "API keys" as const,
        id: `key:${key.id}`,
        label: key.name,
        severity: "critical" as const,
      }))
    )
    if (agents.length) {
      items.push({
        detail: "Missing objects are treated as complete; temporary failures are retried durably.",
        group: "External cleanup",
        id: "external:member-agents",
        label: "Kubernetes and OpenBao Agent resources",
        severity: "warning",
      })
    }
  } else if (target.operation === "team_delete") {
    const [team] = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(
        and(eq(schema.teams.id, target.targetId), eq(schema.teams.organizationId, organizationId))
      )
      .limit(1)
    if (!team) return null
    targetLabel = team.name
    const [members, roles, shares] = await Promise.all([
      db
        .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
        .from(schema.teamMembers)
        .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .where(
          and(
            eq(schema.teamMembers.teamId, target.targetId),
            eq(schema.members.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email))
        .limit(500),
      db
        .select({ id: schema.roleScopes.roleId, name: schema.roleScopes.displayName })
        .from(schema.teamRoles)
        .innerJoin(
          schema.roleScopes,
          and(
            eq(schema.roleScopes.roleId, schema.teamRoles.roleId),
            eq(schema.roleScopes.organizationId, schema.teamRoles.organizationId)
          )
        )
        .where(
          and(
            eq(schema.teamRoles.teamId, target.targetId),
            eq(schema.teamRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.roleScopes.displayName))
        .limit(500),
      db
        .select({
          id: schema.agentShares.id,
          name: schema.agentShares.agentName,
          workspace: schema.workspaces.name,
        })
        .from(schema.agentShares)
        .innerJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.agentShares.workspaceId),
            eq(schema.workspaces.organizationId, schema.agentShares.organizationId)
          )
        )
        .where(
          and(
            eq(schema.agentShares.organizationId, organizationId),
            eq(schema.agentShares.targetTeamId, target.targetId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.agentShares.agentName))
        .limit(500),
    ])
    items.push(
      ...members.map((member) => ({
        detail: `${member.email}; every Team-derived permission is removed.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.id}`,
        id: `member:${member.id}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...roles.map((role) => ({
        detail: "The Team Role assignment is detached.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/roles/${role.id}`,
        id: `role:${role.id}`,
        label: role.name,
        severity: "warning" as const,
      })),
      ...shares.map((share) => ({
        detail: `Team Agent Share in ${share.workspace} is revoked.`,
        group: "Access loss" as const,
        id: `share:${share.id}`,
        label: share.name,
        severity: "critical" as const,
      }))
    )
  } else if (target.operation === "role_reduce") {
    const [role] = await db
      .select({ name: schema.roleScopes.displayName })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.roleId, target.targetId),
          eq(schema.roleScopes.organizationId, organizationId)
        )
      )
      .limit(1)
    if (!role) return null
    targetLabel = role.name
    const [members, teams, grants] = await Promise.all([
      db
        .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
        .from(schema.memberRoles)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberRoles.memberId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .where(
          and(
            eq(schema.memberRoles.roleId, target.targetId),
            eq(schema.memberRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email))
        .limit(500),
      db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamRoles)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamRoles.teamId))
        .where(
          and(
            eq(schema.teamRoles.roleId, target.targetId),
            eq(schema.teamRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.teams.name))
        .limit(500),
      db
        .select({
          action: schema.permissionGrants.action,
          resource: schema.permissionGrants.resource,
          workspace: schema.workspaces.name,
        })
        .from(schema.permissionGrants)
        .leftJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.permissionGrants.workspaceId),
            eq(schema.workspaces.organizationId, schema.permissionGrants.organizationId)
          )
        )
        .where(
          and(
            eq(schema.permissionGrants.roleId, target.targetId),
            eq(schema.permissionGrants.organizationId, organizationId)
          )
        )
        .orderBy(
          asc(schema.workspaces.name),
          asc(schema.permissionGrants.resource),
          asc(schema.permissionGrants.action)
        )
        .limit(500),
    ])
    items.push(
      ...members.map((member) => ({
        detail: `${member.email}; other direct and Team Roles may preserve access.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.id}`,
        id: `member:${member.id}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Every active Team member loses this Role source.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}/roles`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...grants.map((grant) => ({
        detail: grant.workspace ?? "Organisation",
        group: "Consumers" as const,
        id: `grant:${grant.workspace ?? "org"}:${grant.resource}:${grant.action}`,
        label: `${grant.resource}.${grant.action}`,
        severity: "warning" as const,
      }))
    )
  } else {
    const [workspace] = await db
      .select({
        name: schema.workspaces.name,
        namespace: schema.workspaces.namespace,
        slug: schema.workspaces.slug,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, target.targetId),
          eq(schema.workspaces.organizationId, organizationId),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .limit(1)
    if (!workspace) return null
    targetLabel = workspace.name
    const [members, teams, agents, keys, consumers] = await Promise.all([
      db
        .selectDistinct({
          id: schema.members.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.memberRoles)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberRoles.memberId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.memberRoles.roleId))
        .where(
          and(
            eq(schema.memberRoles.organizationId, organizationId),
            eq(schema.roleScopes.organizationId, organizationId),
            eq(schema.roleScopes.workspaceId, target.targetId)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email))
        .limit(500),
      db
        .selectDistinct({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamRoles)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamRoles.teamId))
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.teamRoles.roleId))
        .where(
          and(
            eq(schema.teamRoles.organizationId, organizationId),
            eq(schema.roleScopes.organizationId, organizationId),
            eq(schema.roleScopes.workspaceId, target.targetId)
          )
        )
        .orderBy(asc(schema.teams.name))
        .limit(500),
      db
        .select({ name: schema.agentOwners.agentName })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, organizationId),
            eq(schema.agentOwners.workspaceId, target.targetId)
          )
        )
        .orderBy(asc(schema.agentOwners.agentName))
        .limit(500),
      db
        .select({ id: schema.apiKeyScopes.apiKeyId, name: schema.apikeys.name })
        .from(schema.apiKeyScopes)
        .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, organizationId),
            eq(schema.apiKeyScopes.workspaceId, target.targetId),
            isNull(schema.apiKeyScopes.revokedAt)
          )
        )
        .orderBy(asc(schema.apikeys.name), asc(schema.apiKeyScopes.apiKeyId))
        .limit(500),
      db
        .select({
          name: schema.workspaceInheritedResources.resourceName,
          resource: schema.workspaceInheritedResources.resource,
        })
        .from(schema.workspaceInheritedResources)
        .where(
          and(
            eq(schema.workspaceInheritedResources.organizationId, organizationId),
            eq(schema.workspaceInheritedResources.workspaceId, target.targetId)
          )
        )
        .orderBy(
          asc(schema.workspaceInheritedResources.resource),
          asc(schema.workspaceInheritedResources.resourceName)
        )
        .limit(500),
    ])
    items.push(
      ...members.map((member) => ({
        detail: `${member.email}; direct Workspace Role access is revoked.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.id}`,
        id: `member:${member.id}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Team-derived Workspace Role access is revoked.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}/roles`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail:
          target.operation === "workspace_delete"
            ? "Queued with the Workspace namespace for external cleanup."
            : "Agent access is revoked.",
        group: "Owned Agents" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}/agents/${encodeURIComponent(agent.name)}`,
        id: `agent:${agent.name}`,
        label: agent.name,
        severity: "critical" as const,
      })),
      ...keys.map((key) => ({
        detail: "The Workspace credential is revoked transactionally.",
        group: "API keys" as const,
        id: `key:${key.id}`,
        label: key.name,
        severity: "critical" as const,
      })),
      ...consumers.map((consumer) => ({
        detail: "The Workspace selection of this Organisation resource is removed.",
        group: "Consumers" as const,
        id: `consumer:${consumer.resource}:${consumer.name}`,
        label: `${consumer.resource}: ${consumer.name}`,
        severity: "warning" as const,
      }))
    )
    if (target.operation === "workspace_delete") {
      items.push({
        detail: `Namespace ${workspace.namespace}, OpenBao paths, and S3 prefixes are deleted idempotently.`,
        group: "External cleanup",
        id: `external:${workspace.namespace}`,
        label: "Kubernetes, OpenBao, and S3",
        severity: "critical",
      })
    }
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ items, target, targetLabel }))
    .digest("hex")
  return { confirmation: targetLabel, fingerprint, items, target, targetLabel }
}

export async function getDestructiveImpact(orgSlug: string, target: DestructiveTarget) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) return
  return analyzeDestructiveImpact(getDB(), result.organization.id, orgSlug, target)
}

export async function retryDestructiveOperation(orgSlug: string, jobId: string) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return { error: "forbidden" as const }
  }

  return getDB().transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: schema.cleanupJobs.id,
        operation: schema.cleanupJobs.operation,
        targetId: schema.cleanupJobs.targetId,
        targetType: schema.cleanupJobs.targetType,
        workspaceId: schema.cleanupJobs.workspaceId,
      })
      .from(schema.cleanupJobs)
      .where(
        and(
          eq(schema.cleanupJobs.id, jobId),
          eq(schema.cleanupJobs.organizationId, result.organization.id),
          eq(schema.cleanupJobs.state, "failed")
        )
      )
      .for("update")
      .limit(1)
    if (!job) return { error: "not-found" as const }

    const now = new Date()
    await tx
      .update(schema.cleanupJobs)
      .set({
        completedAt: null,
        lastError: null,
        nextAttemptAt: now,
        state: "retrying",
        updatedAt: now,
      })
      .where(eq(schema.cleanupJobs.id, job.id))
    await tx.insert(schema.auditEvents).values({
      action: "cleanup.retry",
      actorId: result.organizationSession.session.user.id,
      actorType: "user",
      after: [{ field: "state", value: "retrying" }],
      automaticCascade: true,
      category: "cleanup",
      cleanupJobId: job.id,
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(result.organizationSession.requestHeaders, getAuth().options),
      organizationId: result.organization.id,
      result: "succeeded",
      targetId: job.targetId,
      targetType: job.targetType,
      userAgent: result.organizationSession.requestHeaders.get("user-agent"),
      workspaceId: job.workspaceId,
    })
    return { operation: job.operation }
  })
}

export async function listDestructiveOperations(orgSlug: string) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) return

  const rows = await getDB()
    .select({
      attempts: schema.cleanupJobs.attempts,
      completedAt: schema.cleanupJobs.completedAt,
      createdAt: schema.cleanupJobs.createdAt,
      id: schema.cleanupJobs.id,
      lastError: schema.cleanupJobs.lastError,
      leaseExpiresAt: schema.cleanupJobs.leaseExpiresAt,
      nextAttemptAt: schema.cleanupJobs.nextAttemptAt,
      operation: schema.cleanupJobs.operation,
      payload: schema.cleanupJobs.payload,
      state: schema.cleanupJobs.state,
      targetId: schema.cleanupJobs.targetId,
      targetType: schema.cleanupJobs.targetType,
    })
    .from(schema.cleanupJobs)
    .where(eq(schema.cleanupJobs.organizationId, result.organization.id))
    .orderBy(desc(schema.cleanupJobs.createdAt), desc(schema.cleanupJobs.id))
    .limit(200)

  return {
    organization: result.organization,
    rows: rows.map(
      (row): CleanupRow => ({
        ...row,
        completedAt: row.completedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        impact: [
          row.payload.revokes_authorization_first
            ? "Authorization revoked before cleanup"
            : undefined,
          row.payload.api_key_count > 0
            ? `${row.payload.api_key_count} API keys revoked`
            : undefined,
          row.payload.owned_agent_count > 0
            ? `${row.payload.owned_agent_count} owned Agents queued`
            : undefined,
        ].filter((item): item is string => Boolean(item)),
        scheduledAt:
          row.state === "running"
            ? (row.leaseExpiresAt?.toISOString() ?? null)
            : row.state === "pending" || row.state === "retrying"
              ? row.nextAttemptAt.toISOString()
              : null,
      })
    ),
  }
}
