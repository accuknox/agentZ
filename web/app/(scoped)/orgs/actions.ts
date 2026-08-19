"use server"

import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import type { Route } from "next"
import { revalidatePath, updateTag } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { agentsTag, inferenceProvidersTag, mcpsTag, sandboxesTag, skillsTag } from "@/data/cache"
import { getOrganizationSession, resolveOrganizationDestination } from "@/data/organizations"
import { deleteWorkspace, getDestructiveImpact } from "@/data/operations"
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  removeMembership,
  restoreMembership,
  saveMemberAssignments,
  saveSocialAdmission,
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
  type RoleImpact,
} from "@/data/roles"
import { deleteTeam, saveTeam, saveTeamRoles } from "@/data/teams"
import {
  provisionWorkspace,
  replaceWorkspaceInheritedResourceSelection,
  resolveWorkspaceDestination,
  retryWorkspaceProvisioning,
  updateWorkspaceName,
} from "@/data/workspaces"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"
import { zReplaceWorkspaceInheritedResourcesRequest } from "@/lib/gateway/client/zod.gen"
import type { InheritedResourceType } from "@/lib/gateway/client"
import {
  createOrganizationLogoUpload,
  deleteOrganizationLogo,
  deleteOrganizationLogoUpload,
  OrganizationAssetsError,
  publishOrganizationLogo,
} from "@/lib/organization-assets"

const organizationNameSchema = z
  .string()
  .min(1, "Enter an Organization name.")
  .max(100, "Use 100 characters or fewer.")
  .refine((name) => name.trim() === name, {
    message: "Remove leading or trailing spaces.",
  })
const organizationLogoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove") }),
  z.object({
    kind: z.literal("replace"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
])
const organizationNameInputSchema = z.object({
  name: organizationNameSchema,
})
const organizationLogoUploadSchema = z.object({
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
  organizationId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
type RoleFormInput = z.infer<typeof roleFormSchema>
const teamFormSchema = z.object({
  name: z
    .string()
    .min(1, "Enter a Team name.")
    .max(100, "Use 100 characters or fewer.")
    .refine((name) => name.trim() === name, "Remove leading or trailing spaces."),
  memberIds: z.array(z.string().min(1)).min(1, "Select at least one active Member.").max(1_000),
  roleIds: z.array(z.string().min(1)).max(1_000),
  updatedAt: z.string().optional(),
})
const invitationAccessSchema = z.object({
  roleIds: z.array(z.string().min(1)),
  teamIds: z.array(z.string().min(1)),
})
const memberAssignmentSchema = invitationAccessSchema.extend({
  previousRoleIds: z.array(z.string().min(1)),
  previousTeamIds: z.array(z.string().min(1)),
})
const socialAdmissionFormSchema = z
  .object({
    enabled: z.boolean(),
    githubEnabled: z.boolean(),
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
    googleEnabled: z.boolean(),
    roleIds: z.array(z.string().min(1)),
    teamIds: z.array(z.string().min(1)),
  })
  .superRefine((data, ctx) => {
    if (data.githubEnabled && data.githubOrganizations.length !== data.githubTeams.length) {
      ctx.addIssue({ code: "custom", message: "GitHub rules are incomplete." })
    }
    if (data.githubEnabled) {
      data.githubOrganizations.forEach((organization, index) => {
        if (organization) return
        ctx.addIssue({
          code: "custom",
          message: "Enter an Organization for every GitHub rule.",
          path: ["githubOrganizations", index],
        })
      })
    }
    if (data.enabled && data.roleIds.length + data.teamIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "Select at least one default Role or Team." })
    }
    if (data.enabled && !data.googleEnabled && !data.githubEnabled) {
      ctx.addIssue({ code: "custom", message: "Enable Google or GitHub." })
    }
    if (data.enabled && data.googleEnabled && data.googleDomains.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Add at least one Google email domain.",
        path: ["googleDomains"],
      })
    }
    if (data.enabled && data.githubEnabled && data.githubOrganizations.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Add at least one GitHub rule.",
        path: ["githubOrganizations"],
      })
    }
  })

