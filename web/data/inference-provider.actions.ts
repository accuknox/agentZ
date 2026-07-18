"use server"

import { updateTag } from "next/cache"
import {
  createInferenceProvider,
  deleteInferenceProvider,
  listInferenceModelSuggestions,
  updateInferenceProvider,
  type CreateInferenceProviderRequestWritable,
  type Error as GatewayError,
  type InferenceProvider,
  type InferenceModelSuggestions,
  type InferenceProviderType,
  type UpdateInferenceProviderRequestWritable,
} from "@/lib/gateway/client"
import {
  zCreateInferenceProviderRequestWritable,
  zInferenceProviderName,
  zInferenceProviderType,
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

export async function refreshInferenceProvidersAction(): Promise<InferenceProvidersResult> {
  updateTag(inferenceProvidersTag)
  return listInferenceProvidersCachedQuery()
}

export async function suggestInferenceModelsAction(
  providerType: InferenceProviderType
): Promise<SuggestInferenceModelsState> {
  const parsed = zInferenceProviderType.safeParse(providerType)
  if (!parsed.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid provider type" } }
  }
  const result = await listInferenceModelSuggestions({
    query: { provider_type: parsed.data },
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return { error: result.error }
  }
  return { data: result.data }
}
