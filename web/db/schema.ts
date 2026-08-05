import { sql } from "drizzle-orm"
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  apikeys,
  invitations,
  members,
  organizationRoles,
  organizations,
  teams,
  users,
} from "./auth-schema"

export * from "./auth-schema"

type AuditField = {
  field: "member_id" | "name" | "provisioning_attempt" | "role" | "slug" | "state" | "user_id"
  value: string
}

export const themePreference = pgEnum("theme_preference", ["system", "light", "dark"])
export const workspaceState = pgEnum("workspace_state", [
  "provisioning",
  "ready",
  "failed",
  "deleting",
])
export const systemRole = pgEnum("system_role", ["superadmin", "workspace_admin"])
export const permissionResource = pgEnum("permission_resource", [
  "mcp_connection",
  "skill",
  "sandbox",
  "inference_provider",
  "inference_pool",
  "agent",
  "api_key",
  "observability",
])
export const permissionAction = pgEnum("permission_action", [
  "read",
  "create",
  "modify",
  "delete",
  "author",
  "share_authored",
  "share_non_authored",
  "use_shared",
  "read_shared_secret",
  "write_shared_secret",
  "delete_shared_secret",
])
export const agentShareCapability = pgEnum("agent_share_capability", [
  "share_non_authored",
  "use_shared",
  "read_shared_secret",
  "write_shared_secret",
  "delete_shared_secret",
])
export const auditActor = pgEnum("audit_actor", ["user", "api_key", "system"])
export const auditResult = pgEnum("audit_result", ["succeeded", "denied", "failed"])
export const auditTarget = pgEnum("audit_target", [
  "organization",
  "organization_membership",
  "team",
  "mcp_connection",
  "role",
  "sandbox",
  "skill",
  "workspace",
])
export const auditInterface = pgEnum("audit_interface", [
  "web",
  "gateway",
  "better_auth",
  "controller",
  "system",
])
export const cleanupState = pgEnum("cleanup_state", ["pending", "running", "succeeded", "failed"])
export const destructiveOperation = pgEnum("destructive_operation", [
  "membership_disable",
  "membership_remove",
  "team_delete",
  "role_reduce",
  "access_revoke",
  "workspace_delete",
])
export const destructiveTarget = pgEnum("destructive_target", [
  "organization_membership",
  "team",
  "role",
  "workspace_access",
  "workspace",
])
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: themePreference("theme").default("system").notNull(),
  updateSandbox: boolean("update_sandbox").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    namespace: text("namespace").notNull().unique(),
    state: workspaceState("state").default("provisioning").notNull(),
    provisioningAttempt: bigint("provisioning_attempt", { mode: "number" }).default(1).notNull(),
    failureReason: text("failure_reason"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("workspaces_organization_slug_uidx").on(table.organizationId, table.slug),
    unique("workspaces_id_organization_uidx").on(table.id, table.organizationId),
    index("workspaces_organization_state_idx").on(table.organizationId, table.state),
    check("workspaces_provisioning_attempt_ck", sql`${table.provisioningAttempt} >= 1`),
    check(
      "workspaces_state_failure_reason_ck",
      sql`(${table.state} = 'failed' AND NULLIF(BTRIM(${table.failureReason}), '') IS NOT NULL) OR
        (${table.state} <> 'failed' AND ${table.failureReason} IS NULL)`
    ),
  ]
)

export const organizationSlugHistory = pgTable("organization_slug_history", {
  slug: text("slug").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

export const workspaceSlugHistory = pgTable(
  "workspace_slug_history",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.slug] }),
    index("workspace_slug_history_workspace_idx").on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "workspace_slug_history_workspace_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const roleScopes = pgTable(
  "role_scopes",
  {
    roleId: text("role_id")
      .primaryKey()
      .references(() => organizationRoles.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    displayName: text("display_name").notNull(),
    systemRole: systemRole("system_role"),
    immutable: boolean("immutable").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    unique("role_scopes_role_organization_uidx").on(table.roleId, table.organizationId),
    uniqueIndex("role_scopes_organization_name_uidx")
      .on(table.organizationId, sql`lower(btrim(${table.displayName}))`)
      .where(sql`${table.workspaceId} IS NULL`),
    uniqueIndex("role_scopes_workspace_name_uidx")
      .on(table.organizationId, table.workspaceId, sql`lower(btrim(${table.displayName}))`)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    uniqueIndex("role_scopes_organization_system_uidx")
      .on(table.organizationId, table.systemRole)
      .where(sql`${table.systemRole} IS NOT NULL AND ${table.workspaceId} IS NULL`),
    uniqueIndex("role_scopes_workspace_system_uidx")
      .on(table.organizationId, table.workspaceId, table.systemRole)
      .where(sql`${table.systemRole} IS NOT NULL AND ${table.workspaceId} IS NOT NULL`),
    index("role_scopes_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "role_scopes_workspace_organization_fk",
    }).onDelete("restrict"),
    check(
      "role_scopes_system_role_ck",
      sql`(${table.systemRole} IS NULL OR ${table.immutable}) AND
        (${table.systemRole} IS DISTINCT FROM 'superadmin' OR ${table.workspaceId} IS NULL) AND
        (${table.systemRole} IS DISTINCT FROM 'workspace_admin' OR ${table.workspaceId} IS NOT NULL)`
    ),
  ]
)