export async function deleteWorkspaceAction(
  orgSlug: string,
  workspaceId: string,
  _state: { error?: string; fingerprint?: string },
  formData: FormData
) {
  const parsed = z
    .object({ confirmation: z.string(), fingerprint: z.string().length(64) })
    .safeParse({
      confirmation: formData.get("confirmation"),
      fingerprint: formData.get("fingerprint"),
    })
  if (!parsed.success) return { error: "Enter the Workspace name exactly as shown." }
  const result = await deleteWorkspace(
    orgSlug,
    workspaceId,
    parsed.data.confirmation,
    parsed.data.fingerprint
  )
  if ("error" in result) {
    if (result.error === "assignment-required") {
      return {
        error: `${result.members.join(", ")} must keep at least one direct Role or Team.`,
      }
    }
    if (result.error === "stale-preview") {
      const impact = await getDestructiveImpact(orgSlug, {
        operation: "workspace_delete",
        targetId: workspaceId,
        targetType: "workspace",
      })
      return {
        error: "The Workspace changed. Confirm the deletion again.",
        fingerprint: impact?.fingerprint,
      }
    }
    return { error: "The Workspace no longer meets the deletion requirements." }
  }
  revalidatePath(`/orgs/${orgSlug}/workspaces`)
  return { href: `/orgs/${orgSlug}/workspaces` as Route }
}

export async function prepareWorkspaceDeleteAction(orgSlug: string, workspaceId: string) {
  const impact = await getDestructiveImpact(orgSlug, {
    operation: "workspace_delete",
    targetId: workspaceId,
    targetType: "workspace",
  })
  if (!impact) return { error: "Workspace deletion is unavailable." }
  return {
    confirmation: impact.confirmation,
    fingerprint: impact.fingerprint,
    name: impact.targetLabel,
  }
}

export type OrganizationNameFormState = {
  name: string
  saved?: boolean
  errors?: {
    form?: string
    name?: string[]
  }
}

export type CreateWorkspaceFormState = {
  error?: string
  href?: Route
  errors?: {
    admin_member_ids?: string[]
    name?: string[]
  }
}

export type UpdateWorkspaceFormState = {
  error?: string
  saved?: boolean
}

export async function updateWorkspaceAction(
  orgSlug: string,
  workspaceId: string,
  _state: UpdateWorkspaceFormState,
  formData: FormData
): Promise<UpdateWorkspaceFormState> {
  const parsed = z
    .string()
    .trim()
    .min(1, "Enter a Workspace name.")
    .max(100, "Use 100 characters or fewer.")
    .safeParse(formData.get("name"))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message }

  const result = await updateWorkspaceName(orgSlug, workspaceId, parsed.data)
  if ("error" in result) {
    return {
      error:
        result.error === "not-found"
          ? "This Workspace no longer exists."
          : "You cannot edit this Workspace.",
    }
  }
  revalidatePath(`/orgs/${orgSlug}/workspaces`)
  revalidatePath(`/orgs/${orgSlug}/workspaces/manage`, "layout")
  revalidatePath(`/orgs/${orgSlug}/workspaces`, "layout")
  return { saved: true }
}

export type RoleFormState = {
  error?: string
  href?: Route
  errors?: { name?: string[] }
  preview?: {
    fingerprint: string
    input: string
    items: RoleImpact["items"]
    reduction: boolean
  }
}

function parseRoleForm(formData: FormData): { data: RoleFormInput } | { state: RoleFormState } {
  const grants = z.string().safeParse(formData.get("grants"))
  if (!grants.success) {
    return { state: { error: "The Permission Grant payload is invalid. Refresh and try again." } }
  }

  let payload: unknown
  try {
    payload = JSON.parse(grants.data)
  } catch {
    return { state: { error: "The Permission Grant payload is invalid. Refresh and try again." } }
  }

  const parsed = roleFormSchema.safeParse({
    name: formData.get("name"),
    grants: payload,
    updatedAt: formData.get("updated_at") || undefined,
  })
  if (!parsed.success) {
    return { state: { errors: { name: z.flattenError(parsed.error).fieldErrors.name } } }
  }

  return { data: parsed.data }
}

export type AssignmentFormState = { error?: string; saved?: boolean }

export type DeleteRoleFormState = { error?: string; href?: Route; references?: string[] }

export type TeamFormState = {
  error?: string
  href?: Route
  errors?: { name?: string[]; memberIds?: string[]; roleIds?: string[] }
}

export type InvitationFormState = { error?: string; link?: string }

