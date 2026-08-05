"use server"

import { revalidatePath, updateTag } from "next/cache"
import {
  createInferencePool,
  deleteInferencePool,
  getInferencePoolUsage,
  updateInferencePool,
  type Error as GatewayError,
  type InferencePool,
  type InferencePoolUsage,
  type InferencePoolWrite,
} from "@/lib/gateway/client"
import {
  zCreateInferencePoolRequest,
  zInferencePoolName,
  zUpdateInferencePoolRequest,
} from "@/lib/gateway/client/zod.gen"
import { inferencePoolsTag, inferenceProvidersTag, sandboxesTag } from "@/data/cache"
import {
  listInferencePoolsCachedQuery,
  type InferencePoolsResult,
} from "@/data/inference-pool.queries"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type SaveInferencePoolInput =
  | { poolName: string; resourceVersion: string; pool: InferencePoolWrite }
  | { poolName?: undefined; resourceVersion?: undefined; pool: InferencePoolWrite }

export type InferencePoolActionScope = { basePath: string; workspaceId: string }

export async function saveInferencePoolAction(
  scope: InferencePoolActionScope,
  input: SaveInferencePoolInput
): Promise<{ pool?: InferencePool; error?: GatewayError }> {
  let result
  if (input.poolName !== undefined) {
    const name = zInferencePoolName.safeParse(input.poolName)
    const body = zUpdateInferencePoolRequest.safeParse({
      resource_version: input.resourceVersion,
      pool: input.pool,
    })
    if (!name.success || !body.success) {
      return { error: { code: "INVALID_FORM", message: "Pool configuration is invalid" } }
    }
    result = await updateInferencePool({
      path: { poolName: name.data },
      body: body.data,
      client: getGatewayServerClient(scope.workspaceId),
      headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
    })
  } else {
    const body = zCreateInferencePoolRequest.safeParse(input.pool)
    if (!body.success) {
      return {
        error: {
          code: "INVALID_FORM",
          message: "Pool configuration is invalid",
          errors: body.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      }
    }
    result = await createInferencePool({
      body: body.data,
      client: getGatewayServerClient(scope.workspaceId),
      headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
    })
  }
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferencePoolsTag)
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  revalidatePath(`${scope.basePath}/sandboxes/new`)
  revalidatePath(`${scope.basePath}/sandboxes/update/[name]`, "page")
  return { pool: result.data }
}

export async function deleteInferencePoolAction(
  scope: InferencePoolActionScope,
  name: string
): Promise<{ error?: GatewayError }> {
  const parsed = zInferencePoolName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid Pool ID" } }
  }
  const result = await deleteInferencePool({
    path: { poolName: parsed.data },
    client: getGatewayServerClient(scope.workspaceId),
    headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
  })
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferencePoolsTag)
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  revalidatePath(`${scope.basePath}/sandboxes/new`)
  revalidatePath(`${scope.basePath}/sandboxes/update/[name]`, "page")
  return {}
}

export async function getInferencePoolUsageAction(
  scope: InferencePoolActionScope,
  name: string
): Promise<{ usage?: InferencePoolUsage; error?: GatewayError }> {
  const parsed = zInferencePoolName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid Pool ID" } }
  }
  const result = await getInferencePoolUsage({
    path: { poolName: parsed.data },
    client: getGatewayServerClient(scope.workspaceId),
    headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
  })
  if (result.error) {
    return { error: result.error }
  }
  return { usage: result.data }
}

export async function refreshInferencePoolsAction(
  scope: InferencePoolActionScope
): Promise<InferencePoolsResult> {
  updateTag(inferencePoolsTag)
  return listInferencePoolsCachedQuery(scope.workspaceId)
}
