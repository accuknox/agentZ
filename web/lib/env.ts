import { z } from "zod"

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value
  }

  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}, z.string().min(1).optional())

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    MCP_OAUTH_COOKIE_SECRET: z.string().min(32),
    GATEWAY_JWT_AUDIENCE: z.string().trim().min(1).default("clawarmor-gateway"),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_ALLOWED_USER_ID: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().regex(/^\d+$/).optional()),
    GITHUB_ORG: optionalNonEmptyString,
    GITHUB_TEAM_SLUG: optionalNonEmptyString,
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .superRefine((value, ctx) => {
    if (value.GITHUB_TEAM_SLUG && !value.GITHUB_ORG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GITHUB_TEAM_SLUG requires GITHUB_ORG.",
        path: ["GITHUB_TEAM_SLUG"],
      })
    }
  })

export const env = envSchema.parse(process.env)
