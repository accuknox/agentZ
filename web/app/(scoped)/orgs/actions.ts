"use server"

import type { Route } from "next"
import { revalidatePath, updateTag } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { renameOrganization, switchOrganization } from "@/data/organizations"
import { retryDestructiveOperation } from "@/data/operations"
import {
  applyInvitation,
  cancelInvitation,
  inviteMember,
  saveSocialAdmission,
  setMemberDisabled,
} from "@/data/members"
import {
  assignOrganizationRoleUsers,
  assignWorkspaceRoleUsers,
  deleteOrganizationRole,
  deleteWorkspaceRole,
  previewOrganizationRole,
  previewWorkspaceRole,
  saveOrganizationRole,
  saveWorkspaceRole,
} from "@/data/roles"
import { deleteTeam, previewTeamAccess, saveTeam } from "@/data/teams"
import {
  provisionWorkspace,
  replaceWorkspaceInheritedResourceSelection,
  retryWorkspaceProvisioning,
} from "@/data/workspaces"
import { schema } from "@/db"
import { getEnv } from "@/lib/env"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"
import { zReplaceWorkspaceInheritedResourcesRequest } from "@/lib/gateway/client/zod.gen"
import type { InheritedResourceType } from "@/lib/gateway/client"

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
const teamFormSchema = z.object({
  name: z
    .string()
    .min(1, "Enter a Team name.")
    .max(100, "Use 100 characters or fewer.")
    .refine((name) => name.trim() === name, "Remove leading or trailing spaces."),
  memberIds: z.array(z.string().min(1)).min(1, "Select at least one active Member.").max(1_000),
  roleIds: z.array(z.string().min(1)).min(1, "Select at least one Role.").max(1_000),
  updatedAt: z.string().optional(),
})
const socialAdmissionFormSchema = z
  .object({
    enabled: z.boolean(),
    githubOrganizations: z.array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
        .or(z.literal(""))
    ),
    githubTeams: z.array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .or(z.literal(""))
    ),
    googleDomains: z.array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)
    ),
    roleIds: z.array(z.string().min(1)),
    teamIds: z.array(z.string().min(1)),
  })
  .superRefine((data, ctx) => {
    if (data.githubOrganizations.length !== data.githubTeams.length) {
      ctx.addIssue({ code: "custom", message: "GitHub rules are incomplete." })
    }
    if (data.enabled && data.roleIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "Select at least one default Role." })
    }
  })

export async function retryDestructiveOperationAction(orgSlug: string, jobId: string) {
  const result = await retryDestructiveOperation(orgSlug, jobId)
  if (!("error" in result)) revalidatePath(`/orgs/${orgSlug}/destructive-operations`)
}

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

export type TeamFormState = {
  error?: string
  errors?: { name?: string[]; memberIds?: string[]; roleIds?: string[] }
  preview?: {
    fingerprint: string
    input: string
    rows: { id: string; label: string; detail: string }[]
  }
}

export type DeleteTeamFormState = { error?: string }

export type InviteMemberFormState = { error?: string; link?: string }

export type SocialAdmissionFormState = { error?: string }

export async function switchOrganizationAction(organizationId: string): Promise<never> {
  const destination = await switchOrganization(organizationId)
  redirect(destination ?? "/settings/account")
}

export async function inviteMemberAction(
  orgSlug: string,
  _state: InviteMemberFormState,
  formData: FormData
): Promise<InviteMemberFormState> {
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().pipe(z.email()),
      roleIds: z.array(z.string().min(1)),
      teamIds: z.array(z.string().min(1)),
    })
    .safeParse({
      email: formData.get("email"),
      roleIds: formData.getAll("role_ids"),
      teamIds: formData.getAll("team_ids"),
    })
  if (!parsed.success) {
    return { error: "Enter a valid email and select at least one Role or Team." }
  }
  if (parsed.data.roleIds.length + parsed.data.teamIds.length === 0) {
    return { error: "Select at least one initial Role or Team." }
  }

  const result = await inviteMember(orgSlug, parsed.data)
  if ("error" in result) {
    return {
      error:
        result.error === "already-member"
          ? "That email already belongs to an active Organisation Member."
          : "Invitation could not be created.",
    }
  }

  revalidatePath(`/orgs/${orgSlug}/users`, "page")
  return { link: `${getEnv().BETTER_AUTH_URL}/accept-invitation/${result.invitationId}` }
}

export async function cancelInvitationAction(orgSlug: string, invitationId: string) {
  await cancelInvitation(orgSlug, invitationId)
  revalidatePath(`/orgs/${orgSlug}/users`, "page")
}

