"use server"

import { randomUUID } from "node:crypto"
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
import { getExternalAgentGuardrails } from "@/data/external-agents"
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
        message: parsed.error.issues[0]?.message ?? "Check provider fields",
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

export async function saveExternalAgentGuardrailsAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string,
  input: GuardrailAssignment
) {
  const parsed = zGuardrailAssignment.safeParse(input)
  if (!parsed.success) return { error: "Check policy assignments." }
  const [access, session] = await Promise.all([
    getExternalAgentGuardrails(orgSlug, workspaceSlug, clientId),
    getAuthSession(),
  ])
  if (!access || !session)
    return { error: "This external agent does not have editable guardrails in this workspace." }
  const validated = await getEffectiveGuardrails({
    client: getGatewayServerClient(access.workspaceId),
    headers: { "X-AgentZ-Workspace-ID": access.workspaceId },
    body: { assignment: parsed.data },
  })
  if (validated.error) return { error: validated.error.message }
  const policies = parsed.data.policies ?? []
  await getDB().transaction(async (tx) => {
    await tx
      .insert(schema.guardrailClientAccess)
      .values({
        organizationId: access.organizationId,
        workspaceId: access.workspaceId,
        clientId,
        policies,
      })
      .onConflictDoUpdate({
        target: [
          schema.guardrailClientAccess.organizationId,
          schema.guardrailClientAccess.workspaceId,
          schema.guardrailClientAccess.clientId,
        ],
        set: { policies, updatedAt: new Date() },
      })
    await tx.insert(schema.eventTrailEvents).values({
      id: `event-trail-${randomUUID()}`,
      organizationId: access.organizationId,
      workspaceId: access.workspaceId,
      actorId: session.session.user.id,
      actorType: "user",
      action: "guardrails.external_agent.update",
      category: "guardrails",
      result: "succeeded",
      targetId: clientId,
      targetType: "external_access_guardrails",
    })
  })
  return { success: true }
}

export async function loadExternalAgentGuardrailsAction(
  orgSlug: string,
  workspaceSlug: string,
  clientId: string
) {
  const access = await getExternalAgentGuardrails(orgSlug, workspaceSlug, clientId)
  if (!access)
    return { error: "This external agent does not have editable guardrails in this workspace." }
  const [policies, settings] = await Promise.all([
    listGuardrailPoliciesQuery(access.workspaceId),
    getGuardrailSettingsQuery(access.workspaceId),
  ])
  if (policies.error || settings.error)
    return {
      error: policies.error?.message ?? settings.error?.message ?? "Could not load guardrails.",
    }
  return {
    data: {
      assignment: access.assignment,
      updatedAt: access.updatedAt,
      policies: policies.data.items,
      settings: settings.data,
    },
  }
}
