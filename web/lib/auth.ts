import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { betterAuth } from "better-auth"
import { createAuthMiddleware, getOAuthState } from "better-auth/api"
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error"
import { nextCookies } from "better-auth/next-js"
import { deleteSessionCookie, expireCookie } from "better-auth/cookies"
import { apiKey } from "@better-auth/api-key"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { jwt } from "better-auth/plugins/jwt"
import { organization } from "better-auth/plugins/organization"
import { createAccessControl } from "better-auth/plugins/access"
import { defaultStatements } from "better-auth/plugins/organization/access"
import { twoFactor } from "better-auth/plugins/two-factor"
import { z } from "zod"
import { authErrorMessages } from "@/app/(auth)/shared"
import { getDB, schema } from "@/db"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"
import { getEnv } from "@/lib/env"
import { getGithubUserInfo, socialOAuthStateSchema } from "@/lib/github-membership"
import { getGoogleUserInfo } from "@/lib/google-membership"
import {
  createOrganizationMembership,
  organizationInvitation,
  organizationMembershipLimit,
} from "@/lib/organization-invitation"
import { minPasswordLength } from "@/lib/password-policy"
import { signInReturnTo } from "@/lib/sign-in-redirect"

// Better Auth uses these internal cookie names for 2FA challenge state and
// trusted-device bypass. The plugin does not export them publicly, so the
// callback hook uses the same stable names to keep OAuth and credential 2FA
// behavior aligned.
const twoFactorCookieName = "two_factor"
const trustDeviceCookieName = "trust_device"
const defaultTwoFactorCookieMaxAge = 10 * 60
const defaultTrustDeviceMaxAge = 30 * 24 * 60 * 60
const credentialEmailSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
})
const organizationAccessControl = createAccessControl(defaultStatements)
const superadminRole = organizationAccessControl.newRole(defaultStatements)
const memberRole = organizationAccessControl.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: [],
})

const disabledAuthPaths = [
  // Workspace capabilities and typed targets govern durable credentials.
  // Native API-key management cannot enforce that scope.
  "/api-key/create",
  "/api-key/delete",
  "/api-key/get",
  "/api-key/list",
  "/api-key/update",
  "/api-key/verify",
  // Gateway JWTs must go through currentGatewayAuthToken(), which verifies the
  // active, enabled Organisation before minting a bearer token.
  "/token",
  // OAuth initiation carries governed enrolment intent through signed state.
  // Provider callbacks remain public because the upstream provider needs them.
  "/sign-in/social",
  // Organisation state is governed and reconciled server-side. Native public
  // endpoints cannot enforce AgentZ scope, built-in Role, or cascade rules.
  "/organization/add-team-member",
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/organization/check-slug",
  "/organization/create",
  "/organization/create-role",
  "/organization/create-team",
  "/organization/delete",
  "/organization/delete-role",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/get-role",
  "/organization/has-permission",
  "/organization/invite-member",
  "/organization/leave",
  "/organization/list",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/list-roles",
  "/organization/list-team-members",
  "/organization/list-teams",
  "/organization/list-user-teams",
  "/organization/list-user-invitations",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/remove-team",
  "/organization/remove-team-member",
  "/organization/set-active-team",
  "/organization/set-active",
  "/organization/update",
  "/organization/update-member-role",
  "/organization/update-role",
  "/organization/update-team",
  // Backup codes are issued once during enrollment and cannot be rotated later
  // through account settings or direct client calls.
  "/two-factor/generate-backup-codes",
]

async function listActiveSuperadmins(organizationId: string) {
  return getDB()
    .selectDistinct({ memberId: schema.members.id })
    .from(schema.memberRoleAssignments)
    .innerJoin(
      schema.members,
      and(
        eq(schema.memberRoleAssignments.memberId, schema.members.id),
        eq(schema.memberRoleAssignments.organizationId, schema.members.organizationId)
      )
    )
    .innerJoin(
      schema.roleScopes,
      and(
        eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
        eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
      )
    )
    .where(
      and(
        eq(schema.members.organizationId, organizationId),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.systemRole, "superadmin")
      )
    )
}

