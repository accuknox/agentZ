import { getEnv } from "@/lib/env"

export const authErrorMessages = {
  email_password_auth_not_allowed: "Email/password sign-up is not allowed for this email address.",
  invalid_code: "Sign-in could not be completed. Try again.",
  invalid_email_or_password: "Invalid email or password.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the sign-in page.",
  session_expired: "Your session expired. Sign in again to continue.",
  state_mismatch: "The sign-in session expired or was opened in another tab. Try again.",
  unable_to_get_user_info: "Sign-in failed or this account is not authorized for this application.",
  user_exists: "Email is already in use.",
} as const satisfies Record<string, string>

export type AuthError = keyof typeof authErrorMessages
export type SocialProvider = "github" | "google"

export type AuthSearchParams = {
  error?: AuthError | AuthError[]
  returnTo?: string | string[]
}

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
