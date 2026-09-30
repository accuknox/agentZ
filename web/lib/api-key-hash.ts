import "server-only"

import { createHmac } from "node:crypto"

import { getEnv } from "@/lib/env"

/**
 * hashAPIKey returns the HMAC-SHA256 digest of the raw API key, keyed with the
 * server-side pepper (AGENTZ_API_KEY_PEPPER), encoded as unpadded base64url.
 *
 * This MUST stay byte-for-byte identical to the gateway's `hashAPIKey` in
 * internal/gateway/apikey.go: both use HMAC-SHA256 keyed with the shared pepper
 * and unpadded base64url encoding. The web app stores the hash at key creation;
 * the gateway recomputes it to look the key up, so the two encodings must match.
 *
 * It replaces @better-auth/api-key's `defaultKeyHasher` (plain unsalted SHA-256)
 * for API keys issued through the agentZ web UI. Legacy keys hashed with the old
 * plain SHA-256 scheme are handled by the gateway's dual-read/rehash-on-use.
 */
export function hashAPIKey(secret: string): string {
  return createHmac("sha256", getEnv().AGENTZ_API_KEY_PEPPER)
    .update(secret)
    .digest("base64url")
}