type AuthDatabase = Pick<ReturnType<typeof getDB>, "selectDistinct" | "update">

export async function projectMemberRoleTransports(
  db: AuthDatabase,
  organizationId: string,
  memberIds: string[]
) {
  if (!memberIds.length) return

  const rows = await db
    .selectDistinct({
      memberId: schema.memberRoleAssignments.memberId,
      role: schema.organizationRoles.role,
    })
    .from(schema.memberRoleAssignments)
    .innerJoin(
      schema.organizationRoles,
      and(
        eq(schema.organizationRoles.id, schema.memberRoleAssignments.roleId),
        eq(schema.organizationRoles.organizationId, schema.memberRoleAssignments.organizationId)
      )
    )
    .where(
      and(
        eq(schema.memberRoleAssignments.organizationId, organizationId),
        inArray(schema.memberRoleAssignments.memberId, memberIds)
      )
    )
  const roles = Map.groupBy(rows, ({ memberId }) => memberId)
  await Promise.all(
    memberIds.map((memberId) =>
      db
        .update(schema.members)
        .set({
          role:
            roles
              .get(memberId)
              ?.map(({ role }) => role)
              .sort()
              .join(",") || "member",
        })
        .where(
          and(eq(schema.members.id, memberId), eq(schema.members.organizationId, organizationId))
        )
    )
  )
}

