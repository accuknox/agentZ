"use server"

import type { Route } from "next"
import { revalidatePath, updateTag } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { renameOrganization, switchOrganization } from "@/data/organizations"
import {
  assignOrganizationRoleUsers,
  deleteOrganizationRole,
  previewOrganizationRole,
  saveOrganizationRole,
} from "@/data/roles"
import { provisionWorkspace, retryWorkspaceProvisioning } from "@/data/workspaces"
import { schema } from "@/db"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"

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
const roleGrantSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
  resource: z.enum(schema.permissionResource.enumValues),
  action: z.enum(schema.permissionAction.enumValues),
})
const roleFormSchema = z.object({
  name: z
    .string()
    .min(1, "Enter a Role name.")
    .max(80, "Use 80 characters or fewer.")
    .refine((name) => name.trim() === name, "Remove leading or trailing spaces."),
  grants: z.array(roleGrantSchema).max(1_000, "This Role has too many Permission Grants."),
  updatedAt: z.string().optional(),
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

export type CreateWorkspaceFormState = {
  error?: string
  errors?: {
    admin_member_ids?: string[]
    name?: string[]
  }
}

export type RoleFormState = {
  error?: string
  errors?: { name?: string[] }
  preview?: {
    fingerprint: string
    input: string
    items: { id: string; label: string; detail?: string }[]
    reduction: boolean
  }
}

export type RoleAssignmentFormState = { error?: string; saved?: boolean }

export type DeleteRoleFormState = { error?: string; references?: string[] }

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

export async function createWorkspaceAction(
  orgSlug: string,
  _state: CreateWorkspaceFormState,
  formData: FormData
): Promise<CreateWorkspaceFormState> {
  const parsed = zCreateWorkspaceRequest.safeParse({
    admin_member_ids: formData.getAll("admin_member_ids"),
    name: formData.get("name"),
  })
  if (!parsed.success) {
    const fields = z.flattenError(parsed.error).fieldErrors
    return {
      errors: {
        admin_member_ids: fields.admin_member_ids,
        name: fields.name,
      },
    }
  }

  const result = await provisionWorkspace(orgSlug, parsed.data)
  if (!result) {
    return { error: "You no longer have permission to create a Workspace." }
  }
  if (result.error) {
    return { error: result.error.message }
  }

  revalidatePath(`/orgs/${orgSlug}`, "layout")
  redirect(`/orgs/${orgSlug}/workspaces/${result.data.slug}` as Route)
}

export async function retryWorkspaceAction(orgSlug: string, workspaceId: string): Promise<void> {
  const result = await retryWorkspaceProvisioning(orgSlug, workspaceId)
  if (!result) {
    throw new Error("You no longer have permission to retry this Workspace.")
  }
  if (result.error) {
    throw new Error(result.error.message)
  }

  revalidatePath(`/orgs/${orgSlug}`, "layout")
}

export async function organizationRoleFormAction(
  orgSlug: string,
  roleId: string | undefined,
  _state: RoleFormState,
  formData: FormData
): Promise<RoleFormState> {
  let rawGrants: unknown
  try {
    rawGrants = JSON.parse(String(formData.get("grants") ?? "[]"))
  } catch {
    return { error: "The Permission Grant payload is invalid. Refresh and try again." }
  }

  const parsed = roleFormSchema.safeParse({
    name: formData.get("name"),
    grants: rawGrants,
    updatedAt: formData.get("updated_at") || undefined,
  })
  if (!parsed.success) {
    return { errors: { name: z.flattenError(parsed.error).fieldErrors.name } }
  }

  if (formData.get("intent") === "preview") {
    const previewInput = JSON.stringify(parsed.data)
    if (!roleId || !parsed.data.updatedAt) {
      return {
        preview: { fingerprint: "", input: previewInput, items: [], reduction: false },
      }
    }
    const preview = await previewOrganizationRole(
      orgSlug,
      roleId,
      parsed.data.name,
      parsed.data.grants,
      parsed.data.updatedAt
    )
    if ("error" in preview) {
      return {
        error:
          preview.error === "stale"
            ? "This Role changed while you were editing. Refresh before reviewing impact."
            : "The impact preview is unavailable. Refresh and try again.",
      }
    }
    return {
      preview: {
        fingerprint: preview.fingerprint,
        input: previewInput,
        items: preview.items,
        reduction: preview.reduction,
      },
    }
  }

  const result = await saveOrganizationRole(orgSlug, roleId, {
    name: parsed.data.name,
    grants: parsed.data.grants,
    updatedAt: parsed.data.updatedAt,
    previewFingerprint: String(formData.get("preview_fingerprint") ?? ""),
  })
  if ("error" in result) {
    if (result.error === "name-taken") {
      return { errors: { name: ["A Role with this name already exists."] } }
    }
    if (result.error === "preview-required") {
      return { error: "Review the access impact before saving this reduction." }
    }
    if (result.error === "stale") {
      return { error: "This Role changed while you were editing. Refresh and try again." }
    }
    if (result.error === "immutable") {
      return { error: "Built-in Roles are read-only." }
    }
    return { error: "You no longer have permission to save this Role." }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  updateTag(`organization:${result.organizationId}:role:${result.roleId}`)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  redirect(`/orgs/${orgSlug}/roles/${result.roleId}/permissions` as Route)
}

export async function assignOrganizationRoleUsersAction(
  orgSlug: string,
  roleId: string,
  _state: RoleAssignmentFormState,
  formData: FormData
): Promise<RoleAssignmentFormState> {
  const parsed = z.array(z.string().min(1)).max(1_000).safeParse(formData.getAll("member_ids"))
  if (!parsed.success) {
    return { error: "The selected Users are invalid." }
  }
  const result = await assignOrganizationRoleUsers(orgSlug, roleId, parsed.data)
  if ("error" in result) {
    return {
      error:
        result.error === "final-superadmin"
          ? "At least one active Superadmin is required."
          : "The Role assignments could not be saved.",
    }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  updateTag(`organization:${result.organizationId}:role:${roleId}`)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  return { saved: true }
}

export async function deleteOrganizationRoleAction(
  orgSlug: string,
  roleId: string,
  _state: DeleteRoleFormState,
  _formData: FormData
): Promise<DeleteRoleFormState> {
  const result = await deleteOrganizationRole(orgSlug, roleId)
  if ("error" in result) {
    return {
      error:
        result.error === "referenced"
          ? "Remove every Role reference before deleting it."
          : result.error === "immutable"
            ? "Built-in Roles cannot be deleted."
            : "The Role could not be deleted.",
      references: result.references,
    }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  redirect(`/orgs/${orgSlug}/roles` as Route)
}
