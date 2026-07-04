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
import * as z from "zod"
import { sandboxesTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

const sandboxFormDataListsSchema = z.object({
  packages: z.array(z.string()),
  allowedHosts: z.array(z.string()),
  mcpConnectionRefs: z.array(z.string()),
  mcpRequireConsentTool: z.array(z.string()),
  mcpTool: z.array(z.string()),
})

type SandboxFormValues = Omit<z.input<typeof createSandboxFormSchema>, "name">

type SandboxFormValuesResult =
  | {
      data: SandboxFormValues
      error: undefined
    }
  | {
      data: undefined
      error: z.ZodError
    }

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

function sandboxFormValues(formData: FormData): SandboxFormValuesResult {
  const parsed = sandboxFormDataListsSchema.safeParse({
    packages: formData.getAll("packages"),
    allowedHosts: formData.getAll("allowedHosts"),
    mcpConnectionRefs: formData.getAll("mcpConnectionRefs"),
    mcpRequireConsentTool: formData.getAll("mcpRequireConsentTool"),
    mcpTool: formData.getAll("mcpTool"),
  })
  if (!parsed.success) {
    return { data: undefined, error: parsed.error }
  }

  const refsByName = new Map<
    string,
    {
      name: string
      tools: Array<{ name: string; requireConsent: boolean }>
    }
  >()
  for (const name of parsed.data.mcpConnectionRefs) {
    refsByName.set(name, {
      name,
      tools: [],
    })
  }
  const consentByTool = new Set(parsed.data.mcpRequireConsentTool)
  for (const value of parsed.data.mcpTool) {
    const [name, toolName] = value.split("\u0000")
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
    error: undefined,
    data: {
      packages: parsed.data.packages,
      allowedHosts: parsed.data.allowedHosts,
      mcpConnectionRefs: [...refsByName.values()].map((ref) => ({
        name: ref.name,
        tools: ref.tools,
      })),
    },
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
  const values = sandboxFormValues(formData)
  if (values.error) {
    return invalidSandboxFormState(values.error)
  }

  const parsed = createSandboxFormSchema.safeParse({
    ...Object.fromEntries(formData),
    ...values.data,
  })

  if (!parsed.success) {
    return invalidSandboxFormState(parsed.error)
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
  const values = sandboxFormValues(formData)
  if (values.error) {
    return invalidSandboxFormState(values.error)
  }

  const parsed = createSandboxFormSchema.omit({ name: true }).safeParse(values.data)

  if (!parsed.success) {
    return invalidSandboxFormState(parsed.error)
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

function invalidSandboxFormState(error: z.ZodError): CreateSandboxFormState {
  return {
    error: {
      code: "INVALID_FORM",
      message: "Sandbox configuration is invalid",
      errors: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    },
  }
}
