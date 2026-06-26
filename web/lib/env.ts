import { z } from "zod"

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    MCP_OAUTH_COOKIE_SECRET: z.string().min(32),
    GATEWAY_JWT_AUDIENCE: z.string().trim().min(1).default("clawarmor-gateway"),
    // GitHub is optional: enabled iff GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
    // are both configured. The cross-validation below enforces the pair.
    GITHUB_CLIENT_ID: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    GITHUB_CLIENT_SECRET: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    GITHUB_ALLOWED_USER_ID: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().regex(/^\d+$/).optional()),
    GITHUB_ORG: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    GITHUB_TEAM_SLUG: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    // Google is optional and gated by an email-domain allowlist. The OAuth
    // client must whitelist the redirect URI .../api/auth/callback/google.
    GOOGLE_CLIENT_ID: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    GOOGLE_CLIENT_SECRET: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().min(1).optional()),
    GOOGLE_ALLOWED_EMAIL_DOMAINS: z.preprocess(
      (value) => {
        if (typeof value !== "string") {
          return value
        }

        const domains = value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0)

        return domains.length === 0 ? undefined : [...new Set(domains)]
      },
      z.array(z.string().min(1)).optional()
    ),
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

    // At least one social provider must be configured for login to function.
    if (!githubEnabled && !googleEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one social provider (GITHUB or GOOGLE) must be configured.",
        path: ["GITHUB_CLIENT_ID"],
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
