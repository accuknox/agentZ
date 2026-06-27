import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import { createRemoteJWKSet, jwtVerify } from "jose"
import * as z from "zod"
import { getEnv } from "@/lib/env"

const googleIssuerJWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))

const googleIDTokenClaimsSchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().optional(),
    email: z.email(),
    email_verified: z.boolean().optional().default(false),
    picture: z.string().optional(),
  })
  .passthrough()

// getGoogleUserInfo verifies Google's ID token before applying the local
// allowlist gate. The verified email claim is the tenant admission signal.
export async function getGoogleUserInfo(token: OAuth2Tokens) {
  if (!token.idToken) {
    return null
  }

  const env = getEnv()
  if (!env.GOOGLE_CLIENT_ID) {
    return null
  }

  let profile: z.infer<typeof googleIDTokenClaimsSchema>
  try {
    const { payload } = await jwtVerify(token.idToken, googleIssuerJWKS, {
      audience: env.GOOGLE_CLIENT_ID,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    })
    const parsed = googleIDTokenClaimsSchema.safeParse(payload)
    if (!parsed.success) {
      console.warn("google sign-in rejected: invalid id token claims")
      return null
    }
    profile = parsed.data
  } catch (error) {
    console.warn("google sign-in rejected: id token verification failed", {
      message: error instanceof Error ? error.message : "unknown error",
    })
    return null
  }

  if (!profile.email_verified) {
    console.warn("google sign-in rejected: email is not verified")
    return null
  }

  // An unset allowlist means unrestricted sign-up: skip the domain gate. When
  // set, only emails whose domain is in the (lowercased, deduped) list are
  // permitted
  const allowedDomains = env.GOOGLE_ALLOWED_EMAIL_DOMAINS
  if (allowedDomains) {
    const domain = (profile.email.split("@").pop() ?? "").toLowerCase()
    if (!allowedDomains.includes(domain)) {
      console.warn("google sign-in rejected: domain not allowed", {
        domain,
        allowed: allowedDomains,
      })
      return null
    }
  }

  return {
    user: {
      id: profile.sub,
      name: profile.name ?? profile.email,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.email_verified,
    },
    data: profile,
  }
}