export type SocialAdmissionFormState = { error?: string; saved?: boolean }

export async function resolveOrganizationDestinationAction(organizationId: string): Promise<Route> {
  return (await resolveOrganizationDestination(organizationId)) ?? "/settings/account"
}

export async function resolveWorkspaceDestinationAction(
  orgSlug: string,
  workspaceSlug: string
): Promise<Route> {
  return (await resolveWorkspaceDestination(orgSlug, workspaceSlug)) ?? "/settings/account"
}

export async function createInvitationAction(
  orgSlug: string,
  _state: InvitationFormState,
  formData: FormData
): Promise<InvitationFormState> {
  const parsed = invitationAccessSchema.safeParse({
    roleIds: formData.getAll("role_ids"),
    teamIds: formData.getAll("team_ids"),
  })
  if (!parsed.success || parsed.data.roleIds.length + parsed.data.teamIds.length === 0) {
    return { error: "Select at least one initial Role or Team." }
  }

  const result = await createInvitation(orgSlug, parsed.data)
  if ("error" in result) {
    return { error: "Invitation could not be created." }
  }

  revalidatePath(`/orgs/${orgSlug}/users/status/invited`, "page")
  return { link: `${getEnv().BETTER_AUTH_URL}/accept-invitation/${result.token}` }
}