export const permissionGrants = pgTable(
  "permission_grants",
  {
    roleId: text("role_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id"),
    resource: permissionResource("resource").notNull(),
    action: permissionAction("action").notNull(),
    locked: boolean("locked").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("permission_grants_scope_uidx")
      .on(table.roleId, table.organizationId, table.workspaceId, table.resource, table.action)
      .nullsNotDistinct(),
    index("permission_grants_scope_idx").on(table.organizationId, table.workspaceId),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [roleScopes.roleId, roleScopes.organizationId],
      name: "permission_grants_role_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "permission_grants_workspace_organization_fk",
    }).onDelete("restrict"),
    check(
      "permission_grants_resource_action_ck",
      sql`(${table.resource} = 'agent' AND ${table.action} IN (
          'author', 'share_authored', 'share_non_authored', 'use_shared',
          'read_shared_secret', 'write_shared_secret', 'delete_shared_secret'
        )) OR (${table.resource} <> 'agent' AND ${table.action} IN (
          'read', 'create', 'modify', 'delete'
        ))`
    ),
  ]
)

export const memberRoles = pgTable(
  "member_roles",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.roleId] }),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [roleScopes.roleId, roleScopes.organizationId],
      name: "member_roles_role_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const teamRoles = pgTable(
  "team_roles",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.roleId] }),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [roleScopes.roleId, roleScopes.organizationId],
      name: "team_roles_role_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const invitationRoles = pgTable(
  "invitation_roles",
  {
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.invitationId, table.roleId] }),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [roleScopes.roleId, roleScopes.organizationId],
      name: "invitation_roles_role_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const invitationTeams = pgTable(
  "invitation_teams",
  {
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.invitationId, table.teamId] })]
)

export const socialAdmissionPolicies = pgTable("social_admission_policies", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

export const socialAdmissionGoogleDomains = pgTable(
  "social_admission_google_domains",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => socialAdmissionPolicies.organizationId, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.domain] })]
)

export const socialAdmissionGithubRules = pgTable(
  "social_admission_github_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => socialAdmissionPolicies.organizationId, { onDelete: "cascade" }),
    githubOrganization: text("github_organization").notNull(),
    githubTeam: text("github_team"),
  },
  (table) => [
    unique("social_admission_github_rules_rule_uidx")
      .on(table.organizationId, table.githubOrganization, table.githubTeam)
      .nullsNotDistinct(),
  ]
)

export const socialAdmissionDefaultRoles = pgTable(
  "social_admission_default_roles",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => socialAdmissionPolicies.organizationId, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.roleId] }),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [roleScopes.roleId, roleScopes.organizationId],
      name: "social_default_roles_role_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const socialAdmissionDefaultTeams = pgTable(
  "social_admission_default_teams",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => socialAdmissionPolicies.organizationId, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.teamId] })]
)

export const apiKeyScopes = pgTable(
  "api_key_scopes",
  {
    apiKeyId: text("api_key_id")
      .primaryKey()
      .references(() => apikeys.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("api_key_scopes_workspace_idx").on(table.organizationId, table.workspaceId),
    index("api_key_scopes_creator_idx").on(table.organizationId, table.creatorUserId),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "api_key_scopes_workspace_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const agentOwners = pgTable(
  "agent_owners",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    agentName: text("agent_name").notNull(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.agentName] }),
    unique("agent_owners_workspace_agent_organization_uidx").on(
      table.workspaceId,
      table.agentName,
      table.organizationId
    ),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "agent_owners_workspace_organization_fk",
    }).onDelete("restrict"),
  ]
)