function buildAuth() {
  const env = getEnv()

  return betterAuth({
    appName: "AgentZ",
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    disabledPaths: disabledAuthPaths,
    database: drizzleAdapter(getDB(), {
      provider: "pg",
      usePlural: true,
      schema,
    }),
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const db = getDB()
            const [lastContext] = await db
              .select({ organizationId: schema.lastAccessibleContexts.organizationId })
              .from(schema.lastAccessibleContexts)
              .innerJoin(
                schema.members,
                and(
                  eq(schema.members.organizationId, schema.lastAccessibleContexts.organizationId),
                  eq(schema.members.userId, session.userId),
                  isNull(schema.members.disabledAt)
                )
              )
              .where(eq(schema.lastAccessibleContexts.userId, session.userId))
              .orderBy(desc(schema.lastAccessibleContexts.updatedAt))
              .limit(1)

            if (lastContext) {
              return {
                data: {
                  ...session,
                  activeOrganizationId: lastContext.organizationId,
                },
              }
            }

            const [membership] = await db
              .select({ organizationId: schema.members.organizationId })
              .from(schema.members)
              .where(
                and(eq(schema.members.userId, session.userId), isNull(schema.members.disabledAt))
              )
              .orderBy(asc(schema.members.createdAt), asc(schema.members.organizationId))
              .limit(1)

            if (!membership) {
              return
            }

            return {
              data: {
                ...session,
                activeOrganizationId: membership.organizationId,
              },
            }
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            const organization = await getAuth().api.createOrganization({
              body: {
                name: `${user.name}'s Organisation`,
                slug: `org-${randomUUID()}`,
                userId: user.id,
              },
            })
            await getDB()
              .update(schema.sessions)
              .set({ activeOrganizationId: organization.id })
              .where(
                and(
                  eq(schema.sessions.userId, user.id),
                  isNull(schema.sessions.activeOrganizationId)
                )
              )
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60,
      updateAge: 15 * 60,
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/social": { window: 60, max: 5 },
        "/callback/:id": { window: 60, max: 10 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") {
          return
        }

        const allowedUsers = env.EMAIL_PASSWORD_AUTH_ALLOWED_USER
        if (!allowedUsers) {
          return
        }

        const parsed = credentialEmailSchema.safeParse(ctx.body)
        if (!parsed.success || allowedUsers.includes(parsed.data.email)) {
          return
        }

        if (ctx.path === "/sign-in/email") {
          throw APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD)
        }

        throw APIError.from("FORBIDDEN", {
          code: "EMAIL_PASSWORD_AUTH_NOT_ALLOWED",
          message: authErrorMessages.email_password_auth_not_allowed,
        })
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/callback/:id") {
          return
        }

        const newSession = ctx.context.newSession
        const state = await getOAuthState()
        const social = socialOAuthStateSchema.safeParse(state)
        if (newSession?.user && social.success) {
          const admission = await createSocialAdmissionMembership(
            newSession.user,
            newSession.session.token,
            social.data
          )
          if (admission.kind === "unavailable") {
            throw ctx.redirect("/signin?error=social_admission_unavailable")
          }
          if (admission.kind === "disabled") {
            throw ctx.redirect(`/join/${admission.slug}?error=membership_disabled`)
          }
          if (admission.kind === "ineligible") {
            throw ctx.redirect(`/join/${admission.slug}?error=unable_to_get_user_info`)
          }
          if (admission.kind === "limit") {
            throw ctx.redirect(`/join/${admission.slug}?error=membership_limit`)
          }
          if (admission.kind === "provider-unavailable") {
            throw ctx.redirect(`/join/${admission.slug}?error=provider_unavailable`)
          }
        }
        if (!newSession?.user.twoFactorEnabled) {
          return
        }

        const plugin = ctx.context.getPlugin("two-factor")
        const trustDeviceMaxAge = plugin?.options?.trustDeviceMaxAge ?? defaultTrustDeviceMaxAge
        const trustDeviceCookie = ctx.context.createAuthCookie(trustDeviceCookieName, {
          maxAge: trustDeviceMaxAge,
        })
        const signedTrustDevice = await ctx.getSignedCookie(
          trustDeviceCookie.name,
          ctx.context.secret
        )

        if (signedTrustDevice) {
          const parts = signedTrustDevice.split("!")
          const [token, trustIdentifier] = parts
          if (parts.length === 2 && token && trustIdentifier) {
            const expectedToken = createHmac("sha256", ctx.context.secret)
              .update(`${newSession.user.id}!${trustIdentifier}`)
              .digest("base64url")
            const tokenBytes = Buffer.from(token)
            const expectedTokenBytes = Buffer.from(expectedToken)
            const verificationRecord =
              await ctx.context.internalAdapter.findVerificationValue(trustIdentifier)

            if (
              tokenBytes.length === expectedTokenBytes.length &&
              timingSafeEqual(tokenBytes, expectedTokenBytes) &&
              verificationRecord &&
              verificationRecord.value === newSession.user.id &&
              verificationRecord.expiresAt > new Date()
            ) {
              // Rotate the trusted-device record on each successful reuse so a
              // stolen old cookie cannot be replayed after the next login.
              await ctx.context.internalAdapter.deleteVerificationByIdentifier(trustIdentifier)

              const nextTrustIdentifier = `trust-device-${randomUUID()}`
              const nextToken = createHmac("sha256", ctx.context.secret)
                .update(`${newSession.user.id}!${nextTrustIdentifier}`)
                .digest("base64url")

              await ctx.context.internalAdapter.createVerificationValue({
                value: newSession.user.id,
                identifier: nextTrustIdentifier,
                expiresAt: new Date(Date.now() + trustDeviceMaxAge * 1000),
              })
              await ctx.setSignedCookie(
                trustDeviceCookie.name,
                `${nextToken}!${nextTrustIdentifier}`,
                ctx.context.secret,
                trustDeviceCookie.attributes
              )
              return
            }
          }

          expireCookie(ctx, trustDeviceCookie)
        }

        // OAuth callbacks create a live session before this hook runs. Burn
        // that session and replace it with a short-lived 2FA challenge so
        // there is no authenticated state until the second factor succeeds.
        deleteSessionCookie(ctx, true)
        await ctx.context.internalAdapter.deleteSession(newSession.session.token)
        ctx.context.setNewSession(null)

        const twoFactorCookieMaxAge =
          plugin?.options?.twoFactorCookieMaxAge ?? defaultTwoFactorCookieMaxAge
        const twoFactorCookie = ctx.context.createAuthCookie(twoFactorCookieName, {
          maxAge: twoFactorCookieMaxAge,
        })
        const twoFactorIdentifier = `2fa-${randomUUID()}`

        await ctx.context.internalAdapter.createVerificationValue({
          value: newSession.user.id,
          identifier: twoFactorIdentifier,
          expiresAt: new Date(Date.now() + twoFactorCookieMaxAge * 1000),
        })
        await ctx.setSignedCookie(
          twoFactorCookie.name,
          twoFactorIdentifier,
          ctx.context.secret,
          twoFactorCookie.attributes
        )

        const oauthState = await getOAuthState()
        const returnTo = signInReturnTo(oauthState?.callbackURL)
        const search = new URLSearchParams()
        if (returnTo) {
          search.set("returnTo", returnTo)
        }

        throw ctx.redirect(
          search.size === 0 ? "/signin/two-factor" : `/signin/two-factor?${search.toString()}`
        )
      }),
    },
    emailAndPassword: {
      enabled: env.ENABLE_EMAIL_PASSWORD_AUTH,
      minPasswordLength,
    },
    socialProviders: {
      // Each provider is enabled only when its env pair is configured; the env
      // schema enforces "both or neither" so an unconfigured provider spreads
      // nothing here and better-auth returns 404 on its callback route.
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              prompt: "select_account",
              scope: ["user:email", "read:org"],
              getUserInfo: getGithubUserInfo,
            },
          }
        : {}),
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              accessType: "offline",
              prompt: "select_account",
              getUserInfo: getGoogleUserInfo,
            },
          }
        : {}),
    },
    plugins: [
      organization({
        ac: organizationAccessControl,
        allowUserToCreateOrganization: false,
        creatorRole: "superadmin",
        disableOrganizationDeletion: true,
        membershipLimit: organizationMembershipLimit,
        dynamicAccessControl: {
          enabled: true,
        },
        roles: {
          member: memberRole,
          superadmin: superadminRole,
        },
        organizationHooks: {
          beforeUpdateOrganization: async ({ organization }) => {
            if (organization.slug !== undefined || organization.metadata !== undefined) {
              throw APIError.from("FORBIDDEN", {
                code: "GOVERNED_ORGANIZATION_MUTATION_REQUIRED",
                message: "Only governed Organisation profile fields can be updated.",
              })
            }
          },
          afterCreateOrganization: async ({ member, organization }) => {
            const roleId = `superadmin:${organization.id}`

            await getDB().transaction(async (tx) => {
              await tx
                .insert(schema.organizationRoles)
                .values({
                  id: roleId,
                  organizationId: organization.id,
                  permission: JSON.stringify(defaultStatements),
                  role: "superadmin",
                })
                .onConflictDoNothing()
              await tx
                .insert(schema.roleScopes)
                .values({
                  displayName: "Superadmin",
                  immutable: true,
                  organizationId: organization.id,
                  roleId,
                  systemRole: "superadmin",
                })
                .onConflictDoNothing()
              await tx
                .insert(schema.memberRoles)
                .values({
                  memberId: member.id,
                  organizationId: organization.id,
                  roleId,
                })
                .onConflictDoNothing()
            })
          },
          beforeRemoveMember: async ({ member, organization }) => {
            if (member.disabledAt) return

            const superadmins = await listActiveSuperadmins(organization.id)
            if (superadmins.length === 1 && superadmins[0]?.memberId === member.id) {
              throw APIError.from("BAD_REQUEST", {
                code: "FINAL_SUPERADMIN_REQUIRED",
                message: "The final active Superadmin cannot be removed.",
              })
            }
          },
          beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
            if (member.disabledAt || newRole.split(",").includes("superadmin")) return

            const [inherited] = await getDB()
              .select({ roleId: schema.memberRoleAssignments.roleId })
              .from(schema.memberRoleAssignments)
              .innerJoin(
                schema.roleScopes,
                and(
                  eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
                  eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
                )
              )
              .where(
                and(
                  eq(schema.memberRoleAssignments.memberId, member.id),
                  eq(schema.memberRoleAssignments.organizationId, organization.id),
                  isNotNull(schema.memberRoleAssignments.teamId),
                  eq(schema.roleScopes.systemRole, "superadmin")
                )
              )
              .limit(1)
            if (inherited) return

            const superadmins = await listActiveSuperadmins(organization.id)
            if (superadmins.length === 1 && superadmins[0]?.memberId === member.id) {
              throw APIError.from("BAD_REQUEST", {
                code: "FINAL_SUPERADMIN_REQUIRED",
                message: "The final active Superadmin cannot be demoted.",
              })
            }
          },
          afterUpdateMemberRole: async ({ member, organization }) => {
            const roleId = `superadmin:${organization.id}`
            await getDB().transaction(async (tx) => {
              if (member.role.split(",").includes("superadmin")) {
                await tx
                  .insert(schema.memberRoles)
                  .values({
                    memberId: member.id,
                    organizationId: organization.id,
                    roleId,
                  })
                  .onConflictDoNothing()
              } else {
                await tx
                  .delete(schema.memberRoles)
                  .where(
                    and(
                      eq(schema.memberRoles.memberId, member.id),
                      eq(schema.memberRoles.organizationId, organization.id),
                      eq(schema.memberRoles.roleId, roleId)
                    )
                  )
              }
              await projectMemberRoleTransports(tx, organization.id, [member.id])
            })
          },
        },
        schema: {
          member: {
            additionalFields: {
              disabledAt: {
                type: "date",
                required: false,
                input: false,
              },
            },
          },
        },
        teams: {
          enabled: true,
          allowRemovingAllTeams: true,
          defaultTeam: {
            enabled: false,
          },
        },
      }),
      organizationInvitation(),
      apiKey([
        {
          configId: agentAPIKeyConfigID,
          defaultPrefix: "opk_",
          startingCharactersConfig: {
            charactersLength: 10,
            shouldStore: true,
          },
          keyExpiration: {
            defaultExpiresIn: null,
          },
          rateLimit: {
            enabled: false,
          },
          references: "organization",
          requireName: true,
        },
        {
          configId: webhookAPIKeyConfigID,
          apiKeyHeaders: "x-api-key",
          defaultPrefix: "whk_",
          startingCharactersConfig: {
            charactersLength: 10,
            shouldStore: true,
          },
          keyExpiration: {
            defaultExpiresIn: null,
          },
          rateLimit: {
            enabled: false,
          },
          references: "organization",
          requireName: true,
        },
      ]),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          jwksPath: "/.well-known/jwks.json",
          keyPairConfig: {
            alg: "ES256",
          },
          rotationInterval: 60 * 60 * 24 * 30,
          gracePeriod: 60 * 60 * 24 * 30,
        },
        jwt: {
          audience: env.GATEWAY_JWT_AUDIENCE,
          expirationTime: "2m",
          issuer: env.BETTER_AUTH_URL,
        },
        schema: {
          jwks: {
            modelName: "jwk",
          },
        },
      }),
      twoFactor({
        allowPasswordless: true,
        issuer: "AgentZ",
      }),
      nextCookies(), // make sure this is the last plugin in the array
    ],
  })
}

