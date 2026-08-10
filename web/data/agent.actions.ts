"use server"

import * as z from "zod"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { updateTag } from "next/cache"
import {
  createAgent,
  deleteAgent,
  deleteAgentShare,
  transferAgentOwner,
  updateAgent,
  upsertAgentShare,
  type AgentShareCapability,
} from "@/lib/gateway/client"
import type { CreateAgentFormState, DeleteAgentFormState } from "@/data/types"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import { agentsTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type AgentActionScope = {
  basePath: string
  workspaceId?: string
}

export type AgentOwnerFormState = {
  error?: string
  success?: boolean
}

export type AgentShareFormState = {
  error?: string
  success?: boolean
}

const transferAgentOwnerFormSchema = z.object({
  owner_user_id: z.string().min(1, "Choose a new owner"),
})

const agentShareCapabilities = [
  "share_non_authored",
  "use_shared",
  "read_shared_secret",
  "write_shared_secret",
  "delete_shared_secret",
] as const satisfies readonly AgentShareCapability[]

const upsertAgentShareFormSchema = z
  .object({
    target_kind: z.enum(["user", "team"]),
    target_id: z.string().min(1, "Choose a share target"),
    capabilities: z.array(z.enum(agentShareCapabilities)).min(1, "Choose at least one capability"),
    acknowledge_use_shared: z.boolean(),
  })
  .refine((value) => value.acknowledge_use_shared, {
    message: "Acknowledge the control granted by Use Shared",
    path: ["acknowledge_use_shared"],
  })

const deleteAgentShareFormSchema = z.object({
  share_id: z.string().min(1, "Choose a share"),
})

export async function createAgentFormAction(
  scope: AgentActionScope,
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = createAgentSimpleFormSchema.safeParse({
    ...Object.fromEntries(formData),
    skills: formData.getAll("skills"),
    memoryEnabled: formData.has("memoryEnabled"),
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
  }

  const result = await createAgent({
    body: {
      name: parsed.data.name,
      sandbox: { scope: parsed.data.sandboxScope, name: parsed.data.sandboxName },
      skills: parsed.data.skills.map((name) => ({ scope: "Organisation", name })),
      memory: { enabled: parsed.data.memoryEnabled },
    },
    client: getGatewayServerClient(scope.workspaceId),
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  updateTag(skillsTag)
  redirect(scope.basePath as Route)
}

export async function updateAgentFormAction(
  scope: AgentActionScope,
  agentName: string,
  _: CreateAgentFormState,
  formData: FormData
): Promise<CreateAgentFormState> {
  const parsed = updateAgentSimpleFormSchema.safeParse({
    ...Object.fromEntries(formData),
    skills: formData.getAll("skills"),
    memoryEnabled: formData.has("memoryEnabled"),
  })
  if (!parsed.success) {
    return invalidAgentFormState(parsed.error)
  }

  const result = await updateAgent({
    body: {
      sandbox: { scope: parsed.data.sandboxScope, name: parsed.data.sandboxName },
      skills: parsed.data.skills.map((name) => ({ scope: "Organisation", name })),
      memory: { enabled: parsed.data.memoryEnabled },
    },
    client: getGatewayServerClient(scope.workspaceId),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  updateTag(skillsTag)
  redirect(scope.basePath as Route)
}

function invalidAgentFormState(error: z.ZodError): CreateAgentFormState {
  const { formErrors } = error.flatten()
  const errors = error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }))

  return {
    error: {
      code: "INVALID_FORM",
      message: formErrors[0] ?? "Agent configuration is invalid",
      errors: errors.length > 0 ? errors : undefined,
    },
  }
}

export async function deleteAgentFormAction(
  scope: AgentActionScope,
  agentName: string,
  _: DeleteAgentFormState,
  _formData: FormData
): Promise<DeleteAgentFormState> {
  const result = await deleteAgent({
    client: getGatewayServerClient(scope.workspaceId),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error }
  }

  updateTag(agentsTag)
  updateTag(skillsTag)
  redirect(scope.basePath as Route)
}

export async function transferAgentOwnerFormAction(
  scope: AgentActionScope,
  agentName: string,
  _: AgentOwnerFormState,
  formData: FormData
): Promise<AgentOwnerFormState> {
  const parsed = transferAgentOwnerFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid owner" }
  }

  const result = await transferAgentOwner({
    body: { owner_user_id: parsed.data.owner_user_id },
    client: getGatewayServerClient(scope.workspaceId),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error.message }
  }

  refreshAgentRoutes(scope, agentName)
  return { success: true }
}

export async function upsertAgentShareFormAction(
  scope: AgentActionScope,
  agentName: string,
  _: AgentShareFormState,
  formData: FormData
): Promise<AgentShareFormState> {
  const parsed = upsertAgentShareFormSchema.safeParse({
    ...Object.fromEntries(formData),
    capabilities: formData.getAll("capabilities"),
    acknowledge_use_shared: formData.has("acknowledge_use_shared"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid share" }
  }

  const result = await upsertAgentShare({
    body: {
      capabilities: parsed.data.capabilities,
      ...(parsed.data.target_kind === "user"
        ? { target_user_id: parsed.data.target_id }
        : { target_team_id: parsed.data.target_id }),
    },
    client: getGatewayServerClient(scope.workspaceId),
    path: { agentName },
  })
  if (result.error) {
    return { error: result.error.message }
  }

  refreshAgentRoutes(scope, agentName)
  return { success: true }
}

export async function deleteAgentShareFormAction(
  scope: AgentActionScope,
  agentName: string,
  _: AgentShareFormState,
  formData: FormData
): Promise<AgentShareFormState> {
  const parsed = deleteAgentShareFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid share" }
  }

  const result = await deleteAgentShare({
    client: getGatewayServerClient(scope.workspaceId),
    path: { agentName, shareId: parsed.data.share_id },
  })
  if (result.error) {
    return { error: result.error.message }
  }

  refreshAgentRoutes(scope, agentName)
  return { success: true }
}

function refreshAgentRoutes(scope: AgentActionScope, agentName: string) {
  updateTag(agentsTag)
  if (scope.workspaceId) {
    updateTag(`${agentsTag}:${scope.workspaceId}`)
    updateTag(`${agentsTag}:${scope.workspaceId}:${agentName}`)
  }
  revalidatePath(scope.basePath as Route)
  revalidatePath(`${scope.basePath}/${agentName}` as Route)
}
