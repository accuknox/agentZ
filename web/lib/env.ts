import { z } from "zod"

const emptyString = z.literal("")

const optionalNonEmptyString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(emptyString)
  .transform((value) => (value === "" ? undefined : value))

const optionalGithubUserId = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .optional()
  .or(emptyString)
  .transform((value) => (value === "" ? undefined : value))

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_ALLOWED_USER_ID: optionalGithubUserId,
    GITHUB_ORG: optionalNonEmptyString,
    GITHUB_TEAM_SLUG: optionalNonEmptyString,
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && new URL(value.BETTER_AUTH_URL).protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BETTER_AUTH_URL must use https in production.",
        path: ["BETTER_AUTH_URL"],
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
