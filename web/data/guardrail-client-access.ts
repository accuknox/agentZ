import "server-only"

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getWorkspaceScope } from "@/data/workspaces"
import type { GuardrailAssignment } from "@/lib/gateway/client"

export async function listGuardrailClientAccess(orgSlug: string, workspaceSlug: string) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") return
  if (!scope.scope.organization.superadmin && !scope.workspace.capabilities.administer) return
  const db = getDB()
  const [grants, saved] = await Promise.all([
    db
      .select({
        clientId: schema.delegationGrants.clientId,
        name: schema.oauthClients.name,
        principal: schema.users.email,
        selection: schema.delegationGrants.selection,
      })
      .from(schema.delegationGrants)
      .innerJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.delegationGrants.clientId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.delegationGrants.userId))
      .where(
        and(
          eq(schema.delegationGrants.organizationId, scope.scope.organization.id),
          isNotNull(schema.delegationGrants.approvedAt),
          isNull(schema.delegationGrants.revokedAt)
        )
      )
      .orderBy(asc(schema.oauthClients.name)),
    db
      .select()
      .from(schema.guardrailClientAccess)
      .where(
        and(
          eq(schema.guardrailClientAccess.organizationId, scope.scope.organization.id),
          eq(schema.guardrailClientAccess.workspaceId, scope.workspace.id)
        )
      ),
  ])
  const assignments = new Map(saved.map((assignment) => [assignment.clientId, assignment]))
  const clients = new Map<
    string,
    {
      clientId: string
      name: string
      principals: string[]
      models: string[]
      guardrails: GuardrailAssignment
      updatedAt?: string
    }
  >()
  for (const grant of grants) {
    const models = grant.selection.models.filter(
      (model) => model.workspace_id === scope.workspace.id
    )
    if (!models.length) continue
    let client = clients.get(grant.clientId)
    if (!client) {
      const assignment = assignments.get(grant.clientId)
      client = {
        clientId: grant.clientId,
        name: grant.name ?? "External application",
        principals: [],
        models: [],
        guardrails: {
          policies: assignment?.policies ?? [],
        },
        updatedAt: assignment?.updatedAt.toISOString(),
      }
      clients.set(grant.clientId, client)
    }
    if (!client.principals.includes(grant.principal)) client.principals.push(grant.principal)
    for (const model of models) {
      const label = model.model_display_name || model.model
      if (!client.models.includes(label)) client.models.push(label)
    }
  }
  return {
    clients: [...clients.values()],
    workspace: scope.workspace,
    organization: scope.scope.organization,
  }
}