export const agentShares = pgTable(
  "agent_shares",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    agentName: text("agent_name").notNull(),
    targetUserId: text("target_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    targetTeamId: text("target_team_id").references(() => teams.id, {
      onDelete: "cascade",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_shares_user_uidx")
      .on(table.workspaceId, table.agentName, table.targetUserId)
      .where(sql`${table.targetUserId} IS NOT NULL`),
    uniqueIndex("agent_shares_team_uidx")
      .on(table.workspaceId, table.agentName, table.targetTeamId)
      .where(sql`${table.targetTeamId} IS NOT NULL`),
    index("agent_shares_workspace_agent_idx").on(table.workspaceId, table.agentName),
    foreignKey({
      columns: [table.workspaceId, table.agentName, table.organizationId],
      foreignColumns: [agentOwners.workspaceId, agentOwners.agentName, agentOwners.organizationId],
      name: "agent_shares_owner_fk",
    }).onDelete("cascade"),
    check(
      "agent_shares_target_ck",
      sql`num_nonnulls(${table.targetUserId}, ${table.targetTeamId}) = 1`
    ),
  ]
)

export const agentShareGrants = pgTable(
  "agent_share_grants",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => agentShares.id, { onDelete: "cascade" }),
    capability: agentShareCapability("capability").notNull(),
  },
  (table) => [primaryKey({ columns: [table.shareId, table.capability] })]
)

export const cleanupJobs = pgTable(
  "cleanup_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id"),
    operation: destructiveOperation("operation").notNull(),
    targetType: destructiveTarget("target_type").notNull(),
    targetId: text("target_id").notNull(),
    state: cleanupState("state").default("pending").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("cleanup_jobs_id_organization_uidx").on(table.id, table.organizationId),
    index("cleanup_jobs_due_idx").on(table.state, table.nextAttemptAt),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "cleanup_jobs_workspace_organization_fk",
    }).onDelete("restrict"),
    check(
      "cleanup_jobs_lease_ck",
      sql`(${table.state} = 'running') =
        (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
    ),
    check(
      "cleanup_jobs_operation_target_ck",
      sql`(${table.operation} IN ('membership_disable', 'membership_remove') AND
          ${table.targetType} = 'organization_membership') OR
        (${table.operation} = 'team_delete' AND ${table.targetType} = 'team') OR
        (${table.operation} = 'role_reduce' AND ${table.targetType} = 'role') OR
        (${table.operation} = 'access_revoke' AND ${table.targetType} = 'workspace_access') OR
        (${table.operation} = 'workspace_delete' AND ${table.targetType} = 'workspace')`
    ),
  ]
)

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id"),
    actorType: auditActor("actor_type").notNull(),
    actorId: text("actor_id"),
    targetType: auditTarget("target_type").notNull(),
    targetId: text("target_id").notNull(),
    category: text("category").notNull(),
    action: text("action").notNull(),
    result: auditResult("result").notNull(),
    before: jsonb("before").$type<AuditField[]>(),
    after: jsonb("after").$type<AuditField[]>(),
    automaticCascade: boolean("automatic_cascade").default(false).notNull(),
    cleanupJobId: text("cleanup_job_id"),
    interface: auditInterface("interface").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id
    ),
    index("audit_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("audit_events_created_idx").on(table.createdAt),
    foreignKey({
      columns: [table.cleanupJobId, table.organizationId],
      foreignColumns: [cleanupJobs.id, cleanupJobs.organizationId],
      name: "audit_events_cleanup_job_organization_fk",
    }).onDelete("restrict"),
    check(
      "audit_events_actor_ck",
      sql`(${table.actorType} = 'system' AND ${table.actorId} IS NULL) OR
        (${table.actorType} <> 'system' AND ${table.actorId} IS NOT NULL)`
    ),
    check(
      "audit_events_workspace_target_ck",
      sql`${table.targetType} <> 'workspace' OR
        (${table.workspaceId} IS NOT NULL AND ${table.targetId} = ${table.workspaceId})`
    ),
  ]
)

export const lastAccessibleContexts = pgTable(
  "last_accessible_contexts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    route: text("route").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.organizationId] }),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "last_accessible_contexts_workspace_organization_fk",
    }).onDelete("restrict"),
  ]
)
