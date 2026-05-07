"use server"

import { revalidatePath } from "next/cache"
import { deleteSecret, listSecrets, putSecret } from "@/lib/gateway/client"
import type { Error, SecretListItem } from "@/lib/gateway/client"
import { zSecretKey } from "@/lib/gateway/client/zod.gen"
import { secretHostsInputSchema, secretValueSchema } from "./schema"

export type ListSecretsActionResponse =
  | {
      items: SecretListItem[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      items: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listSecretsAction(
  sessionID: string,
  query?: { limit?: number; page_token?: string }
): Promise<ListSecretsActionResponse> {
  const result = await listSecrets({
    path: { sessionID },
    query,
  })

  if (result.error) {
    return {
      items: undefined,
      error: result.error,
    }
  }

  const items = result.data.items
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    items,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}

async function fetchAllSecretKeys(sessionID: string): Promise<string[] | Error> {
  const keys: string[] = []
  let pageToken: string | undefined

  while (true) {
    const result = await listSecrets({
      path: { sessionID },
      query: { limit: 200, page_token: pageToken },
    })

    if (result.error) {
      return result.error
    }

    for (const item of result.data.items) {
      keys.push(item.key)
    }

    const next = result.data.next_page_token
    if (!next || next.length === 0) {
      break
    }

    pageToken = next
  }

  return keys
}

export type PutSecretFormState = {
  error?: Error
}

export async function putSecretFormAction(
  sessionID: string,
  _: PutSecretFormState,
  formData: FormData
): Promise<PutSecretFormState> {
  const key = formData.get("key")
  const value = formData.get("value")
  const hosts = formData.get("hosts")
  const mode = formData.get("mode")

  const parsedKey = zSecretKey.safeParse(key)
  if (!parsedKey.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Secret configuration is invalid",
        errors: parsedKey.error.issues.map((issue) => ({
          field: "key",
          message: issue.message,
        })),
      },
    }
  }

  const parsedValue = secretValueSchema.safeParse(value)
  if (!parsedValue.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Secret configuration is invalid",
        errors: parsedValue.error.issues.map((issue) => ({
          field: "value",
          message: issue.message,
        })),
      },
    }
  }

  const parsedHosts = secretHostsInputSchema.safeParse(hosts)
  if (!parsedHosts.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Secret configuration is invalid",
        errors: parsedHosts.error.issues.map((issue) => ({
          field: "hosts",
          message: issue.message,
        })),
      },
    }
  }

  if (mode !== "update") {
    const existingKeys = await fetchAllSecretKeys(sessionID)
    if (Array.isArray(existingKeys)) {
      const normalizedKey = parsedKey.data.toLowerCase()
      const duplicate = existingKeys.find((k) => k.toLowerCase() === normalizedKey)
      if (duplicate) {
        return {
          error: {
            code: "DUPLICATE_SECRET",
            message: "Secret configuration is invalid",
            errors: [
              {
                field: "key",
                message: `A secret named "${duplicate}" already exists. Secrets are case-insensitive.`,
              },
            ],
          },
        }
      }
    }
  }

  const result = await putSecret({
    path: { sessionID },
    body: {
      secrets: [{ key: parsedKey.data, value: parsedValue.data, hosts: parsedHosts.data }],
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  revalidatePath("/secrets")
  return {}
}

export type DeleteSecretFormState = {
  error?: Error
}

export async function deleteSecretFormAction(
  sessionID: string,
  _: DeleteSecretFormState,
  formData: FormData
): Promise<DeleteSecretFormState> {
  const key = formData.get("key")

  const parsedKey = zSecretKey.safeParse(key)
  if (!parsedKey.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid secret key",
        errors: parsedKey.error.issues.map((issue) => ({
          field: "key",
          message: issue.message,
        })),
      },
    }
  }

  const result = await deleteSecret({
    path: { sessionID },
    body: {
      keys: [parsedKey.data],
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  revalidatePath("/secrets")
  return {}
}
