"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import {
  createEnvironment,
  deleteEnvironment,
  listAgents,
  listEnvironments,
  updateEnvironment,
  type ListEnvironmentsData,
} from "@/lib/gateway/client"
import { createEnvironmentFormSchema } from "@/data/schema"
import type {
  CreateEnvironmentFormState,
  DeleteEnvironmentFormState,
  ListEnvironmentActionResponse,
} from "@/data/types"

export async function listEnvironmentsAction(
  query?: ListEnvironmentsData["query"]
): Promise<ListEnvironmentActionResponse> {
  const result = await listEnvironments({ query, cache: "no-store" })
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

function revalidateEnvironmentConsumers() {
  revalidatePath("/environments")
  revalidatePath("/agent/new")
  revalidatePath("/agent/update/[id]", "page")
}

function environmentFormValues(formData: FormData) {
  return {
    packages: formData.getAll("packages").map((p) => String(p)),
    allowedHosts: formData.getAll("allowedHosts").map((h) => String(h)),
  }
}

export async function deleteEnvironmentFormAction(
  name: string,
  _: DeleteEnvironmentFormState,
  _formData: FormData
): Promise<DeleteEnvironmentFormState> {
  const agentsResult = await listAgents({ query: { limit: 200 } })
  if (agentsResult.error) {
    return { error: agentsResult.error }
  }
  const referencingAgent = agentsResult.data.agents.find(
    (agent) => agent.status !== "DELETED" && agent.configuration.environmentName === name
  )
  if (referencingAgent) {
    return {
      error: {
        code: "ENVIRONMENT_REFERENCED",
        message: `Environment is referenced by agent ${referencingAgent.name}`,
      },
    }
  }

  const result = await deleteEnvironment({ body: { name } })
  if (result.error) {
    return { error: result.error }
  }

  revalidateEnvironmentConsumers()
  return {}
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
    body: {
      name: parsed.data.name,
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
    },
  })

  if (result.error) {
    return { error: result.error }
  }

  revalidateEnvironmentConsumers()
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
    body: {
      packages: parsed.data.packages,
      allowed_hosts: parsed.data.allowedHosts,
    },
    path: { name },
  })

  if (result.error) {
    return { error: result.error }
  }

  revalidateEnvironmentConsumers()
  redirect("/environments")
}
