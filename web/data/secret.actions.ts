"use server"

import { updateTag } from "next/cache"
import { redirect } from "next/navigation"
import { deleteSecret, listSecrets, putSecret } from "@/lib/gateway/client"
import type { Error } from "@/lib/gateway/client"
import { zSecretKey } from "@/lib/gateway/client/zod.gen"
import { agentSecretsTag, secretsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"
import { secretHostsInputSchema, secretValueSchema } from "./schema"
import type { DeleteSecretFormState, PutSecretFormState } from "./types"

async function fetchAllSecretKeys(agentName: string): Promise<string[] | Error> {
  const keys: string[] = []
  let pageToken: string | undefined

  while (true) {
    const result = await listSecrets({
      client: gatewayServerClient,
      path: { agentName },
      query: { limit: 200, page_token: pageToken },
      cache: "no-store",
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

export async function putSecretFormAction(
  agentName: string,
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
    const existingKeys = await fetchAllSecretKeys(agentName)
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
    client: gatewayServerClient,
    path: { agentName },
    body: {
      secrets: [{ key: parsedKey.data, value: parsedValue.data, hosts: parsedHosts.data }],
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(secretsTag)
  updateTag(agentSecretsTag(agentName))
  redirect(`/secrets?agent_name=${encodeURIComponent(agentName)}`)
}

export async function deleteSecretFormAction(
  agentName: string,
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
    client: gatewayServerClient,
    path: { agentName },
    body: {
      keys: [parsedKey.data],
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(secretsTag)
  updateTag(agentSecretsTag(agentName))
  redirect(`/secrets?agent_name=${encodeURIComponent(agentName)}`)
}