async function createSocialAdmissionMembership(
  user: { id: string; email: string },
  sessionToken: string,
  state: z.infer<typeof socialOAuthStateSchema>
) {
  return getDB().transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: schema.organizations.id, slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, state.organizationId))
      .limit(1)
      .for("update")
    if (!organization) {
      return { kind: "unavailable" as const }
    }

    const [policy] = await tx
      .select({
        enabled: schema.socialAdmissionPolicies.enabled,
        githubEnabled: schema.socialAdmissionPolicies.githubEnabled,
        googleEnabled: schema.socialAdmissionPolicies.googleEnabled,
      })
      .from(schema.socialAdmissionPolicies)
      .where(eq(schema.socialAdmissionPolicies.organizationId, state.organizationId))
      .limit(1)
    if (
      !policy?.enabled ||
      (state.provider === "google" && !policy.googleEnabled) ||
      (state.provider === "github" && !policy.githubEnabled)
    ) {
      return { kind: "provider-unavailable" as const, slug: organization.slug }
    }

    let admitted = false
    if (state.provider === "google") {
      const domain = user.email.split("@").pop()?.toLowerCase()
      if (!domain) {
        return { kind: "ineligible" as const, slug: organization.slug }
      }
      const [rule] = await tx
        .select({ domain: schema.socialAdmissionGoogleDomains.domain })
        .from(schema.socialAdmissionGoogleDomains)
        .where(
          and(
            eq(schema.socialAdmissionGoogleDomains.organizationId, state.organizationId),
            eq(schema.socialAdmissionGoogleDomains.domain, domain)
          )
        )
        .limit(1)
      admitted = rule !== undefined
    } else {
      const [rule] = await tx
        .select({ id: schema.socialAdmissionGithubRules.id })
        .from(schema.socialAdmissionGithubRules)
        .where(eq(schema.socialAdmissionGithubRules.organizationId, state.organizationId))
        .limit(1)
      admitted = rule !== undefined
    }
    if (!admitted) {
      return { kind: "ineligible" as const, slug: organization.slug }
    }

    const [existing] = await tx
      .select({ disabledAt: schema.members.disabledAt })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, state.organizationId),
          eq(schema.members.userId, user.id)
        )
      )
      .limit(1)
    if (existing) {
      if (existing.disabledAt) {
        return { kind: "disabled" as const, slug: organization.slug }
      }
      return { kind: "member" as const, slug: organization.slug }
    }

    const roles = await tx
      .select({ id: schema.organizationRoles.id, role: schema.organizationRoles.role })
      .from(schema.socialAdmissionDefaultRoles)
      .innerJoin(
        schema.organizationRoles,
        and(
          eq(schema.organizationRoles.id, schema.socialAdmissionDefaultRoles.roleId),
          eq(
            schema.organizationRoles.organizationId,
            schema.socialAdmissionDefaultRoles.organizationId
          )
        )
      )
      .where(eq(schema.socialAdmissionDefaultRoles.organizationId, organization.id))
    const teams = await tx
      .select({ id: schema.teams.id })
      .from(schema.socialAdmissionDefaultTeams)
      .innerJoin(
        schema.teams,
        and(
          eq(schema.teams.id, schema.socialAdmissionDefaultTeams.teamId),
          eq(schema.teams.organizationId, schema.socialAdmissionDefaultTeams.organizationId)
        )
      )
      .where(eq(schema.socialAdmissionDefaultTeams.organizationId, organization.id))
    if (roles.length + teams.length === 0) {
      return { kind: "provider-unavailable" as const, slug: organization.slug }
    }

    const membershipCount = await tx.$count(
      schema.members,
      eq(schema.members.organizationId, organization.id)
    )
    if (membershipCount >= organizationMembershipLimit) {
      return { kind: "limit" as const, slug: organization.slug }
    }

    await createOrganizationMembership({
      db: tx,
      organizationId: organization.id,
      userId: user.id,
      roles,
      sessionToken,
      teams,
    })
    await tx.insert(schema.eventTrailEvents).values({
      action: "social_admission.accept",
      actorId: user.id,
      actorType: "user",
      after: [{ field: "user_id", value: user.id }],
      category: "membership",
      id: `event-trail-${randomUUID()}`,
      organizationId: organization.id,
      result: "succeeded",
      targetId: user.id,
      targetType: "organization_membership",
    })
    return { kind: "accepted" as const, slug: organization.slug }
  })
}

export type Auth = ReturnType<typeof buildAuth>
let authInstance: Auth | undefined

export const auth: Auth = new Proxy({} as Auth, {
  get(_, prop) {
    return Reflect.get(getAuth(), prop)
  },
})

/**
 * getAuth returns the shared Better Auth instance.
 */
export function getAuth(): Auth {
  authInstance ??= buildAuth()
  return authInstance
}
