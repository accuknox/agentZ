"use server"

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
import {
  zMcpConnectionName,
  zResourceScope,
  zSandboxName,
  zSkillName,
} from "@/lib/gateway/client/zod.gen"
import { sandboxesTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type SandboxFormValues = Omit<z.input<typeof createSandboxFormSchema>, "name">
export type SandboxActionScope = {
  basePath: string
  workspaceId?: string
}

const inferenceRefPartSchema = z
  .string({ error: "Inference model reference must be text" })
  .trim()
  .min(1, "Inference model reference is required")

const sandboxFormDataSchema = z
  .object({
    packages: z.array(z.string({ error: "Package name must be text" }), {
      error: "Packages must be a list",
    }),
    allowedHosts: z.array(z.string({ error: "Allowed host must be text" }), {
      error: "Allowed hosts must be a list",
    }),
    mcpConnectionScopes: z.array(zResourceScope, {
      error: "MCP connection scopes must be a list",
    }),
    mcpConnectionNames: z.array(zMcpConnectionName, {
      error: "MCP connections must be a list",
    }),
    mcpToolScopes: z.array(zResourceScope, { error: "MCP tool scopes must be a list" }),
    mcpToolConnections: z.array(zMcpConnectionName, {
      error: "MCP tool connections must be a list",
    }),
    mcpToolNames: z.array(inferenceRefPartSchema, { error: "MCP tools must be a list" }),
    mcpConsentScopes: z.array(zResourceScope, {
      error: "MCP consent scopes must be a list",
    }),
    mcpConsentConnections: z.array(zMcpConnectionName, {
      error: "MCP consent connections must be a list",
    }),
    mcpConsentToolNames: z.array(inferenceRefPartSchema, {
      error: "MCP consent tools must be a list",
    }),
    skillScopes: z.array(zResourceScope, { error: "Skill scopes must be a list" }),
    skillNames: z.array(zSkillName, {
      error: "Skills must be a list",
    }),
    inferenceModelScopes: z.array(zResourceScope).min(1, "Select at least one model"),
    inferenceModelProviders: z.array(inferenceRefPartSchema).min(1, "Select at least one model"),
    inferenceModelIDs: z.array(inferenceRefPartSchema).min(1, "Select at least one model"),
    inferenceDefaultScope: zResourceScope,
    inferenceDefaultProvider: inferenceRefPartSchema,
    inferenceDefaultModel: inferenceRefPartSchema,
    inferenceSmallScope: zResourceScope.optional(),
    inferenceSmallProvider: inferenceRefPartSchema.optional(),
    inferenceSmallModel: inferenceRefPartSchema.optional(),
    inferenceAttachmentScope: zResourceScope.optional(),
    inferenceAttachmentProvider: inferenceRefPartSchema.optional(),
    inferenceAttachmentModel: inferenceRefPartSchema.optional(),
  })
  .transform((data, ctx): SandboxFormValues => {
    const inferenceModels: SandboxFormValues["inference"]["models"] = []
    for (const [index, scope] of data.inferenceModelScopes.entries()) {
      const provider = data.inferenceModelProviders[index]
      const model = data.inferenceModelIDs[index]
      if (!provider || !model) {
        ctx.addIssue({ code: "custom", message: "Inference model references are incomplete" })
        return z.NEVER
      }
      inferenceModels.push({ scope, provider, model })
    }
    if (
      inferenceModels.length !== data.inferenceModelProviders.length ||
      inferenceModels.length !== data.inferenceModelIDs.length
    ) {
      ctx.addIssue({ code: "custom", message: "Inference model references are incomplete" })
      return z.NEVER
    }
    const hasSmallModel =
      data.inferenceSmallScope !== undefined ||
      data.inferenceSmallProvider !== undefined ||
      data.inferenceSmallModel !== undefined
    if (
      hasSmallModel &&
      (!data.inferenceSmallScope || !data.inferenceSmallProvider || !data.inferenceSmallModel)
    ) {
      ctx.addIssue({ code: "custom", message: "Small model reference is incomplete" })
      return z.NEVER
    }
    const hasAttachmentModel =
      data.inferenceAttachmentScope !== undefined ||
      data.inferenceAttachmentProvider !== undefined ||
      data.inferenceAttachmentModel !== undefined
    if (
      hasAttachmentModel &&
      (!data.inferenceAttachmentScope ||
        !data.inferenceAttachmentProvider ||
        !data.inferenceAttachmentModel)
    ) {
      ctx.addIssue({ code: "custom", message: "Attachment model reference is incomplete" })
      return z.NEVER
    }
    const mcpConnectionRefs: SandboxFormValues["mcpConnectionRefs"] = []
    for (const [index, scope] of data.mcpConnectionScopes.entries()) {
      const name = data.mcpConnectionNames[index]
      if (!name) {
        ctx.addIssue({ code: "custom", message: "MCP connection references are incomplete" })
        return z.NEVER
      }
      mcpConnectionRefs.push({ scope, name, tools: [] })
    }
    if (mcpConnectionRefs.length !== data.mcpConnectionNames.length) {
      ctx.addIssue({ code: "custom", message: "MCP connection references are incomplete" })
      return z.NEVER
    }

    for (const [index, scope] of data.mcpToolScopes.entries()) {
      const name = data.mcpToolConnections[index]
      const tool = data.mcpToolNames[index]
      if (!name || !tool) {
        ctx.addIssue({ code: "custom", message: "MCP tool references are incomplete" })
        return z.NEVER
      }
      const connection = mcpConnectionRefs.find((ref) => ref.scope === scope && ref.name === name)
      if (!connection) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpTool"],
          message: "MCP tool references an unselected connection",
        })
        return z.NEVER
      }
      connection.tools.push({
        name: tool,
        requireConsent: data.mcpConsentScopes.some(
          (consentScope, consentIndex) =>
            consentScope === scope &&
            data.mcpConsentConnections[consentIndex] === name &&
            data.mcpConsentToolNames[consentIndex] === tool
        ),
      })
    }
    if (
      data.mcpToolScopes.length !== data.mcpToolConnections.length ||
      data.mcpToolScopes.length !== data.mcpToolNames.length ||
      data.mcpConsentScopes.length !== data.mcpConsentConnections.length ||
      data.mcpConsentScopes.length !== data.mcpConsentToolNames.length
    ) {
      ctx.addIssue({ code: "custom", message: "MCP tool references are incomplete" })
      return z.NEVER
    }

    const skills: SandboxFormValues["skills"] = []
    for (const [index, scope] of data.skillScopes.entries()) {
      const name = data.skillNames[index]
      if (!name) {
        ctx.addIssue({ code: "custom", message: "Skill references are incomplete" })
        return z.NEVER
      }
      skills.push({ scope, name })
    }
    if (skills.length !== data.skillNames.length) {
      ctx.addIssue({ code: "custom", message: "Skill references are incomplete" })
      return z.NEVER
    }

    return {
      packages: data.packages,
      allowedHosts: data.allowedHosts,
      mcpConnectionRefs,
      skills,
      inference: {
        models: inferenceModels,
        default_model: {
          scope: data.inferenceDefaultScope,
          provider: data.inferenceDefaultProvider,
          model: data.inferenceDefaultModel,
        },
        ...(data.inferenceSmallScope && data.inferenceSmallProvider && data.inferenceSmallModel
          ? {
              small_model: {
                scope: data.inferenceSmallScope,
                provider: data.inferenceSmallProvider,
                model: data.inferenceSmallModel,
              },
            }
          : {}),
        ...(data.inferenceAttachmentScope &&
        data.inferenceAttachmentProvider &&
        data.inferenceAttachmentModel
          ? {
              attachment_model: {
                scope: data.inferenceAttachmentScope,
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

function sandboxFormValues(formData: FormData) {
  return sandboxFormDataSchema.safeParse({
    packages: formData.getAll("packages"),
    allowedHosts: formData.getAll("allowedHosts"),
    mcpConnectionScopes: formData.getAll("mcpConnectionScopes"),
    mcpConnectionNames: formData.getAll("mcpConnectionNames"),
    mcpToolScopes: formData.getAll("mcpToolScopes"),
    mcpToolConnections: formData.getAll("mcpToolConnections"),
    mcpToolNames: formData.getAll("mcpToolNames"),
    mcpConsentScopes: formData.getAll("mcpConsentScopes"),
    mcpConsentConnections: formData.getAll("mcpConsentConnections"),
    mcpConsentToolNames: formData.getAll("mcpConsentToolNames"),
    skillScopes: formData.getAll("skillScopes"),
    skillNames: formData.getAll("skillNames"),
    inferenceModelScopes: formData.getAll("inferenceModelScopes"),
    inferenceModelProviders: formData.getAll("inferenceModelProviders"),
    inferenceModelIDs: formData.getAll("inferenceModelIDs"),
    inferenceDefaultScope: formData.get("inferenceDefaultScope"),
    inferenceDefaultProvider: formData.get("inferenceDefaultProvider"),
    inferenceDefaultModel: formData.get("inferenceDefaultModel"),
    inferenceSmallScope: formData.get("inferenceSmallScope") ?? undefined,
    inferenceSmallProvider: formData.get("inferenceSmallProvider") ?? undefined,
    inferenceSmallModel: formData.get("inferenceSmallModel") ?? undefined,
    inferenceAttachmentScope: formData.get("inferenceAttachmentScope") ?? undefined,
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
  return { success: true }
}

export async function createSandboxFormAction(
  scope: SandboxActionScope,
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
    client: getGatewayServerClient(scope.workspaceId),
    headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
    body: {
      name: parsed.data.name,
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
      mcp_connection_refs: parsed.data.mcpConnectionRefs.map(
        (ref): McpConnectionRef => ({
          scope: ref.scope,
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
      skills: parsed.data.skills,
      inference: parsed.data.inference,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  return { success: true }
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

  const values = sandboxFormValues(formData)
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
          scope: ref.scope,
          name: ref.name,
          tools: ref.tools.map((tool) => ({
            name: tool.name,
            require_consent: tool.requireConsent,
          })),
        })
      ),
      skills: parsed.data.skills,
      inference: parsed.data.inference,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  updateTag(sandboxesTag)
  updateTag(skillsTag)
  return { success: true }
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