export async function saveMemberAssignmentsAction(
  orgSlug: string,
  memberId: string,
  _state: AssignmentFormState,
  formData: FormData
): Promise<AssignmentFormState> {
  const parsed = memberAssignmentSchema.safeParse({
    previousRoleIds: formData.getAll("previous_role_ids"),
    previousTeamIds: formData.getAll("previous_team_ids"),
    roleIds: formData.getAll("role_ids"),
    teamIds: formData.getAll("team_ids"),
  })
  if (!parsed.success || parsed.data.roleIds.length + parsed.data.teamIds.length === 0) {
    return { error: "Select at least one direct Role or Team." }
  }

  const result = await saveMemberAssignments(orgSlug, memberId, parsed.data)
  if ("error" in result) {
    if (result.error === "assignment-required") {
      return { error: "Select at least one direct Role or Team." }
    }
    if (result.error === "final-superadmin") {
      return { error: "The final active Superadmin cannot be removed." }
    }
    if (result.error === "final-team-member") {
      return { error: `Add another active Member to ${result.teams.join(", ")} first.` }
    }
    if (result.error === "stale") {
      return { error: "Assignments changed while you were editing. Refresh and try again." }
    }
    return { error: "The Membership assignments could not be saved." }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  updateTag(`organization:${result.organizationId}:teams`)
  updateTag(`organization:${result.organizationId}:member:${result.memberId}:access`)
  updateTag(agentsTag)
  for (const roleId of result.roleIds) {
    updateTag(`organization:${result.organizationId}:role:${roleId}`)
  }
  for (const teamId of result.teamIds) {
    updateTag(`organization:${result.organizationId}:team:${teamId}`)
  }
  revalidatePath(`/orgs/${orgSlug}/users/${memberId}`)
  revalidatePath(`/orgs/${orgSlug}/users/status/active`, "page")
  revalidatePath(`/orgs/${orgSlug}/teams`)
  return { saved: true }
}

export async function cancelInvitationAction(orgSlug: string, invitationId: string) {
  const result = await cancelInvitation(orgSlug, invitationId)
  if ("error" in result) throw new Error("Invitation could not be cancelled.")
  revalidatePath(`/orgs/${orgSlug}/users/status/invited`, "page")
}

export async function restoreMembershipAction(orgSlug: string, memberId: string) {
  const result = await restoreMembership(orgSlug, memberId)
  if ("error" in result) {
    throw new Error(
      result.error === "assignment-required"
        ? "Assign at least one direct Role or Team before restoring this Membership."
        : "Membership could not be restored."
    )
  }

  revalidatePath(`/orgs/${orgSlug}/users/status/active`, "page")
  revalidatePath(`/orgs/${orgSlug}/users/status/disabled`, "page")
}

export async function removeMembershipAction(
  orgSlug: string,
  memberId: string,
  operation: "membership_disable" | "membership_remove",
  _state: { error?: string; fingerprint?: string },
  formData: FormData
) {
  const parsed = z
    .object({ confirmation: z.string(), fingerprint: z.string().length(64) })
    .safeParse({
      confirmation: formData.get("confirmation"),
      fingerprint: formData.get("fingerprint"),
    })
  if (!parsed.success) return { error: "Enter the Member name exactly as shown." }

  const result = await removeMembership(
    orgSlug,
    memberId,
    operation,
    parsed.data.confirmation,
    parsed.data.fingerprint
  )
  if ("error" in result) {
    if (result.error === "stale-preview") {
      const impact = await getDestructiveImpact(orgSlug, {
        operation,
        targetId: memberId,
        targetType: "organization_membership",
      })
      return {
        error: "The Membership changed. Review and confirm this action again.",
        fingerprint: impact?.fingerprint,
      }
    }
    if (result.error === "final-superadmin") {
      return { error: "The final active Superadmin cannot be disabled or removed." }
    }
    if (result.error === "final-team-member") {
      return { error: "Repair the affected Team membership before continuing." }
    }
    if (result.error === "self-removal") {
      return { error: "Administrators cannot remove their own Membership." }
    }
    return { error: "The Membership no longer satisfies this action." }
  }

  revalidatePath(`/orgs/${orgSlug}/users/status/active`, "page")
  revalidatePath(`/orgs/${orgSlug}/users/status/disabled`, "page")
  return { href: `/orgs/${orgSlug}/users/status/active` as Route }
}

export async function socialAdmissionAction(
  orgSlug: string,
  _state: SocialAdmissionFormState,
  formData: FormData
): Promise<SocialAdmissionFormState> {
  const parsed = socialAdmissionFormSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    githubEnabled: formData.get("github_enabled") === "on",
    githubOrganizations: formData.getAll("github_organization"),
    githubTeams: formData.getAll("github_team"),
    googleDomains: formData.getAll("google_domains"),
    googleEnabled: formData.get("google_enabled") === "on",
    roleIds: formData.getAll("role_ids"),
    teamIds: formData.getAll("team_ids"),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Social Admission is invalid." }
  }

  const result = await saveSocialAdmission(orgSlug, {
    enabled: parsed.data.enabled,
    githubEnabled: parsed.data.githubEnabled,
    githubRules: parsed.data.githubOrganizations.map((organization, index) => ({
      organization,
      team: parsed.data.githubTeams[index],
    })),
    googleDomains: parsed.data.googleDomains,
    googleEnabled: parsed.data.googleEnabled,
    roleIds: parsed.data.roleIds,
    teamIds: parsed.data.teamIds,
  })
  if ("error" in result) {
    switch (result.error) {
      case "default-access-required":
        return { error: "Select at least one default Role or Team." }
      case "provider-required":
        return { error: "Enable Google or GitHub." }
      case "google-rule-required":
        return { error: "Add at least one Google email domain." }
      case "github-rule-required":
        return { error: "Add at least one GitHub rule." }
      case "google-unavailable":
        return { error: "Google sign-in is not configured for this deployment." }
      case "github-unavailable":
        return { error: "GitHub sign-in is not configured for this deployment." }
      default:
        return { error: "Social Admission could not be saved." }
    }
  }

  revalidatePath(`/orgs/${orgSlug}/social-admission`, "page")
  return { saved: true }
}

export async function acceptInvitationAction(token: string): Promise<never> {
  const result = await acceptInvitation(token)
  if ("error" in result) {
    redirect(`/accept-invitation/${token}?error=${result.error}` as Route)
  }

  revalidatePath("/orgs", "layout")
  redirect(`/orgs/${result.slug}` as Route)
}

async function getEditableOrganization(organizationId: string) {
  const organizationSession = await getOrganizationSession()
  const organization = organizationSession?.organizations.find(
    (candidate) => candidate.id === organizationId
  )
  if (!organizationSession || !organization?.superadmin) {
    return
  }

  try {
    const permission = await getAuth().api.hasPermission({
      body: {
        organizationId: organization.id,
        permissions: { organization: ["update"] },
      },
      headers: organizationSession.requestHeaders,
    })
    if (!permission.success) {
      return
    }
    return { organization, organizationSession }
  } catch {
    return
  }
}

