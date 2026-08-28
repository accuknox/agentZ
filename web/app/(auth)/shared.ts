import * as z from "zod"
import { getEnv } from "@/lib/env"
import { searchParamStringSchema } from "@/lib/search-params"

const authErrorSchema = z.enum([
  "access_denied",
  "account_already_linked_to_different_user",
  "account_not_linked",
  "email_doesn't_match",
  "email_not_found",
  "email_password_auth_not_allowed",
  "internal_server_error",
  "invalid_callback_request",
  "invalid_code",
  "invalid_email_or_password",
  "no_callback_url",
  "no_code",
  "oauth_provider_not_found",
  "session_expired",
  "social_admission_unavailable",
  "signup_disabled",
  "state_invalid",
  "state_mismatch",
  "state_not_found",
  "unable_to_create_session",
  "unable_to_create_user",
  "unable_to_get_user_info",
  "unable_to_link_account",
  "unknown",
  "user_exists",
])

export type AuthError = z.infer<typeof authErrorSchema>

export const socialProviderSchema = z.enum(["github", "google"])

export type SocialProvider = z.infer<typeof socialProviderSchema>

const retrySignInMessage = "Sign-in could not be completed. Try again."
const restartSignInMessage = "The sign-in session expired or was opened in another tab. Try again."

export const authErrorMessages = {
  access_denied: "Sign-in was cancelled or denied by the provider.",
  account_already_linked_to_different_user:
    "This sign-in method is already linked to another account.",
  account_not_linked:
    "An account already exists for this email. Sign in with the method you used before.",
  "email_doesn't_match": "The provider email does not match your account.",
  email_not_found:
    "The provider did not return an email address. Try another account or sign-in method.",
  email_password_auth_not_allowed: "Email/password sign-up is not allowed for this email address.",
  internal_server_error: retrySignInMessage,
  invalid_callback_request: retrySignInMessage,
  invalid_code: retrySignInMessage,
  invalid_email_or_password: "Invalid email or password.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the sign-in page.",
  no_code: retrySignInMessage,
  oauth_provider_not_found: "This sign-in method is not available. Try another method.",
  session_expired: "Your session expired. Sign in again to continue.",
  social_admission_unavailable: retrySignInMessage,
  signup_disabled: "No account exists for this sign-in. Sign up first.",
  state_invalid: restartSignInMessage,
  state_mismatch: restartSignInMessage,
  state_not_found: restartSignInMessage,
  unable_to_create_session: retrySignInMessage,
  unable_to_create_user: retrySignInMessage,
  unable_to_get_user_info: "Sign-in failed or this account is not authorized for this application.",
  unable_to_link_account: retrySignInMessage,
  unknown: retrySignInMessage,
  user_exists: "Email is already in use.",
} as const satisfies Record<AuthError, string>
export type AuthPath = "/signin" | "/signup"

export const authErrorParamSchema = searchParamStringSchema.pipe(
  authErrorSchema.optional().catch("unknown")
)

export const authSearchParamsSchema = z.object({
  error: authErrorParamSchema,
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
