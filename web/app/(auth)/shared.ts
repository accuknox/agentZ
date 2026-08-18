import * as z from "zod"
import { getEnv } from "@/lib/env"
import { searchParamStringSchema } from "@/lib/search-params"

export const authErrorSchema = z.enum([
  "email_password_auth_not_allowed",
  "invalid_code",
  "invalid_email_or_password",
  "no_callback_url",
  "session_expired",
  "signup_disabled",
  "state_mismatch",
  "unable_to_get_user_info",
  "user_exists",
])

export type AuthError = z.infer<typeof authErrorSchema>

export const socialProviderSchema = z.enum(["github", "google"])

export type SocialProvider = z.infer<typeof socialProviderSchema>

export const authErrorMessages = {
  email_password_auth_not_allowed: "Email/password sign-up is not allowed for this email address.",
  invalid_code: "Sign-in could not be completed. Try again.",
  invalid_email_or_password: "Invalid email or password.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the sign-in page.",
  session_expired: "Your session expired. Sign in again to continue.",
  signup_disabled: "No account exists for this sign-in. Sign up first.",
  state_mismatch: "The sign-in session expired or was opened in another tab. Try again.",
  unable_to_get_user_info: "Sign-in failed or this account is not authorized for this application.",
  user_exists: "Email is already in use.",
} as const satisfies Record<AuthError, string>
export type AuthPath = "/signin" | "/signup"

export const authSearchParamsSchema = z.object({
  error: searchParamStringSchema.pipe(authErrorSchema.optional()).catch(undefined),
  provider: searchParamStringSchema.pipe(socialProviderSchema.optional()).catch(undefined),
  returnTo: searchParamStringSchema,
})

export type AuthSearchParams = z.input<typeof authSearchParamsSchema>

export function socialProviders(): SocialProvider[] {
  const env = getEnv()
  const providers: SocialProvider[] = []

  if (env.GITHUB_CLIENT_ID) {
    providers.push("github")
  }
  if (env.GOOGLE_CLIENT_ID) {
    providers.push("google")
  }

  return providers
}