export async function createOrganizationLogoUploadAction(
  input: z.infer<typeof organizationLogoUploadSchema>
): Promise<{ error: string } | { headers: Record<string, string>; uploadUrl: string }> {
  const parsed = organizationLogoUploadSchema.safeParse(input)
  if (!parsed.success) {
    return { error: "The prepared image is invalid or too large." }
  }

  const editable = await getEditableOrganization(parsed.data.organizationId)
  if (!editable) {
    return { error: "You can no longer edit this Organization." }
  }
  const { organization, organizationSession } = editable

  try {
    return await createOrganizationLogoUpload(
      organization.id,
      organizationSession.session.user.id,
      parsed.data.byteLength,
      parsed.data.sha256
    )
  } catch {
    return { error: "The image upload could not be prepared. Try again." }
  }
}

export async function updateOrganizationLogoAction(
  organizationId: string,
  input: z.infer<typeof organizationLogoSchema>
): Promise<{ error: string } | { logo: string | null }> {
  const parsed = organizationLogoSchema.safeParse(input)
  if (!parsed.success) {
    return { error: "The profile image is invalid." }
  }

  const editable = await getEditableOrganization(organizationId)
  if (!editable) {
    return { error: "You can no longer edit this Organization." }
  }
  const { organization, organizationSession } = editable

  let logo: string | null
  if (parsed.data.kind === "replace") {
    try {
      logo = await publishOrganizationLogo(
        organization.id,
        organizationSession.session.user.id,
        parsed.data.sha256
      )
    } catch (error) {
      const message =
        error instanceof OrganizationAssetsError && error.code === "public-access-unavailable"
          ? "The image was uploaded, but it is not publicly accessible. Check the bucket policy."
          : "The uploaded image could not be verified. Choose it again and retry."
      return { error: message }
    } finally {
      try {
        await deleteOrganizationLogoUpload(organization.id, organizationSession.session.user.id)
      } catch {
        console.error("Organization profile staging cleanup failed", {
          actorId: organizationSession.session.user.id,
          organizationId: organization.id,
        })
      }
    }
  } else {
    logo = null
  }

  if (logo === organization.logo) {
    return { logo }
  }

  try {
    await getAuth().api.updateOrganization({
      body: { data: { logo }, organizationId: organization.id },
      headers: organizationSession.requestHeaders,
    })
  } catch {
    if (logo) {
      try {
        await deleteOrganizationLogo(logo)
      } catch {
        console.error("Unreferenced Organization profile image cleanup failed", {
          actorId: organizationSession.session.user.id,
          organizationId: organization.id,
        })
      }
    }
    return { error: "The Organization profile image could not be saved. Try again." }
  }

  try {
    await getDB()
      .insert(schema.eventTrailEvents)
      .values({
        id: `event-trail-${randomUUID()}`,
        organizationId: organization.id,
        actorType: "user",
        actorId: organizationSession.session.user.id,
        targetType: "organization",
        targetId: organization.id,
        category: "organization",
        action: "organization.logo.update",
        result: "succeeded",
      })
  } catch {
    console.error("Organization profile audit write failed", {
      action: "organization.logo.update",
      actorId: organizationSession.session.user.id,
      organizationId: organization.id,
    })
  }

  if (organization.logo) {
    try {
      const [current] = await getDB()
        .select({ logo: schema.organizations.logo })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organization.id))
      if (current?.logo === logo) {
        await deleteOrganizationLogo(organization.logo)
      }
    } catch {
      console.error("Previous Organization profile image cleanup failed", {
        actorId: organizationSession.session.user.id,
        organizationId: organization.id,
      })
    }
  }

  revalidatePath("/orgs", "layout")
  return { logo }
}

