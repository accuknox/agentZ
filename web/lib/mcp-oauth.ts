import "server-only"

import {
  auth,
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { JsonObject, McpConnectionAuth } from "@/lib/gateway/client"
import { mcpAuthLocation, oauthCredentialsFromTokens, type ParsedMcpForm } from "@/data/mcp.schema"
import {
  oauthBroadcastChannelName,
  oauthWindowMessageSource,
  type OAuthPopupMessage,
} from "@/lib/mcp-oauth-shared"

type PendingCreateOperation = {
  kind: "create"
  form: ParsedMcpForm
}

type PendingUpdateOperation = {
  kind: "update"
  name: string
  form: ParsedMcpForm
}

export type PendingOAuthOperation = PendingCreateOperation | PendingUpdateOperation

export type PendingOAuthState = {
  flowId: string
  operation: PendingOAuthOperation
  state: string
  codeVerifier: string
  discoveryState?: OAuthDiscoveryState
  clientInformation: OAuthClientInformationMixed
}

type RuntimeOAuthState = {
  authorizationUrl?: URL
  codeVerifier?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
}

const oauthCookieName = "clawarmor-mcp-oauth"
const oauthCookieTTLSeconds = 15 * 60

function secretKeyMaterial() {
  const secret = process.env.MCP_OAUTH_COOKIE_SECRET
  if (secret) {
    return createHash("sha256").update(secret).digest()
  }

  throw new Error("MCP_OAUTH_COOKIE_SECRET is required for MCP OAuth flows")
}

function base64url(input: Buffer | ArrayBuffer) {
  return Buffer.from(input instanceof Buffer ? input : new Uint8Array(input)).toString("base64url")
}

function bufferFromBase64url(value: string) {
  return Buffer.from(value, "base64url")
}

function redirectURI() {
  const origin = process.env.NEXT_PUBLIC_WEB_BASE_URL
  if (!origin) {
    throw new Error("NEXT_PUBLIC_WEB_BASE_URL is required for MCP OAuth flows")
  }
  return new URL("/mcps/oauth/callback", origin)
}

function oauthClientMetadata(): OAuthClientMetadata {
  const url = redirectURI()
  const base = new URL("/", url)
  return {
    client_name: "ClawArmor MCP Web",
    redirect_uris: [url.toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope: "offline_access",
    client_uri: base.toString(),
  }
}

function requiresManualClientInput(form: ParsedMcpForm) {
  if (form.oauth.clientId && form.oauth.clientSecret) {
    return false
  }
  if (form.mode === "update" && form.currentAuthMode === "oauth") {
    if (form.oauth.preserveClientId || form.oauth.preserveClientSecret) {
      return true
    }
  }
  return !form.oauth.clientId && !form.oauth.clientSecret
}

function oauthProvider(input: { form: ParsedMcpForm; runtime: RuntimeOAuthState; state: string }) {
  const metadata = oauthClientMetadata()

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectURI()
    },
    get clientMetadata() {
      return metadata
    },
    state() {
      return input.state
    },
    clientInformation() {
      return input.runtime.clientInformation
    },
    saveClientInformation(clientInformation) {
      input.runtime.clientInformation = clientInformation
    },
    tokens() {
      return input.runtime.tokens
    },
    saveTokens(tokens) {
      input.runtime.tokens = tokens
    },
    redirectToAuthorization(authorizationUrl) {
      input.runtime.authorizationUrl = authorizationUrl
    },
    saveCodeVerifier(codeVerifier) {
      input.runtime.codeVerifier = codeVerifier
    },
    codeVerifier() {
      if (!input.runtime.codeVerifier) {
        throw new Error("OAuth code verifier is missing")
      }
      return input.runtime.codeVerifier
    },
    saveDiscoveryState(discoveryState) {
      input.runtime.discoveryState = discoveryState
    },
    discoveryState() {
      return input.runtime.discoveryState
    },
  }

  if (input.form.oauth.clientId && input.form.oauth.clientSecret) {
    input.runtime.clientInformation = {
      client_id: input.form.oauth.clientId,
      client_secret: input.form.oauth.clientSecret,
    }
  }

  return provider
}

export function mcpOAuthCookieName() {
  return oauthCookieName
}

export async function sealPendingOAuthState(state: PendingOAuthState) {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretKeyMaterial()),
    "AES-GCM",
    false,
    ["encrypt"]
  )
  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(state))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  return `${base64url(iv)}.${base64url(ciphertext)}`
}

export async function openPendingOAuthState(value: string) {
  const [ivPart, ciphertextPart] = value.split(".")
  if (!ivPart || !ciphertextPart) {
    throw new Error("Pending OAuth state cookie is malformed")
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretKeyMaterial()),
    "AES-GCM",
    false,
    ["decrypt"]
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferFromBase64url(ivPart) },
    key,
    bufferFromBase64url(ciphertextPart)
  )
  return JSON.parse(Buffer.from(decrypted).toString("utf8")) as PendingOAuthState
}

export function oauthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: oauthCookieTTLSeconds,
  }
}

