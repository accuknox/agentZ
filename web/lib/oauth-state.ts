import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { getEnv } from "@/lib/env"

export type OAuthStatePurpose = "inference-provider" | "mcp"

/** sealOAuthState encrypts browser-carried OAuth state for one flow family. */
export async function sealOAuthState(value: object, purpose: OAuthStatePurpose) {
  const key = await crypto.subtle.importKey(
    "raw",
    createHash("sha256")
      .update(getEnv().MCP_OAUTH_COOKIE_SECRET)
      .update("\0")
      .update(purpose)
      .digest(),
    "AES-GCM",
    false,
    ["encrypt"]
  )
  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  return `${iv.toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`
}

/** openOAuthState decrypts state sealed for the same OAuth flow family. */
export async function openOAuthState(value: string, purpose: OAuthStatePurpose): Promise<unknown> {
  const [ivPart, ciphertextPart, extraPart] = value.split(".")
  if (!ivPart || !ciphertextPart || extraPart) {
    throw new Error("Pending OAuth state is malformed")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    createHash("sha256")
      .update(getEnv().MCP_OAUTH_COOKIE_SECRET)
      .update("\0")
      .update(purpose)
      .digest(),
    "AES-GCM",
    false,
    ["decrypt"]
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(ivPart, "base64url") },
    key,
    Buffer.from(ciphertextPart, "base64url")
  )
  return JSON.parse(Buffer.from(decrypted).toString("utf8"))
}
