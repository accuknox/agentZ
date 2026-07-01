"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import {
  createSandbox,
  deleteSandbox,
  listSandboxes,
  updateSandbox,
  type Error,
  type ListSandboxesData,
  type McpConnectionRef,
} from "@/lib/gateway/client"
import { createSandboxFormSchema } from "@/data/schema"
import type {
  CreateSandboxFormState,
  DeleteSandboxFormState,
  ListSandboxActionResponse,
} from "@/data/types"
import type * as z from "zod"
import { sandboxesTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listSandboxesAction(
  query?: ListSandboxesData["query"]
): Promise<ListSandboxActionResponse> {
  const result = await listSandboxes({
    query,
    client: getGatewayServerClient(),
  })
  if (result.error) {
    return {
      sandboxes: undefined,
      nextPageToken: undefined,
      hasNextPage: undefined,
      error: result.error,
    }
  }

  const sandboxes = result.data.sandboxes
  const nextPageToken = result.data.next_page_token
  const hasNextPage = nextPageToken.length > 0

  return {
    sandboxes,
    nextPageToken,
    hasNextPage,
    error: undefined,
  }
}

function sandboxFormValues(formData: FormData) {
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

export async function deleteSandboxFormAction(
  name: string,
  _: DeleteSandboxFormState,
  _formData: FormData
): Promise<DeleteSandboxFormState> {
  let pageToken = ""
  for (;;) {
    const listResult = await listSandboxes({
      client: getGatewayServerClient(),
      query: { limit: 200, page_token: pageToken || undefined },
    })
    if (listResult.error) {
      return { error: listResult.error }
    }

    const sandbox = listResult.data.sandboxes.find((item) => item.name === name)
    if (sandbox) {
      if (sandbox.metadata.referenced_by_agent) {
        return {
          error: {
            code: "ENVIRONMENT_REFERENCED",
            message: "Sandbox is referenced by one or more agents",
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

  const result = await deleteSandbox({
    client: getGatewayServerClient(),
    path: { sandboxName: name },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  redirect("/sandboxes")
}

export async function createSandboxFormAction(
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const parsed = createSandboxFormSchema.safeParse({
    name: formData.get("name"),
    ...sandboxFormValues(formData),
  })

  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Sandbox configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    }
  }

  const result = await createSandbox({
    client: getGatewayServerClient(),
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

  updateTag(sandboxesTag)
  redirect("/sandboxes")
}

export async function updateSandboxFormAction(
  name: string,
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const parsed = createSandboxFormSchema.omit({ name: true }).safeParse(sandboxFormValues(formData))

  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Sandbox configuration is invalid",
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    }
  }

  const result = await updateSandbox({
    client: getGatewayServerClient(),
    path: { sandboxName: name },
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
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  redirect("/sandboxes")
}
