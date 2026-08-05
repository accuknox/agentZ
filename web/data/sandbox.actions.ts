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
import { zSandboxName } from "@/lib/gateway/client/zod.gen"
import { sandboxesTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type SandboxFormValues = Omit<z.input<typeof createSandboxFormSchema>, "name">
export type SandboxActionScope = {
  basePath: string
  workspaceId?: string
}

const mcpToolRefSchema = z.string({ error: "MCP tool must be text" }).transform((value, ctx) => {
  const [name, tool, extra] = value.split("\u0000")
  if (!name || !tool || extra !== undefined) {
    ctx.addIssue({ code: "custom", message: "MCP tool reference is invalid" })
    return z.NEVER
  }
  return { name, tool }
})

const inferenceRefPartSchema = z
  .string({ error: "Inference model reference must be text" })
  .trim()
  .min(1, "Inference model reference is required")

const sandboxFormDataSchema = z
  .object({
    scope: z.enum(["Organisation", "Workspace"]),
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
    inferenceModelProviders: z.array(inferenceRefPartSchema).min(1, "Select at least one model"),
    inferenceModelIDs: z.array(inferenceRefPartSchema).min(1, "Select at least one model"),
    inferenceDefaultProvider: inferenceRefPartSchema,
    inferenceDefaultModel: inferenceRefPartSchema,
    inferenceSmallProvider: inferenceRefPartSchema.optional(),
    inferenceSmallModel: inferenceRefPartSchema.optional(),
    inferenceAttachmentProvider: inferenceRefPartSchema.optional(),
    inferenceAttachmentModel: inferenceRefPartSchema.optional(),
  })
  .transform((data, ctx): SandboxFormValues => {
    const inferenceModels: SandboxFormValues["inference"]["models"] = []
    for (const [index, provider] of data.inferenceModelProviders.entries()) {
      const model = data.inferenceModelIDs[index]
      if (!model) {
        ctx.addIssue({ code: "custom", message: "Inference model references are incomplete" })
        return z.NEVER
      }
      inferenceModels.push({ scope: data.scope, provider, model })
    }
    if (inferenceModels.length !== data.inferenceModelIDs.length) {
      ctx.addIssue({ code: "custom", message: "Inference model references are incomplete" })
      return z.NEVER
    }
    if ((data.inferenceSmallProvider === undefined) !== (data.inferenceSmallModel === undefined)) {
      ctx.addIssue({ code: "custom", message: "Small model reference is incomplete" })
      return z.NEVER
    }
    if (
      (data.inferenceAttachmentProvider === undefined) !==
      (data.inferenceAttachmentModel === undefined)
    ) {
      ctx.addIssue({ code: "custom", message: "Attachment model reference is incomplete" })
      return z.NEVER
    }
    const refsByName = new Map<string, SandboxFormValues["mcpConnectionRefs"][number]>(
      data.mcpConnectionRefs.map((name) => [name, { name, tools: [] }])
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
      inference: {
        models: inferenceModels,
        default_model: {
          scope: data.scope,
          provider: data.inferenceDefaultProvider,
          model: data.inferenceDefaultModel,
        },
        ...(data.inferenceSmallProvider && data.inferenceSmallModel
          ? {
              small_model: {
                scope: data.scope,
                provider: data.inferenceSmallProvider,
                model: data.inferenceSmallModel,
              },
            }
          : {}),
        ...(data.inferenceAttachmentProvider && data.inferenceAttachmentModel
          ? {
              attachment_model: {
                scope: data.scope,
                provider: data.inferenceAttachmentProvider,
                model: data.inferenceAttachmentModel,
              },
            }
          : {}),
      },
    }
  })

export async function listSandboxesAction(
  query?: ListSandboxesData["query"],
  workspaceId?: string
): Promise<ListSandboxActionResponse> {
  const result = await listSandboxes({
    query,
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
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

function sandboxFormValues(formData: FormData, workspaceId?: string) {
  return sandboxFormDataSchema.safeParse({
    scope: workspaceId ? "Workspace" : "Organisation",
    packages: formData.getAll("packages"),
    allowedHosts: formData.getAll("allowedHosts"),
    mcpConnectionRefs: formData.getAll("mcpConnectionRefs"),
    mcpRequireConsentTool: formData.getAll("mcpRequireConsentTool"),
    mcpTool: formData.getAll("mcpTool"),
    skills: formData.getAll("skills"),
    inferenceModelProviders: formData.getAll("inferenceModelProviders"),
    inferenceModelIDs: formData.getAll("inferenceModelIDs"),
    inferenceDefaultProvider: formData.get("inferenceDefaultProvider"),
    inferenceDefaultModel: formData.get("inferenceDefaultModel"),
    inferenceSmallProvider: formData.get("inferenceSmallProvider") ?? undefined,
    inferenceSmallModel: formData.get("inferenceSmallModel") ?? undefined,
    inferenceAttachmentProvider: formData.get("inferenceAttachmentProvider") ?? undefined,
    inferenceAttachmentModel: formData.get("inferenceAttachmentModel") ?? undefined,
  })
}

export async function deleteSandboxFormAction(
  scope: SandboxActionScope,
  name: string,
  _: DeleteSandboxFormState,
  _formData: FormData
): Promise<DeleteSandboxFormState> {
  const sandboxName = zSandboxName.safeParse(name)
  if (!sandboxName.success) {
    return { error: { code: "INVALID_FORM", message: "Invalid sandbox name" } }
  }

  let pageToken = ""
  for (;;) {
    const listResult = await listSandboxes({
      client: getGatewayServerClient(scope.workspaceId),
      headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
      query: { limit: 200, page_token: pageToken || undefined },
    })
    if (listResult.error) {
      return { error: listResult.error }
    }

    const sandbox = listResult.data.sandboxes.find((item) => item.name === sandboxName.data)
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
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    path: { sandboxName: sandboxName.data },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  redirect(scope.basePath)
}

export async function createSandboxFormAction(
  scope: SandboxActionScope,
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const values = sandboxFormValues(formData, scope.workspaceId)
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
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    body: {
      name: parsed.data.name,
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
      mcp_connection_refs: parsed.data.mcpConnectionRefs.map(
        (ref): McpConnectionRef => ({
          scope: scope.workspaceId ? "Workspace" : "Organisation",
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
      skills: parsed.data.skills.map((name) => ({
        scope: scope.workspaceId ? "Workspace" : "Organisation",
        name,
      })),
      inference: parsed.data.inference,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  redirect(scope.basePath)
}

export async function updateSandboxFormAction(
  scope: SandboxActionScope,
  name: string,
  _: CreateSandboxFormState,
  formData: FormData
): Promise<CreateSandboxFormState> {
  const sandboxName = zSandboxName.safeParse(name)
  if (!sandboxName.success) {
    return invalidSandboxFormState(sandboxName.error)
  }

  const values = sandboxFormValues(formData, scope.workspaceId)
  if (!values.success) {
    return invalidSandboxFormState(values.error)
  }

  const parsed = createSandboxFormSchema.omit({ name: true }).safeParse(values.data)

  if (!parsed.success) {
    return invalidSandboxFormState(parsed.error)
  }

  const result = await updateSandbox({
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    path: { sandboxName: sandboxName.data },
    body: {
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
      mcp_connection_refs: parsed.data.mcpConnectionRefs.map(
        (ref): McpConnectionRef => ({
          scope: scope.workspaceId ? "Workspace" : "Organisation",
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
      skills: parsed.data.skills.map((name) => ({
        scope: scope.workspaceId ? "Workspace" : "Organisation",
        name,
      })),
      inference: parsed.data.inference,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  redirect(scope.basePath)
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
