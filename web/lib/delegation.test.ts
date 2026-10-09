import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { jwt } from "better-auth/plugins/jwt"
import type {
  OAuthOpaqueAccessToken,
  OAuthRefreshToken,
  SchemaClient,
} from "@better-auth/oauth-provider"
import { agentZOAuthProvider } from "./delegation"

test("revocation binds tokens to their client before invalidating a refresh family", async () => {
  const cases = [
    { name: "another client's revoked refresh", token: "token-A", hint: "refresh_token" },
    { name: "another client's revoked refresh without a hint", token: "token-A" },
    {
      name: "another client's active refresh",
      token: "token-A",
      hint: "refresh_token",
      activeA: true,
    },
    { name: "Bearer-decorated revoked refresh", token: "Bearer token-A", hint: "refresh_token" },
    { name: "DPoP-decorated revoked refresh without a hint", token: "dPoP\ttoken-A" },
    { name: "whitespace around a revoked refresh", token: " token-A " },
    { name: "unknown token", token: "unknown-token", hint: "refresh_token", status: 400 },
    {
      name: "own active refresh revokes its linked access token",
      token: "token-B",
      hint: "refresh_token",
      ownRevocation: true,
    },
    {
      name: "own revoked refresh invalidates only its own family",
      token: "token-B",
      hint: "refresh_token",
      ownRevocation: true,
      revokedB: true,
      status: 400,
    },
  ]
  for (const scenario of cases) {
    const issuer = "https://issuer.example"
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + 60_000)
    const db = {
      oauthResource: [],
      oauthClient: ["A", "B"].map(
        (clientId) =>
          ({
            id: `client-${clientId}`,
            clientId,
            tokenEndpointAuthMethod: "none",
            applicationType: "web",
            scopes: ["openid", "offline_access"],
            grantTypes: ["authorization_code", "refresh_token"],
            disabled: false,
          }) satisfies SchemaClient & { id: string }
      ),
      oauthRefreshToken: [
        {
          id: "refresh-A",
          token: createHash("sha256").update("token-A").digest("base64url"),
          clientId: "A",
          userId: "user",
          scopes: ["openid", "offline_access"],
          revoked: scenario.activeA ? undefined : createdAt,
          createdAt,
          expiresAt,
        },
        {
          id: "refresh-B",
          token: createHash("sha256").update("token-B").digest("base64url"),
          clientId: "B",
          userId: "user",
          scopes: ["openid", "offline_access"],
          revoked: scenario.revokedB ? createdAt : undefined,
          createdAt,
          expiresAt,
        },
      ] satisfies (OAuthRefreshToken & { id: string })[],
      oauthAccessToken: [
        {
          id: "access-A",
          token: "hashed-access-A",
          clientId: "A",
          userId: "user",
          refreshId: "refresh-A",
          scopes: ["openid"],
          createdAt,
          expiresAt,
        },
        {
          id: "access-B",
          token: "hashed-access-B",
          clientId: "B",
          userId: "user",
          refreshId: "refresh-B",
          scopes: ["openid"],
          createdAt,
          expiresAt,
        },
      ] satisfies (OAuthOpaqueAccessToken & { id: string })[],
    }
    const auth = betterAuth({
      baseURL: issuer,
      secret: "isolated-test-secret-never-use-in-production",
      database: memoryAdapter(db),
      plugins: [jwt(), agentZOAuthProvider(issuer)],
    })
    const body = new URLSearchParams({ client_id: "B", token: scenario.token })
    if (scenario.hint) body.set("token_type_hint", scenario.hint)
    const response = await auth.handler(
      new Request(`${issuer}/api/auth/oauth2/revoke`, { method: "POST", body })
    )
    assert.equal(response.status, scenario.status ?? 200, scenario.name)
    assert.equal(
      db.oauthRefreshToken.filter((row) => row.clientId === "B").length,
      scenario.revokedB ? 0 : 1,
      scenario.name
    )
    assert.equal(
      db.oauthAccessToken.some((row) => row.clientId === "B"),
      !scenario.ownRevocation,
      scenario.name
    )
    assert.equal(
      db.oauthRefreshToken.some((row) => row.clientId === "A"),
      true,
      scenario.name
    )
    assert.equal(
      db.oauthAccessToken.some((row) => row.clientId === "A"),
      true,
      scenario.name
    )
    if (scenario.ownRevocation && !scenario.revokedB)
      assert.ok(db.oauthRefreshToken.find((row) => row.clientId === "B")?.revoked, scenario.name)
  }
})
