import { z } from "zod"

// optionalNonEmptyString treats empty/whitespace values as unset so users can
// leave an env var absent or blank without tripping the min(1) validator.
const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value
  }

  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}, z.string().min(1).optional())

// commaList parses a comma-separated env value into a deduped, lowercased
// string array. Normalisation lives at the trust boundary (env parse) so
// downstream consumers compare against already-canonical values.
const commaList = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value
    }

    const entries = value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)

    return entries.length === 0 ? undefined : [...new Set(entries)]
  },
  z.array(z.string().min(1)).optional()
)

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    MCP_OAUTH_COOKIE_SECRET: z.string().min(32),
    GATEWAY_JWT_AUDIENCE: z.string().trim().min(1).default("clawarmor-gateway"),
    // GitHub is optional: enabled iff GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
    // are both configured. The cross-validation below enforces the pair.
    GITHUB_CLIENT_ID: optionalNonEmptyString,
    GITHUB_CLIENT_SECRET: optionalNonEmptyString,
    GITHUB_ALLOWED_USER_ID: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value
      }

      const trimmed = value.trim()
      return trimmed === "" ? undefined : trimmed
    }, z.string().regex(/^\d+$/).optional()),
    GITHUB_ORG: optionalNonEmptyString,
    GITHUB_TEAM_SLUG: optionalNonEmptyString,
    // Google is optional and gated by an email-domain allowlist. The OAuth
    // client must whitelist the redirect URI .../api/auth/callback/google.
    GOOGLE_CLIENT_ID: optionalNonEmptyString,
    GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
    GOOGLE_ALLOWED_EMAIL_DOMAINS: commaList,
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

export const env = envSchema.parse(process.env)
