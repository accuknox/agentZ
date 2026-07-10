"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import {
  createSandbox,
  deleteSandbox,
  listSandboxes,
  updateSandbox,
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
import { sandboxesTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type SandboxFormValues = Omit<z.input<typeof createSandboxFormSchema>, "name">

const mcpToolRefSchema = z.string({ error: "MCP tool must be text" }).transform((value, ctx) => {
  const [name, tool, extra] = value.split("\u0000")
  if (!name || !tool || extra !== undefined) {
    ctx.addIssue({ code: "custom", message: "MCP tool reference is invalid" })
    return z.NEVER
  }
  return { name, tool }
})

const sandboxFormDataSchema = z
  .object({
    packages: z.array(z.string({ error: "Package name must be text" }), {
      error: "Packages must be a list",
    }),
    allowedHosts: z.array(z.string({ error: "Allowed host must be text" }), {
      error: "Allowed hosts must be a list",
    }),
    mcpConnectionRefs: z.array(z.string({ error: "MCP connection name must be text" }), {
      error: "MCP connections must be a list",
    }),
    mcpRequireConsentTool: z.array(mcpToolRefSchema, {
      error: "MCP consent tools must be a list",
    }),
    mcpTool: z.array(mcpToolRefSchema, {
      error: "MCP tools must be a list",
    }),
    skills: z.array(z.string({ error: "Skill name must be text" }), {
      error: "Skills must be a list",
    }),
  })
  .transform((data, ctx): SandboxFormValues => {
    const refsByName = new Map(
      data.mcpConnectionRefs.map((name) => [
        name,
        { name, tools: [] as SandboxFormValues["mcpConnectionRefs"][number]["tools"] },
      ])
    )
    const consentByTool = new Set(
      data.mcpRequireConsentTool.map((ref) => `${ref.name}\u0000${ref.tool}`)
    )

    for (const ref of data.mcpTool) {
      const connection = refsByName.get(ref.name)
      if (!connection) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpTool"],
          message: "MCP tool references an unselected connection",
        })
        return z.NEVER
      }
      connection.tools.push({
        name: ref.tool,
        requireConsent: consentByTool.has(`${ref.name}\u0000${ref.tool}`),
      })
    }

    return {
      packages: data.packages,
      allowedHosts: data.allowedHosts,
      mcpConnectionRefs: [...refsByName.values()],
      skills: data.skills,
    }
  })

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
  return sandboxFormDataSchema.safeParse({
    packages: formData.getAll("packages"),
    allowedHosts: formData.getAll("allowedHosts"),
    mcpConnectionRefs: formData.getAll("mcpConnectionRefs"),
    mcpRequireConsentTool: formData.getAll("mcpRequireConsentTool"),
    mcpTool: formData.getAll("mcpTool"),
    skills: formData.getAll("skills"),
  })
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
  updateTag(skillsTag)
  redirect("/sandboxes")
}

export async function createSandboxFormAction(
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const values = sandboxFormValues(formData)
  if (!values.success) {
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
      skills: parsed.data.skills,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  redirect("/sandboxes")
}

export async function updateSandboxFormAction(
  name: string,
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const values = sandboxFormValues(formData)
  if (!values.success) {
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
      skills: parsed.data.skills,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
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