export async function setMemberDisabledAction(
  orgSlug: string,
  memberId: string,
  disabled: boolean
) {
  const result = await setMemberDisabled(orgSlug, memberId, disabled)
  if ("error" in result) {
    throw new Error(
      result.error === "final-superadmin"
        ? "The final active Superadmin cannot be disabled."
        : "Membership state could not be changed."
    )
  }

  revalidatePath(`/orgs/${orgSlug}/users`, "page")
}

export async function socialAdmissionAction(
  orgSlug: string,
  _state: SocialAdmissionFormState,
  formData: FormData
): Promise<SocialAdmissionFormState> {
  const parsed = socialAdmissionFormSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    githubOrganizations: formData.getAll("github_organization"),
    githubTeams: formData.getAll("github_team"),
    googleDomains: formData.getAll("google_domains"),
    roleIds: formData.getAll("role_ids"),
    teamIds: formData.getAll("team_ids"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Social Admission is invalid." }
  }

  const result = await saveSocialAdmission(orgSlug, {
    enabled: parsed.data.enabled,
    githubRules: parsed.data.githubOrganizations.map((organization, index) => ({
      organization,
      team: parsed.data.githubTeams[index],
    })),
    googleDomains: parsed.data.googleDomains,
    roleIds: parsed.data.roleIds,
    teamIds: parsed.data.teamIds,
  })
  if ("error" in result) {
    return {
      error:
        result.error === "default-role-required"
          ? "Enable Social Admission only after selecting at least one default Role."
          : "Social Admission could not be saved.",
    }
  }

  revalidatePath(`/orgs/${orgSlug}/social-admission`, "page")
  return {}
}

export async function acceptInvitationAction(invitationId: string): Promise<never> {
  const result = await applyInvitation(invitationId)
  if ("error" in result) {
    redirect(`/accept-invitation/${invitationId}?error=${result.error}` as Route)
  }

  revalidatePath("/orgs", "layout")
  redirect(`/orgs/${result.slug}` as Route)
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
    selected_organization_resources: {
      skills: formData.getAll("inherited_skills"),
      sandboxes: formData.getAll("inherited_sandboxes"),
      mcp_connections: formData.getAll("inherited_mcp_connections"),
      inference_providers: formData.getAll("inherited_inference_providers"),
    },
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

export type WorkspaceInheritanceFormState = { error?: string }

export async function replaceWorkspaceInheritanceAction(
  orgSlug: string,
  workspaceSlug: string,
  resourceType: InheritedResourceType,
  _state: WorkspaceInheritanceFormState,
  formData: FormData
): Promise<WorkspaceInheritanceFormState> {
  const parsed = zReplaceWorkspaceInheritedResourcesRequest.safeParse({
    names: formData.getAll("names"),
  })
  if (!parsed.success) {
    return { error: "The resource selection is invalid. Refresh and try again." }
  }
  const result = await replaceWorkspaceInheritedResourceSelection(
    orgSlug,
    workspaceSlug,
    resourceType,
    parsed.data.names
  )
  if (!result) {
    return { error: "You no longer have permission to manage inherited resources." }
  }
  if (result.error) {
    return { error: result.error.message }
  }
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/settings/inherited`, "layout")
  return {}
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
  const grants = z.string().safeParse(formData.get("grants"))
  if (!grants.success) {
    return { error: "The Permission Grant payload is invalid. Refresh and try again." }
  }
  let rawGrants: unknown
  try {
    rawGrants = JSON.parse(grants.data)
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

  const previewFingerprint = z.string().safeParse(formData.get("preview_fingerprint"))
  if (!previewFingerprint.success) {
    return { error: "Review the access impact before saving this Role." }
  }
  const result = await saveOrganizationRole(orgSlug, roleId, {
    name: parsed.data.name,
    grants: parsed.data.grants,
    updatedAt: parsed.data.updatedAt,
    previewFingerprint: previewFingerprint.data,
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
      references: result.error === "referenced" ? result.references : undefined,
    }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  redirect(`/orgs/${orgSlug}/roles` as Route)
}

export async function workspaceRoleFormAction(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string | undefined,
  _state: RoleFormState,
  formData: FormData
): Promise<RoleFormState> {
  const grants = z.string().safeParse(formData.get("grants"))
  if (!grants.success) {
    return { error: "The Permission Grant payload is invalid. Refresh and try again." }
  }
  let rawGrants: unknown
  try {
    rawGrants = JSON.parse(grants.data)
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
      return { preview: { fingerprint: "", input: previewInput, items: [], reduction: false } }
    }
    const preview = await previewWorkspaceRole(
      orgSlug,
      workspaceSlug,
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

  const previewFingerprint = z.string().safeParse(formData.get("preview_fingerprint"))
  if (!previewFingerprint.success) {
    return { error: "Review the access impact before saving this Role." }
  }
  const result = await saveWorkspaceRole(orgSlug, workspaceSlug, roleId, {
    name: parsed.data.name,
    grants: parsed.data.grants,
    updatedAt: parsed.data.updatedAt,
    previewFingerprint: previewFingerprint.data,
  })
  if ("error" in result) {
    if (result.error === "name-taken") {
      return { errors: { name: ["A Role with this name already exists in this Workspace."] } }
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
    return { error: "You no longer have permission to save this Workspace Role." }
  }

  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:roles`)
  updateTag(
    `organization:${result.organizationId}:workspace:${result.workspaceId}:role:${result.roleId}`
  )
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`)
  redirect(
    `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles/${result.roleId}/permissions` as Route
  )
}

export async function assignWorkspaceRoleUsersAction(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string,
  _state: RoleAssignmentFormState,
  formData: FormData
): Promise<RoleAssignmentFormState> {
  const parsed = z.array(z.string().min(1)).max(1_000).safeParse(formData.getAll("member_ids"))
  if (!parsed.success) {
    return { error: "The selected Users are invalid." }
  }
  const result = await assignWorkspaceRoleUsers(orgSlug, workspaceSlug, roleId, parsed.data)
  if ("error" in result) {
    return { error: "The Workspace Role assignments could not be saved." }
  }

  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:roles`)
  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:role:${roleId}`)
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`)
  return { saved: true }
}

