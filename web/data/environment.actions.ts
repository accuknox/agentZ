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
} from "@/lib/gateway/client"
import { createEnvironmentFormSchema } from "@/data/schema"
import type {
  CreateEnvironmentFormState,
  DeleteEnvironmentFormState,
  ListEnvironmentActionResponse,
} from "@/data/types"
import type * as z from "zod"
import { environmentsTag } from "@/data/cache"

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

function environmentFormValues(formData: FormData) {
  return {
    packages: formData.getAll("packages").map((p) => String(p)),
    allowedHosts: formData.getAll("allowedHosts").map((h) => String(h)),
    mcpConnectionRefs: [] as { name: string }[],
  }
}

function invalidEnvironmentForm(error: z.ZodError): CreateEnvironmentFormState {
  return {
    error: {
      code: "INVALID_FORM",
      message: "Environment configuration is invalid",
      errors: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    },
  }
}

function environmentPayload(data: { packages: string[]; allowedHosts: string[] }) {
  return {
    packages: data.packages,
    allowed_hosts: data.allowedHosts,
    mcp_connection_refs: [],
  }
}

async function finishEnvironmentMutation(error?: Error): Promise<CreateEnvironmentFormState> {
  if (error) {
    return { error }
  }

  updateTag(environmentsTag)
  redirect("/environments")
}

export async function deleteEnvironmentFormAction(
  name: string,
  _: DeleteEnvironmentFormState,
  _formData: FormData
): Promise<DeleteEnvironmentFormState> {
  let pageToken = ""
  for (;;) {
    const listResult = await listEnvironments({
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

  const result = await deleteEnvironment({ body: { name } })
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
    return invalidEnvironmentForm(parsed.error)
  }

  const result = await createEnvironment({
    body: {
      name: parsed.data.name,
      ...environmentPayload(parsed.data),
    },
  })

  return finishEnvironmentMutation(result.error)
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
    return invalidEnvironmentForm(parsed.error)
  }

  const result = await updateEnvironment({
    body: environmentPayload(parsed.data),
    path: { name },
  })

  return finishEnvironmentMutation(result.error)
}