export async function updateOrganizationNameAction(
  organizationId: string,
  state: OrganizationNameFormState,
  input: z.infer<typeof organizationNameInputSchema>
): Promise<OrganizationNameFormState> {
  const parsed = organizationNameInputSchema.safeParse(input)
  if (!parsed.success) {
    const nameErrors = parsed.error.flatten().fieldErrors.name
    return {
      name: state.name,
      errors: { name: nameErrors },
    }
  }

  const editable = await getEditableOrganization(organizationId)
  if (!editable) {
    return {
      name: parsed.data.name,
      errors: { form: "You can no longer edit this Organization." },
    }
  }
  const { organization, organizationSession } = editable
  if (parsed.data.name === organization.name) {
    return { name: organization.name, saved: true }
  }

  try {
    await getAuth().api.updateOrganization({
      body: {
        organizationId: organization.id,
        data: { name: parsed.data.name },
      },
      headers: organizationSession.requestHeaders,
    })
  } catch {
    return {
      name: parsed.data.name,
      errors: { form: "The Organization name could not be saved. Try again." },
    }
  }

  try {
    await getDB()
      .insert(schema.eventTrailEvents)
      .values({
        id: `event-trail-${randomUUID()}`,
        organizationId: organization.id,
        actorType: "user",
        actorId: organizationSession.session.user.id,
        targetType: "organization",
        targetId: organization.id,
        category: "organization",
        action: "organization.rename",
        result: "succeeded",
        before: [{ field: "name", value: organization.name }],
        after: [{ field: "name", value: parsed.data.name }],
      })
  } catch {
    console.error("Organization profile audit write failed", {
      action: "organization.rename",
      actorId: organizationSession.session.user.id,
      organizationId: organization.id,
    })
  }

  revalidatePath("/orgs", "layout")
  return { name: parsed.data.name, saved: true }
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
  return { href: `/orgs/${orgSlug}/workspaces/${result.data.slug}` as Route }
}

export type WorkspaceInheritanceFormState = { error?: string; saved?: boolean }

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
  const resourceTag: Record<InheritedResourceType, string> = {
    inference_provider: inferenceProvidersTag,
    mcp_connection: mcpsTag,
    sandbox: sandboxesTag,
    skill: skillsTag,
  }
  updateTag(resourceTag[resourceType])
  revalidatePath(`/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}/inherited`, "layout")
  return { saved: true }
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
  const parsed = parseRoleForm(formData)
  if ("state" in parsed) return parsed.state

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
  updateTag(agentsTag)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  return { href: `/orgs/${orgSlug}/roles/${result.roleId}/permissions` as Route }
}

export async function assignOrganizationRoleUsersAction(
  orgSlug: string,
  roleId: string,
  _state: AssignmentFormState,
  formData: FormData
): Promise<AssignmentFormState> {
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
          : result.error === "assignment-required"
            ? `${result.members.join(", ")} must keep at least one direct Role or Team.`
            : "The Role assignments could not be saved.",
    }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  updateTag(`organization:${result.organizationId}:role:${roleId}`)
  updateTag(agentsTag)
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
  updateTag(agentsTag)
  revalidatePath(`/orgs/${orgSlug}/roles`)
  return { href: `/orgs/${orgSlug}/roles` as Route }
}

