import { z } from "zod"

const csvEmailListSchema = z
  .string()
  .trim()
  .transform((value) => {
    if (!value) {
      return
    }

    return [
      ...new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      ),
    ]
  })
  .pipe(z.array(z.string().trim().toLowerCase().pipe(z.email())).optional())

const csvLowercaseListSchema = z
  .string()
  .trim()
  .transform((value) => {
    if (!value) {
      return
    }

    return [
      ...new Set(
        value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      ),
    ]
  })
  .pipe(z.array(z.string().min(1)).optional())

const optionalNonEmptyStringSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .pipe(z.string().min(1).optional())

const optionalDigitsStringSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .pipe(z.string().regex(/^\d+$/).optional())

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    MCP_OAUTH_COOKIE_SECRET: z.string().min(32),
    GATEWAY_JWT_AUDIENCE: z.string().trim().min(1).default("agentz-gateway"),
    ENABLE_EMAIL_PASSWORD_AUTH: z.stringbool().default(false),
    // When set, only these exact email addresses may use credential auth.
    EMAIL_PASSWORD_AUTH_ALLOWED_USER: csvEmailListSchema.optional(),
    // GitHub is optional: enabled iff GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
    // are both configured. The cross-validation below enforces the pair.
    GITHUB_CLIENT_ID: optionalNonEmptyStringSchema.optional(),
    GITHUB_CLIENT_SECRET: optionalNonEmptyStringSchema.optional(),
    GITHUB_ALLOWED_USER_ID: optionalDigitsStringSchema.optional(),
    GITHUB_ORG: optionalNonEmptyStringSchema.optional(),
    GITHUB_TEAM_SLUG: optionalNonEmptyStringSchema.optional(),
    // Google is optional and gated by an email-domain allowlist. The OAuth
    // client must whitelist the redirect URI .../api/auth/callback/google.
    GOOGLE_CLIENT_ID: optionalNonEmptyStringSchema.optional(),
    GOOGLE_CLIENT_SECRET: optionalNonEmptyStringSchema.optional(),
    GOOGLE_ALLOWED_EMAIL_DOMAINS: csvLowercaseListSchema.optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .superRefine((value, ctx) => {
    // A provider is enabled only when both its ID and secret are set; a lone
    // client id or secret is a misconfiguration, not a partial enablement.
    const githubEnabled = Boolean(value.GITHUB_CLIENT_ID)
    if (githubEnabled !== Boolean(value.GITHUB_CLIENT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together.",
        path: ["GITHUB_CLIENT_SECRET"],
      })
    }
    const googleEnabled = Boolean(value.GOOGLE_CLIENT_ID)
    if (googleEnabled !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.",
        path: ["GOOGLE_CLIENT_SECRET"],
      })
    }

    // GOOGLE_ALLOWED_EMAIL_DOMAINS is optional: when unset, Google sign-up is
    // unrestricted (any Google account). When set, sign-ups are gated to the
    // listed domains.

    if (!githubEnabled && !googleEnabled && !value.ENABLE_EMAIL_PASSWORD_AUTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one auth method must be configured.",
        path: ["ENABLE_EMAIL_PASSWORD_AUTH"],
      })
    }

    if (value.GITHUB_TEAM_SLUG && !value.GITHUB_ORG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GITHUB_TEAM_SLUG requires GITHUB_ORG.",
        path: ["GITHUB_TEAM_SLUG"],
      })
    }
  })

export type Env = z.infer<typeof envSchema>

let env: Env | undefined

/**
 * getEnv validates the process environment on first runtime use and memoizes
 * the parsed result for the rest of the process lifetime.
 */
export function getEnv(): Env {
  env ??= envSchema.parse(process.env)
  return env
}
