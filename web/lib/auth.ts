import { betterAuth } from "better-auth"
import { nextCookies } from "better-auth/next-js"
import { jwt, organization } from "better-auth/plugins"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { randomUUID } from "node:crypto"
import { db, schema } from "@/db"
import { env } from "@/lib/env"
import { getGithubUserInfo } from "@/lib/github-membership"

const githubScope = ["user:email", ...(env.GITHUB_ORG ? (["read:org"] as const) : [])]

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema,
  }),
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await auth.api.createOrganization({
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
    disableSessionRefresh: true,
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
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      scope: githubScope,
      getUserInfo: getGithubUserInfo,
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      organizationLimit: 1,
      membershipLimit: 1,
    }),
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
    nextCookies(), // make sure this is the last plugin in the array
  ],
})