export async function beginOAuthFlow(operation: PendingOAuthOperation) {
  const state = randomBytes(24).toString("base64url")
  const flowId = randomBytes(18).toString("base64url")
  const runtime: RuntimeOAuthState = {}
  if (requiresManualClientInput(operation.form)) {
    const discoveryState = await discoverOAuthServerInfo(operation.form.endpoint.url)
    runtime.discoveryState = discoveryState
    if (!discoveryState.authorizationServerMetadata?.registration_endpoint) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClient,
        "Client ID and client secret are required because this MCP server does not support dynamic client registration."
      )
    }
  }
  const provider = oauthProvider({
    form: operation.form,
    runtime,
    state,
  })

  const result = await auth(provider, {
    serverUrl: operation.form.endpoint.url,
    scope: operation.form.oauth.scopes?.join(" "),
  })
  if (result !== "REDIRECT" || !runtime.authorizationUrl || !runtime.codeVerifier) {
    throw new Error("OAuth authorization redirect could not be started")
  }

  if (!runtime.clientInformation) {
    throw new Error("OAuth client registration did not produce client information")
  }

  return {
    authorizationURL: runtime.authorizationUrl,
    pending: {
      flowId,
      operation,
      state,
      codeVerifier: runtime.codeVerifier,
      discoveryState: runtime.discoveryState,
      clientInformation: runtime.clientInformation,
    } satisfies PendingOAuthState,
  }
}

export async function completeOAuthFlow(input: { pending: PendingOAuthState; callbackURL: URL }) {
  const stateParam = input.callbackURL.searchParams.get("state")
  if (!stateParam) {
    throw new Error("OAuth callback is missing state")
  }
  if (!timingSafeEqual(Buffer.from(stateParam), Buffer.from(input.pending.state))) {
    throw new Error("OAuth callback state is invalid")
  }

  const code = input.callbackURL.searchParams.get("code")
  if (!code) {
    const error = input.callbackURL.searchParams.get("error")
    const description = input.callbackURL.searchParams.get("error_description")
    if (error) {
      throw new Error(description ? `${error}: ${description}` : error)
    }
    throw new Error("OAuth callback is missing code")
  }

  const runtime: RuntimeOAuthState = {
    codeVerifier: input.pending.codeVerifier,
    clientInformation: input.pending.clientInformation,
    discoveryState: input.pending.discoveryState,
  }
  const provider = oauthProvider({
    form: input.pending.operation.form,
    runtime,
    state: input.pending.state,
  })

  const result = await auth(provider, {
    serverUrl: input.pending.operation.form.endpoint.url,
    authorizationCode: code,
    scope: input.pending.operation.form.oauth.scopes?.join(" "),
  })
  if (result !== "AUTHORIZED" || !runtime.tokens || !runtime.discoveryState) {
    throw new Error("OAuth callback could not be completed")
  }

  return {
    auth: oauthAuthFromPending(runtime.discoveryState),
    credentials: oauthCredentialsFromTokens({
      clientId: input.pending.clientInformation.client_id,
      clientSecret:
        "client_secret" in input.pending.clientInformation
          ? input.pending.clientInformation.client_secret
          : undefined,
      accessToken: runtime.tokens.access_token,
      refreshToken: runtime.tokens.refresh_token,
      expiresAt: runtime.tokens.expires_in
        ? new Date(Date.now() + runtime.tokens.expires_in * 1000).toISOString()
        : undefined,
      tokenType: runtime.tokens.token_type,
      scopes: runtime.tokens.scope?.split(" ").filter(Boolean),
      registration:
        "registration_access_token" in input.pending.clientInformation ||
        "client_secret_expires_at" in input.pending.clientInformation
          ? (input.pending.clientInformation as JsonObject)
          : undefined,
    }),
  }
}

export function oauthAuthFromPending(discoveryState: OAuthDiscoveryState): McpConnectionAuth {
  return {
    oauth: {
      issuer: discoveryState.authorizationServerUrl,
      authorization_endpoint: discoveryState.authorizationServerMetadata?.authorization_endpoint,
      token_endpoint: discoveryState.authorizationServerMetadata?.token_endpoint,
      registration_endpoint: discoveryState.authorizationServerMetadata?.registration_endpoint,
      resource: discoveryState.resourceMetadata?.resource,
      scopes: discoveryState.resourceMetadata?.scopes_supported,
      location: mcpAuthLocation(),
    },
  }
}

export function oauthCallbackResultPage(input: {
  success: boolean
  flowId?: string
  message: string
}) {
  const payload = JSON.stringify({
    source: oauthWindowMessageSource,
    kind: "result",
    success: input.success,
    flowId: input.flowId,
    message: input.message,
  } satisfies OAuthPopupMessage)
  const message = JSON.stringify(input.message)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP OAuth</title>
  </head>
  <body>
    <script>
      const payload = ${payload};
      const message = ${message};
      if (!payload.flowId) {
        payload.flowId = crypto.randomUUID();
      }
      const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(${JSON.stringify(oauthBroadcastChannelName)}) : null;
      if (channel) {
        const closeWhenAcknowledged = (event) => {
          const data = event.data;
          if (!data || data.source !== payload.source || data.kind !== "ack") {
            return;
          }
          if (data.flowId !== payload.flowId) {
            return;
          }
          channel.removeEventListener("message", closeWhenAcknowledged);
          channel.close();
          window.close();
        };
        channel.addEventListener("message", closeWhenAcknowledged);
        channel.postMessage(payload);
      }
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
        if (!channel) {
          window.close();
        }
      } else {
        document.body.textContent = message;
      }
    </script>
  </body>
</html>`
}
