import { createHash } from "node:crypto"
import { generateId } from "@better-auth/core/utils/id"
import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"

export const invitationExpiresIn = 48 * 60 * 60 * 1000
export const organizationMembershipLimit = 100

export function organizationInvitation() {
  return {
    id: "organization-invitation",
    endpoints: {
      acceptOrganizationInvitation: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({ token: z.string().length(32) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const session = ctx.context.session
          const tokenHash = createHash("sha256").update(ctx.body.token).digest("hex")

          return getDB().transaction(async (tx) => {
            const [candidate] = await tx
              .select({ organizationId: schema.organizationInvitations.organizationId })
              .from(schema.organizationInvitations)
              .where(eq(schema.organizationInvitations.tokenHash, tokenHash))
              .limit(1)
            if (!candidate) {
              return { kind: "unavailable" as const }
            }

            const [organization] = await tx
              .select({
                id: schema.organizations.id,
                slug: schema.organizations.slug,
              })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, candidate.organizationId))
              .limit(1)
              .for("update")
            if (!organization) {
              return { kind: "unavailable" as const }
            }

            const [invitation] = await tx
              .select()
              .from(schema.organizationInvitations)
              .where(eq(schema.organizationInvitations.tokenHash, tokenHash))
              .limit(1)
              .for("update")
            if (
              !invitation ||
              invitation.status !== "pending" ||
              invitation.expiresAt.getTime() <= Date.now()
            ) {
              return { kind: "unavailable" as const }
            }

            const [membership] = await tx
              .select({ disabledAt: schema.members.disabledAt })
              .from(schema.members)
              .where(
                and(
                  eq(schema.members.organizationId, organization.id),
                  eq(schema.members.userId, session.user.id)
                )
              )
              .limit(1)
            if (membership && !membership.disabledAt) {
              return { kind: "member" as const, slug: organization.slug }
            }
            if (membership) {
              return { kind: "disabled" as const }
            }

            const membershipCount = await tx.$count(
              schema.members,
              eq(schema.members.organizationId, organization.id)
            )
            if (membershipCount >= organizationMembershipLimit) {
              return { kind: "limit" as const }
            }

            const roles = await tx
              .select({
                id: schema.organizationRoles.id,
                role: schema.organizationRoles.role,
              })
              .from(schema.invitationRoles)
              .innerJoin(
                schema.organizationRoles,
                and(
                  eq(schema.organizationRoles.id, schema.invitationRoles.roleId),
                  eq(schema.organizationRoles.organizationId, schema.invitationRoles.organizationId)
                )
              )
              .where(
                and(
                  eq(schema.invitationRoles.invitationId, invitation.id),
                  eq(schema.invitationRoles.organizationId, organization.id)
                )
              )
            const teams = await tx
              .select({ id: schema.teams.id })
              .from(schema.invitationTeams)
              .innerJoin(
                schema.teams,
                and(
                  eq(schema.teams.id, schema.invitationTeams.teamId),
                  eq(schema.teams.organizationId, schema.invitationTeams.organizationId)
                )
              )
              .where(
                and(
                  eq(schema.invitationTeams.invitationId, invitation.id),
                  eq(schema.invitationTeams.organizationId, organization.id)
                )
              )
            if (roles.length + teams.length === 0) {
              await tx
                .update(schema.organizationInvitations)
                .set({ status: "canceled" })
                .where(eq(schema.organizationInvitations.id, invitation.id))
              return { kind: "unavailable" as const }
            }

            const now = new Date()
            const memberId = generateId()
            await tx.insert(schema.members).values({
              id: memberId,
              organizationId: organization.id,
              userId: session.user.id,
              role: roles.length ? roles.map(({ role }) => role).join(",") : "member",
              createdAt: now,
            })

            if (roles.length) {
              await tx.insert(schema.memberRoles).values(
                roles.map(({ id }) => ({
                  memberId,
                  organizationId: organization.id,
                  roleId: id,
                }))
              )
            }
            if (teams.length) {
              await tx.insert(schema.teamMembers).values(
                teams.map(({ id }) => ({
                  id: generateId(),
                  teamId: id,
                  userId: session.user.id,
                  createdAt: now,
                }))
              )
            }

            await tx
              .update(schema.sessions)
              .set({ activeOrganizationId: organization.id })
              .where(eq(schema.sessions.token, session.session.token))
            await tx
              .update(schema.organizationInvitations)
              .set({ acceptedAt: now, acceptedBy: session.user.id, status: "accepted" })
              .where(eq(schema.organizationInvitations.id, invitation.id))
            await tx.insert(schema.eventTrailEvents).values({
              action: "invitation.accept",
              actorId: session.user.id,
              actorType: "user",
              after: [{ field: "user_id", value: session.user.id }],
              category: "membership",
              id: `event-trail-${generateId()}`,
              organizationId: organization.id,
              result: "succeeded",
              targetId: invitation.id,
              targetType: "organization_membership",
            })

            return { kind: "accepted" as const, slug: organization.slug }
          })
        }
      ),
    },
    schema: {
      organizationInvitation: {
        fields: {
          organizationId: {
            type: "string",
            references: { model: "organization", field: "id" },
            index: true,
          },
          tokenHash: {
            type: "string",
            returned: false,
            unique: true,
          },
          status: {
            type: "string",
            defaultValue: "pending",
          },
          expiresAt: {
            type: "date",
          },
          inviterId: {
            type: "string",
            references: { model: "user", field: "id" },
          },
          acceptedBy: {
            type: "string",
            required: false,
            references: { model: "user", field: "id" },
          },
          acceptedAt: {
            type: "date",
            required: false,
          },
          createdAt: {
            type: "date",
            defaultValue: () => new Date(),
          },
        },
      },
    },
  } satisfies BetterAuthPlugin
}
