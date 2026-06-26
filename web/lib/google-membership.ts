import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import type { GoogleProfile } from "@better-auth/core/social-providers"
import { decodeJwt } from "jose"
import { getEnv } from "@/lib/env"

// getGoogleUserInfo mirrors better-auth's default Google getUserInfo. Decodes
// the id token returned by the authorization-code exchange and adds the
// email-domain allowlist gate before Better Auth creates a session. Returning
// null blocks the sign-up.
export async function getGoogleUserInfo(token: OAuth2Tokens) {
  if (!token.idToken) {
    return null
  }

  const profile = decodeJwt<GoogleProfile>(token.idToken)

  // An unset allowlist means unrestricted sign-up: skip the domain gate. When
  // set, only emails whose domain is in the (lowercased, deduped) list are
  // permitted
  const allowedDomains = getEnv().GOOGLE_ALLOWED_EMAIL_DOMAINS
  if (allowedDomains) {
    const domain = (profile.email.split("@").pop() ?? "").toLowerCase()
    if (!allowedDomains.includes(domain)) {
      console.warn("google sign-in rejected: domain not allowed", {
        email: profile.email,
        allowed: allowedDomains,
      })
      return null
    }
  }

  return {
    user: {
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.email_verified,
    },
    data: profile,
  }
}
