"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
  type Error,
  type ListEnvironmentsData,
  type McpConnectionRef,
} from "@/lib/gateway/client"
import { createEnvironmentFormSchema } from "@/data/schema"
import type {
  CreateEnvironmentFormState,
  DeleteEnvironmentFormState,
  ListEnvironmentActionResponse,
} from "@/data/types"
import type * as z from "zod"
import { environmentsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

export async function listEnvironmentsAction(
  query?: ListEnvironmentsData["query"]
): Promise<ListEnvironmentActionResponse> {
  const result = await listEnvironments({
    query,
    cache: "no-store",
    client: gatewayServerClient,
  })
  if (result.error) {
    return {
      environments: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error: result.error,
    }
  }

  const environments = result.data.environments
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    environments,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}

function environmentFormValues(formData: FormData) {
  const refsByName = new Map<
    string,
    {
      name: string
      tools: Array<{ name: string; requireConsent: boolean }>
    }
  >()
  for (const value of formData.getAll("mcpConnectionRefs")) {
    const name = String(value)
    refsByName.set(name, {
      name,
      tools: [],
    })
  }
  const consentByTool = new Set(
    formData.getAll("mcpRequireConsentTool").map((value) => String(value))
  )
  for (const value of formData.getAll("mcpTool")) {
    const [name, toolName] = String(value).split("\u0000")
    if (!name || !toolName) {
      continue
    }
    const ref = refsByName.get(name)
    if (!ref) {
      continue
    }
    ref.tools.push({
      name: toolName,
      requireConsent: consentByTool.has(`${name}\u0000${toolName}`),
    })
  }

  return {
    packages: formData.getAll("packages").map((p) => String(p)),
    allowedHosts: formData.getAll("allowedHosts").map((h) => String(h)),
    mcpConnectionRefs: [...refsByName.values()].map((ref) => ({
      name: ref.name,
      tools: ref.tools,
    })),
  }
}

export async function deleteEnvironmentFormAction(
  name: string,
  _: DeleteEnvironmentFormState,
  _formData: FormData
): Promise<DeleteEnvironmentFormState> {
  let pageToken = ""
  for (;;) {
    const listResult = await listEnvironments({
      client: gatewayServerClient,
      query: { limit: 200, page_token: pageToken || undefined },
      cache: "no-store",
    })
    if (listResult.error) {
      return { error: listResult.error }
    }

    const environment = listResult.data.environments.find((env) => env.name === name)
    if (environment) {
      if (environment.metadata.referenced_by_agent) {
        return {
          error: {
            code: "ENVIRONMENT_REFERENCED",
            message: "Environment is referenced by one or more agents",
          },
        }
      }
      break
    }

    pageToken = listResult.data.next_page_token
    if (pageToken.length === 0) {
      break
    }
  }

  const result = await deleteEnvironment({
    body: { name },
    client: gatewayServerClient,
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(environmentsTag)
  redirect("/environments")
}

export async function createEnvironmentFormAction(
  _: CreateEnvironmentFormState,
  formData: FormData
): Promise<CreateEnvironmentFormState> {
  const parsed = createEnvironmentFormSchema.safeParse({
    name: formData.get("name"),
    ...environmentFormValues(formData),
  })

  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Environment configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    }
  }

  const result = await createEnvironment({
    client: gatewayServerClient,
    body: {
      name: parsed.data.name,
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
      mcp_connection_refs: parsed.data.mcpConnectionRefs.map(
        (ref): McpConnectionRef => ({
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(environmentsTag)
  redirect("/environments")
}

export async function updateEnvironmentFormAction(
  name: string,
  _: CreateEnvironmentFormState,
  formData: FormData
): Promise<CreateEnvironmentFormState> {
  const parsed = createEnvironmentFormSchema
    .omit({ name: true })
    .safeParse(environmentFormValues(formData))

  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Environment configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    }
  }

  const result = await updateEnvironment({
    client: gatewayServerClient,
    body: {
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
      mcp_connection_refs: parsed.data.mcpConnectionRefs.map(
        (ref): McpConnectionRef => ({
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
    },
    path: { name },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(environmentsTag)
  redirect("/environments")
}
