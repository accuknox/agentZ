"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import {
  createEnvironment,
  deleteEnvironment,
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

export async function deleteEnvironmentFormAction(
  name: string,
  _: DeleteEnvironmentFormState,
  _formData: FormData
): Promise<DeleteEnvironmentFormState> {
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
  const rawName = formData.get("name")
  const rawPackages = formData.getAll("packages")

  const parsed = createEnvironmentFormSchema.safeParse({
    name: rawName,
    packages: rawPackages.map((p) => String(p)),
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
  const rawPackages = formData.getAll("packages")

  const parsed = createEnvironmentFormSchema.omit({ name: true }).safeParse({
    packages: rawPackages.map((p) => String(p)),
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

  const result = await updateEnvironment({
    body: { packages: parsed.data.packages },
    path: { name },
  })

  if (result.error) {
    return { error: result.error }
  }

  revalidateEnvironmentConsumers()
  redirect("/environments")
}