export async function deleteWorkspaceRoleAction(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string,
  _state: DeleteRoleFormState,
  _formData: FormData
): Promise<DeleteRoleFormState> {
  const result = await deleteWorkspaceRole(orgSlug, workspaceSlug, roleId)
  if ("error" in result) {
    return {
      error:
        result.error === "referenced"
          ? "Remove every Role reference before deleting it."
          : result.error === "immutable"
            ? "Built-in Roles cannot be deleted."
            : "The Workspace Role could not be deleted.",
      references: result.error === "referenced" ? result.references : undefined,
    }
  }

  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:roles`)
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`)
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles` as Route)
}

export async function teamFormAction(
  orgSlug: string,
  teamId: string | undefined,
  _state: TeamFormState,
  formData: FormData
): Promise<TeamFormState> {
  const parsed = teamFormSchema.safeParse({
    name: formData.get("name"),
    memberIds: formData.getAll("member_ids"),
    roleIds: formData.getAll("role_ids"),
    updatedAt: formData.get("updated_at") || undefined,
  })
  if (!parsed.success) {
    const fields = z.flattenError(parsed.error).fieldErrors
    return {
      errors: {
        name: fields.name,
        memberIds: fields.memberIds,
        roleIds: fields.roleIds,
      },
    }
  }

  if (formData.get("intent") === "preview") {
    const preview = await previewTeamAccess(orgSlug, parsed.data)
    if (!preview) {
      return { error: "The access review is unavailable. Refresh and try again." }
    }
    return {
      preview: {
        ...preview,
        input: JSON.stringify(parsed.data),
      },
    }
  }

  const previewFingerprint = z.string().safeParse(formData.get("preview_fingerprint"))
  if (!previewFingerprint.success) {
    return { error: "Review the derived access before saving this Team." }
  }
  const result = await saveTeam(orgSlug, teamId, {
    ...parsed.data,
    previewFingerprint: previewFingerprint.data,
  })
  if ("error" in result) {
    if (result.error === "name-taken") {
      return { errors: { name: ["A Team with this name already exists."] } }
    }
    if (result.error === "preview-required") {
      return { error: "Review the derived access before saving this Team." }
    }
    if (result.error === "stale") {
      return { error: "This Team changed while you were editing. Refresh and try again." }
    }
    if (result.error === "invalid") {
      return { error: "Choose active Members and current custom Roles, then review again." }
    }
    return { error: "You no longer have permission to save this Team." }
  }

  updateTag(`organization:${result.organizationId}:teams`)
  updateTag(`organization:${result.organizationId}:team:${result.teamId}`)
  for (const memberId of result.affectedMemberIds) {
    updateTag(`organization:${result.organizationId}:member:${memberId}:access`)
  }
  revalidatePath(`/orgs/${orgSlug}/teams`)
  redirect(`/orgs/${orgSlug}/teams/${result.teamId}` as Route)
}

export async function deleteTeamAction(
  orgSlug: string,
  teamId: string,
  _state: DeleteTeamFormState,
  _formData: FormData
): Promise<DeleteTeamFormState> {
  const result = await deleteTeam(orgSlug, teamId)
  if ("error" in result) {
    return { error: "The Team could not be deleted." }
  }

  updateTag(`organization:${result.organizationId}:teams`)
  for (const memberId of result.affectedMemberIds) {
    updateTag(`organization:${result.organizationId}:member:${memberId}:access`)
  }
  revalidatePath(`/orgs/${orgSlug}/teams`)
  redirect(`/orgs/${orgSlug}/teams` as Route)
}
