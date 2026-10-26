"use server"

import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { updateTag } from "next/cache"
import {
  createGuardrailConnection,
  updateGuardrailConnection,
  deleteGuardrailConnection,
  createGuardrailPolicy,
  updateGuardrailPolicy,
  deleteGuardrailPolicy,
  updateGuardrailSettings,
  getEffectiveGuardrails,
  discoverGuardrailConnectionResources,
  type CreateGuardrailConnectionData,
  type GuardrailAssignment,
  type GuardrailPolicyInput,
  type GuardrailSettings,
  type GuardrailResourceDiscoveryInput,
} from "@/lib/gateway/client"
import {
  zGuardrailAssignment,
  zGuardrailConnectionInputWritable,
  zGuardrailPolicyInput,
  zGuardrailSettings,
  zGuardrailResourceDiscoveryInput,
} from "@/lib/gateway/client/zod.gen"
import { listGuardrailClientAccess } from "@/data/guardrail-client-access"
import { listGuardrailPoliciesQuery, getGuardrailSettingsQuery } from "@/data/guardrail.queries"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { sandboxesTag } from "@/data/cache"

export type GuardrailActionScope = { workspaceId?: string }

export async function discoverGuardrailResourcesAction(
  scope: GuardrailActionScope,
  name: string,
  body: GuardrailResourceDiscoveryInput
) {
  const parsed = zGuardrailResourceDiscoveryInput.safeParse(body)
  if (!parsed.success)
    return { error: { code: "INVALID_FORM", message: "Select a valid resource discovery target" } }
  const result = await discoverGuardrailConnectionResources({
    path: { name },
    body: parsed.data,
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }
  return { data: result.data }
}

export async function saveGuardrailConnectionAction(
  scope: GuardrailActionScope,
  body: CreateGuardrailConnectionData["body"],
  existing = false
) {
  const parsed = zGuardrailConnectionInputWritable.safeParse(body)
  if (!parsed.success)
    return {
      error: {
        code: "INVALID_FORM",
        message: parsed.error.issues[0]?.message ?? "Check connection fields",
      },
    }
  const options = {
    body: parsed.data,
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  }
  const result = existing
    ? await updateGuardrailConnection({ ...options, path: { name: parsed.data.name } })
    : await createGuardrailConnection(options)
  if (result.error) return { error: result.error }
  return { data: result.data }
}

export async function deleteGuardrailConnectionAction(scope: GuardrailActionScope, name: string) {
  const result = await deleteGuardrailConnection({
    path: { name },
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }
  return { success: true }
}

export async function saveGuardrailPolicyAction(
  scope: GuardrailActionScope,
  body: GuardrailPolicyInput,
  existing = false
) {
  const parsed = zGuardrailPolicyInput.safeParse(body)
  if (!parsed.success)
    return {
      error: {
        code: "INVALID_FORM",
        message: parsed.error.issues[0]?.message ?? "Check policy fields",
      },
    }
  const options = {
    body: parsed.data,
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  }
  const result = existing
    ? await updateGuardrailPolicy({ ...options, path: { name: parsed.data.name } })
    : await createGuardrailPolicy(options)
  if (result.error) return { error: result.error }
  updateTag(sandboxesTag)
  return { data: result.data }
}

export async function deleteGuardrailPolicyAction(scope: GuardrailActionScope, name: string) {
  const result = await deleteGuardrailPolicy({
    path: { name },
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }
  return { success: true }
}

export async function saveGuardrailSettingsAction(settings: GuardrailSettings) {
  const parsed = zGuardrailSettings.safeParse(settings)
  if (!parsed.success)
    return {
      error: {
        code: "INVALID_FORM",
        message: parsed.error.issues[0]?.message ?? "Check organization settings",
      },
    }
  const result = await updateGuardrailSettings({
    body: parsed.data,
    client: getGatewayServerClient(),
  })
  if (result.error) return { error: result.error }
  updateTag(sandboxesTag)
  return { data: result.data }
}

export async function saveGuardrailClientAccessAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string,
  input: GuardrailAssignment
) {
  const parsed = zGuardrailAssignment.safeParse(input)
  if (!parsed.success) return { error: "Check policy assignments." }
  const [access, session] = await Promise.all([
    listGuardrailClientAccess(orgSlug, workspaceSlug),
    getAuthSession(),
  ])
  if (!access || !session || !access.clients.some((client) => client.clientId === clientId))
    return { error: "This client does not have editable model access in this workspace." }
  const validated = await getEffectiveGuardrails({
    client: getGatewayServerClient(access.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": access.workspace.id },
    body: { assignment: parsed.data },
  })
  if (validated.error) return { error: validated.error.message }
  const policies = parsed.data.policies ?? []
  await getDB().transaction(async (tx) => {
    await tx
      .insert(schema.guardrailClientAccess)
      .values({
        organizationId: access.organization.id,
        workspaceId: access.workspace.id,
        clientId,
        policies,
        updatedBy: session.session.user.id,
      })
      .onConflictDoUpdate({
        target: [
          schema.guardrailClientAccess.organizationId,
          schema.guardrailClientAccess.workspaceId,
          schema.guardrailClientAccess.clientId,
        ],
        set: { policies, updatedBy: session.session.user.id, updatedAt: new Date() },
      })
    await tx.insert(schema.eventTrailEvents).values({
      id: `event-trail-${randomUUID()}`,
      organizationId: access.organization.id,
      workspaceId: access.workspace.id,
      actorId: session.session.user.id,
      actorType: "user",
      action: "guardrails.client_access.update",
      category: "guardrails",
      result: "succeeded",
      targetId: clientId,
      targetType: "external_access_guardrails",
    })
    await tx.execute(sql`select pg_notify('agentz_guardrails', ${access.workspace.id})`)
  })
  return { success: true }
}

export async function loadClientGuardrailsAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string
) {
  const access = await listGuardrailClientAccess(orgSlug, workspaceSlug)
  const subject = access?.clients.find((client) => client.clientId === clientId)
  if (!access || !subject)
    return { error: "This client does not have editable model access in this workspace." }
  const [policies, settings] = await Promise.all([
    listGuardrailPoliciesQuery(access.workspace.id),
    getGuardrailSettingsQuery(access.workspace.id),
  ])
  if (policies.error || settings.error)
    return {
      error: policies.error?.message ?? settings.error?.message ?? "Could not load guardrails.",
    }
  return {
    data: {
      subject,
      policies: policies.data.items,
      settings: settings.data,
      workspaceId: access.workspace.id,
    },
  }
}
