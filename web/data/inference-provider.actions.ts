"use server"

import { updateTag } from "next/cache"
import {
  createInferenceProvider,
  deleteInferenceProvider,
  getInferenceProviderUsage,
  listInferenceProviderCatalog,
  listInferenceModelSuggestions,
  updateInferenceProvider,
  type CreateInferenceProviderRequestWritable,
  type Error as GatewayError,
  type InferenceProvider,
  type InferenceModelSuggestions,
  type InferenceProviderCatalog,
  type InferenceProviderKind,
  type InferenceProviderUsage,
  type UpdateInferenceProviderRequestWritable,
} from "@/lib/gateway/client"
import {
  zCreateInferenceProviderRequestWritable,
  zInferenceProviderCatalogEntry,
  zInferenceProviderName,
  zInferenceProviderKind,
  zUpdateInferenceProviderRequestWritable,
} from "@/lib/gateway/client/zod.gen"
import { inferenceProvidersTag, sandboxesTag } from "@/data/cache"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import type { InferenceProvidersResult } from "@/data/inference-provider.queries"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type SaveInferenceProviderState =
  | { provider: InferenceProvider; error?: undefined }
  | { provider?: undefined; error: GatewayError }

type SuggestInferenceModelsState =
  | { data: InferenceModelSuggestions; error?: undefined }
  | { data?: undefined; error: GatewayError }

type ListInferenceProviderCatalogState =
  | { data: InferenceProviderCatalog; error?: undefined }
  | { data?: undefined; error: GatewayError }

type SaveInferenceProviderInput =
  | { providerName: string; body: UpdateInferenceProviderRequestWritable }
  | { providerName?: undefined; body: CreateInferenceProviderRequestWritable }

export async function saveInferenceProviderAction(
  input: SaveInferenceProviderInput
): Promise<SaveInferenceProviderState> {
  let result
  if (input.providerName !== undefined) {
    const providerName = zInferenceProviderName.safeParse(input.providerName)
    if (!providerName.success) {
      return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
    }
    const parsed = zUpdateInferenceProviderRequestWritable.safeParse(input.body)
    if (!parsed.success) {
      return {
        error: {
          code: "INVALID_FORM",
          message: "Provider configuration is invalid",
          errors: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      }
    }
    result = await updateInferenceProvider({
      path: { providerName: providerName.data },
      body: parsed.data,
      client: getGatewayServerClient(),
    })
  } else {
    const parsed = zCreateInferenceProviderRequestWritable.safeParse(input.body)
    if (!parsed.success) {
      return {
        error: {
          code: "INVALID_FORM",
          message: "Provider configuration is invalid",
          errors: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      }
    }
    result = await createInferenceProvider({
      body: parsed.data,
      client: getGatewayServerClient(),
    })
  }
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  return { provider: result.data }
}

export async function deleteInferenceProviderAction(
  name: string
): Promise<{ error?: GatewayError }> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid provider ID",
      },
    }
  }
  const result = await deleteInferenceProvider({
    path: { providerName: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  updateTag(inferenceProvidersTag)
  updateTag(sandboxesTag)
  return {}
}

export async function getInferenceProviderUsageAction(
  name: string
): Promise<{ usage?: InferenceProviderUsage; error?: GatewayError }> {
  const parsed = zInferenceProviderName.safeParse(name)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider ID" } }
  }
  const result = await getInferenceProviderUsage({
    path: { providerName: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { usage: result.data }
}

export async function refreshInferenceProvidersAction(): Promise<InferenceProvidersResult> {
  updateTag(inferenceProvidersTag)
  return listInferenceProvidersCachedQuery()
}

export async function listInferenceProviderCatalogAction(): Promise<ListInferenceProviderCatalogState> {
  const result = await listInferenceProviderCatalog({ client: getGatewayServerClient() })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}

export async function suggestInferenceModelsAction(
  catalogProvider: string,
  providerKind: InferenceProviderKind
): Promise<SuggestInferenceModelsState> {
  const provider = zInferenceProviderCatalogEntry.shape.provider_id.safeParse(catalogProvider)
  if (!provider.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid catalog provider" } }
  }
  const parsed = zInferenceProviderKind.safeParse(providerKind)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider kind" } }
  }
  const result = await listInferenceModelSuggestions({
    path: { catalogProvider: provider.data },
    query: { provider_kind: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}
