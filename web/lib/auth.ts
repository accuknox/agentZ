import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { betterAuth } from "better-auth"
import { createAuthMiddleware, getOAuthState } from "better-auth/api"
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error"
import { nextCookies } from "better-auth/next-js"
import { deleteSessionCookie, expireCookie } from "better-auth/cookies"
import { apiKey } from "@better-auth/api-key"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { jwt } from "better-auth/plugins/jwt"
import { organization } from "better-auth/plugins/organization"
import { twoFactor } from "better-auth/plugins/two-factor"
import { z } from "zod"
import { authErrorMessages } from "@/app/(auth)/shared"
import { getDB, schema } from "@/db"
import { getEnv } from "@/lib/env"
import { getGithubUserInfo } from "@/lib/github-membership"
import { getGoogleUserInfo } from "@/lib/google-membership"
import { minPasswordLength } from "@/lib/password-policy"
import { signInReturnTo } from "@/lib/sign-in-redirect"

export const opencodeAPIKeyConfigID = "opencode"

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
let auth: Auth | undefined

const disabledAuthPaths = [
  // Gateway JWTs must go through currentGatewayAuthToken(), which verifies the
  // project's 1:1 user-organization invariant before minting a bearer token.
  "/token",
  // Organization state is provisioned and reconciled server-side only. Public
  // org endpoints would let a user mutate, delete, leave, or unset the single
  // tenant organization that the gateway uses as its security boundary.
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/organization/check-slug",
  "/organization/create",
  "/organization/delete",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/has-permission",
  "/organization/invite-member",
  "/organization/leave",
  "/organization/list",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/list-user-invitations",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/set-active",
  "/organization/update",
  "/organization/update-member-role",
  // Backup codes are issued once during enrollment and cannot be rotated later
  // through account settings or direct client calls.
  "/two-factor/generate-backup-codes",
]

function buildAuth() {
  const env = getEnv()

  return betterAuth({
    appName: "ClawArmor",
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    disabledPaths: disabledAuthPaths,
    database: drizzleAdapter(getDB(), {
      provider: "pg",
      usePlural: true,
      schema,
    }),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await getAuth().api.createOrganization({
              body: {
                name: `${user.name || user.email}'s tenant`,
                slug: `tenant-${randomUUID()}`,
                userId: user.id,
              },
            })
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
              // read:org is only needed when an org/team gate is configured.
              scope: ["user:email", ...(env.GITHUB_ORG ? (["read:org"] as const) : [])],
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
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        organizationLimit: 1,
        membershipLimit: 1,
      }),
      apiKey([
        {
          configId: opencodeAPIKeyConfigID,
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
          definePayload: ({ session, user }) => {
            if (!session.activeOrganizationId) {
              throw new Error("gateway JWT requires an active organization")
            }

            return {
              email: user.email,
              name: user.name,
              tenant_id: session.activeOrganizationId,
              user_id: user.id,
            }
          },
        },
        schema: {
          jwks: {
            modelName: "jwk",
          },
        },
      }),
      twoFactor({
        allowPasswordless: true,
        issuer: "ClawArmor",
      }),
      nextCookies(), // make sure this is the last plugin in the array
    ],
  })
}

export type Auth = ReturnType<typeof buildAuth>

/**
 * getAuth creates the Better Auth singleton lazily so the build does not need
 * runtime-only secrets.
 */
export function getAuth(): Auth {
  auth ??= buildAuth()
  return auth
}
