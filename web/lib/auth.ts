import { betterAuth } from "better-auth"
import { nextCookies } from "better-auth/next-js"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
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
    nextCookies(), // make sure this is the last plugin in the array
  ],
})