export async function workspaceRoleFormAction(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string | undefined,
  _state: RoleFormState,
  formData: FormData
): Promise<RoleFormState> {
  const parsed = parseRoleForm(formData)
  if ("state" in parsed) return parsed.state

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
  updateTag(agentsTag)
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`)
  return {
    href: `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles/${result.roleId}/permissions` as Route,
  }
}

export async function assignWorkspaceRoleUsersAction(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string,
  _state: AssignmentFormState,
  formData: FormData
): Promise<AssignmentFormState> {
  const parsed = z.array(z.string().min(1)).max(1_000).safeParse(formData.getAll("member_ids"))
  if (!parsed.success) {
    return { error: "The selected Users are invalid." }
  }
  const result = await assignWorkspaceRoleUsers(orgSlug, workspaceSlug, roleId, parsed.data)
  if ("error" in result) {
    return {
      error:
        result.error === "assignment-required"
          ? `${result.members.join(", ")} must keep at least one direct Role or Team.`
          : "The Workspace Role assignments could not be saved.",
    }
  }

  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:roles`)
  updateTag(`organization:${result.organizationId}:workspace:${result.workspaceId}:role:${roleId}`)
  updateTag(agentsTag)
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
  updateTag(agentsTag)
  revalidatePath(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`)
  return { href: `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles` as Route }
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

  const result = await saveTeam(orgSlug, teamId, parsed.data)
  if ("error" in result) {
    if (result.error === "name-taken") {
      return { errors: { name: ["A Team with this name already exists."] } }
    }
    if (result.error === "stale") {
      return { error: "This Team changed while you were editing. Refresh and try again." }
    }
    if (result.error === "final-superadmin") {
      return { error: "At least one active effective Superadmin is required." }
    }
    if (result.error === "invalid") {
      return { error: "Choose active Members and current Roles, then try again." }
    }
    if (result.error === "assignment-required") {
      return {
        error: `${result.members.join(", ")} must keep at least one direct Role or Team.`,
      }
    }
    return { error: "You no longer have permission to save this Team." }
  }

  updateTag(`organization:${result.organizationId}:teams`)
  updateTag(`organization:${result.organizationId}:team:${result.teamId}`)
  updateTag(agentsTag)
  for (const memberId of result.affectedMemberIds) {
    updateTag(`organization:${result.organizationId}:member:${memberId}:access`)
  }
  revalidatePath(`/orgs/${orgSlug}/teams`)
  return { href: `/orgs/${orgSlug}/teams/${result.teamId}` as Route }
}

export async function saveTeamRolesAction(
  orgSlug: string,
  teamId: string,
  _state: AssignmentFormState,
  formData: FormData
): Promise<AssignmentFormState> {
  const parsed = z
    .object({ roleIds: z.array(z.string().min(1)).max(1_000), updatedAt: z.string() })
    .safeParse({ roleIds: formData.getAll("role_ids"), updatedAt: formData.get("updated_at") })
  if (!parsed.success) return { error: "The selected Roles are invalid." }

  const result = await saveTeamRoles(orgSlug, teamId, parsed.data)
  if ("error" in result) {
    if (result.error === "stale") {
      return { error: "This Team changed while you were editing. Refresh and try again." }
    }
    if (result.error === "final-superadmin") {
      return { error: "At least one active effective Superadmin is required." }
    }
    return { error: "The Team Role assignments could not be saved." }
  }

  updateTag(`organization:${result.organizationId}:roles`)
  updateTag(`organization:${result.organizationId}:teams`)
  updateTag(`organization:${result.organizationId}:team:${result.teamId}`)
  updateTag(agentsTag)
  for (const roleId of result.roleIds) {
    updateTag(`organization:${result.organizationId}:role:${roleId}`)
  }
  for (const memberId of result.memberIds) {
    updateTag(`organization:${result.organizationId}:member:${memberId}:access`)
  }
  revalidatePath(`/orgs/${orgSlug}/teams/${teamId}/roles`)
  revalidatePath(`/orgs/${orgSlug}/teams`)
  return { saved: true }
}

export async function deleteTeamAction(
  orgSlug: string,
  teamId: string,
  _state: { error?: string; fingerprint?: string },
  formData: FormData
) {
  const parsed = z
    .object({ confirmation: z.string(), fingerprint: z.string().length(64) })
    .safeParse({
      confirmation: formData.get("confirmation"),
      fingerprint: formData.get("fingerprint"),
    })
  if (!parsed.success) return { error: "Enter the Team name exactly as shown." }
  const result = await deleteTeam(
    orgSlug,
    teamId,
    parsed.data.confirmation,
    parsed.data.fingerprint
  )
  if ("error" in result) {
    if (result.error === "assignment-required") {
      return {
        error: `${result.members.join(", ")} must keep at least one direct Role or Team.`,
      }
    }
    if (result.error === "stale-preview") {
      const impact = await getDestructiveImpact(orgSlug, {
        operation: "team_delete",
        targetId: teamId,
        targetType: "team",
      })
      return {
        error: "The Team changed. Confirm the deletion again.",
        fingerprint: impact?.fingerprint,
      }
    }
    if (result.error === "final-superadmin") {
      return { error: "At least one active effective Superadmin is required." }
    }
    return { error: "The Team no longer meets the deletion requirements." }
  }

  updateTag(`organization:${result.organizationId}:teams`)
  updateTag(agentsTag)
  for (const memberId of result.affectedMemberIds) {
    updateTag(`organization:${result.organizationId}:member:${memberId}:access`)
  }
  revalidatePath(`/orgs/${orgSlug}/teams`)
  return { href: `/orgs/${orgSlug}/teams` as Route }
}

export async function prepareTeamDeleteAction(orgSlug: string, teamId: string) {
  const impact = await getDestructiveImpact(orgSlug, {
    operation: "team_delete",
    targetId: teamId,
    targetType: "team",
  })
  if (!impact) return { error: "Team deletion is unavailable." }
  return {
    confirmation: impact.confirmation,
    fingerprint: impact.fingerprint,
    name: impact.targetLabel,
  }
}
