"use server"

import type { Route } from "next"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { renameOrganization, switchOrganization } from "@/data/organizations"

const renameOrganizationSchema = z.object({
  name: z
    .string()
    .min(1, "Enter an Organisation name.")
    .max(100, "Use 100 characters or fewer.")
    .refine((name) => name.trim() === name, {
      message: "Remove leading or trailing spaces.",
    }),
  slug: z
    .string()
    .min(3, "Use at least 3 characters.")
    .max(63, "Use 63 characters or fewer.")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens."),
})

export type RenameOrganizationFormState = {
  values: {
    name: string
    slug: string
  }
  errors?: {
    form?: string
    name?: string[]
    slug?: string[]
  }
}

export async function switchOrganizationAction(organizationId: string): Promise<never> {
  const destination = await switchOrganization(organizationId)
  redirect(destination ?? "/settings/account")
}

export async function renameOrganizationAction(
  organizationId: string,
  _state: RenameOrganizationFormState,
  formData: FormData
): Promise<RenameOrganizationFormState> {
  const values = {
    name: formData.get("name"),
    slug: formData.get("slug"),
  }
  const parsed = renameOrganizationSchema.safeParse(values)
  if (!parsed.success) {
    const fields = z.flattenError(parsed.error).fieldErrors
    return {
      values: _state.values,
      errors: {
        name: fields.name,
        slug: fields.slug,
      },
    }
  }

  const result = await renameOrganization(organizationId, parsed.data)
  if ("error" in result) {
    return {
      values: parsed.data,
      errors: {
        form:
          result.error === "slug-unavailable"
            ? "That slug is unavailable. Choose another."
            : "You no longer have permission to rename this Organisation.",
      },
    }
  }

  revalidatePath("/orgs", "layout")
  redirect(`/orgs/${result.slug}/general` as Route)
}
