import "server-only"

import {
  auth,
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@modelcontextprotocol/client"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import * as z from "zod"
import type { JsonObject, McpConnectionAuth } from "@/lib/gateway/client"
import { mcpAuthLocation, oauthCredentialsFromTokens, type ParsedMcpForm } from "@/data/mcp.schema"
import {
  oauthBroadcastChannelName,
  oauthErrorFieldNames,
  oauthPendingCookieBudget,
  oauthWindowMessageSource,
  type OAuthErrorFieldName,
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

const storedOAuthProtectedResourceMetadataSchema = z
  .object({
    resource: z.string().url(),
    authorization_servers: z.array(z.string().url()).optional(),
    scopes_supported: z.array(z.string().min(1)).optional(),
  })
  .passthrough()

const storedAuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().min(1),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url().optional(),
    scopes_supported: z.array(z.string().min(1)).optional(),
    response_types_supported: z.array(z.string().min(1)),
    response_modes_supported: z.array(z.string().min(1)).optional(),
    grant_types_supported: z.array(z.string().min(1)).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
    token_endpoint_auth_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
    service_documentation: z.string().url().optional(),
    revocation_endpoint: z.string().url().optional(),
    revocation_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
    revocation_endpoint_auth_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
    introspection_endpoint: z.string().optional(),
    introspection_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
    introspection_endpoint_auth_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
    code_challenge_methods_supported: z.array(z.string().min(1)).optional(),
    client_id_metadata_document_supported: z.boolean().optional(),
  })
  .passthrough()

const parsedMcpFormSchema: z.ZodType<ParsedMcpForm> = z.object({
  mode: z.enum(["create", "update"]),
  currentName: z.string().min(1).optional(),
  currentAuthMode: z.enum(["none", "bearer", "oauth"]),
  name: z.string().min(1),
  endpoint: z.object({
    url: z.string().url(),
    timeout: z.string().min(1).optional(),
    insecure_skip_verify: z.boolean(),
    headers: z.record(z.string(), z.string()),
  }),
  authMode: z.enum(["bearer", "oauth"]),
  bearerToken: z.string().min(1).optional(),
  oauth: z.object({
    scopes: z.array(z.string().min(1)).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  }),
})

const pendingOAuthOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    form: parsedMcpFormSchema,
  }),
  z.object({
    kind: z.literal("update"),
    name: z.string().min(1),
    form: parsedMcpFormSchema,
  }),
])

const oauthClientInformationMixedSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  })
  .passthrough()

const oauthDiscoveryStateSchema = z.object({
  authorizationServerUrl: z.string().min(1),
  resourceMetadataUrl: z.string().optional(),
  resourceMetadata: storedOAuthProtectedResourceMetadataSchema.optional(),
  authorizationServerMetadata: storedAuthorizationServerMetadataSchema.optional(),
})

const pendingOAuthStateSchema = z.object({
  version: z.literal(1),
  flowId: z.string().min(1),
  operation: pendingOAuthOperationSchema,
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  discoveryState: oauthDiscoveryStateSchema.optional(),
  clientInformation: oauthClientInformationMixedSchema,
})

export type PendingOAuthState = {
  version: 1
  flowId: string
  operation: PendingOAuthOperation
  state: string
  codeVerifier: string
  discoveryState?: StoredOAuthDiscoveryState
  clientInformation: OAuthClientInformationMixed
}

export type StoredOAuthDiscoveryState = z.infer<typeof oauthDiscoveryStateSchema>
export type DiscoverOAuthAuthValue = NonNullable<McpConnectionAuth["oauth"]>

export type OAuthFlowErrorCode =
  | "cookie_too_large"
  | "callback_missing_state"
  | "callback_state_invalid"
  | "callback_missing_code"
  | "callback_provider_error"
  | "oauth_not_ready"
  | "oauth_start_failed"
  | "oauth_complete_failed"
  | "manual_client_credentials_required"

export type OAuthFlowError = {
  code: OAuthFlowErrorCode
  message: string
  field?: OAuthErrorFieldName
  flowId?: string
}

type OAuthResult<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: OAuthFlowError
    }

export type BeginOAuthFlowValue = {
  authorizationURL: URL
  pending: PendingOAuthState
}

export type CompleteOAuthFlowValue = {
  flowId: string
  auth: McpConnectionAuth
  credentials: ReturnType<typeof oauthCredentialsFromTokens>
  message: string
}

type RuntimeOAuthState = {
  authorizationUrl?: URL
  codeVerifier?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: StoredOAuthDiscoveryState
}

const oauthCookieName = "clawarmor-mcp-oauth"
const oauthCookieTTLSeconds = 15 * 60
const googleAuthorizationHosts = new Set(["accounts.google.com"])

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

function applyProviderAuthorizationURLCompat(authorizationUrl: URL) {
  if (!googleAuthorizationHosts.has(authorizationUrl.hostname)) {
    return authorizationUrl
  }

  if (!authorizationUrl.searchParams.has("access_type")) {
    authorizationUrl.searchParams.set("access_type", "offline")
  }

  const promptValues = (authorizationUrl.searchParams.get("prompt") ?? "")
    .split(" ")
    .filter(Boolean)
  if (!promptValues.includes("consent")) {
    promptValues.push("consent")
  }
  authorizationUrl.searchParams.set("prompt", promptValues.join(" "))

  return authorizationUrl
}

function requiresManualClientInput(form: ParsedMcpForm) {
  if (form.oauth.clientId && form.oauth.clientSecret) {
    return false
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
      input.runtime.authorizationUrl = applyProviderAuthorizationURLCompat(authorizationUrl)
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
  return pendingOAuthStateSchema.parse(JSON.parse(Buffer.from(decrypted).toString("utf8")))
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

function oauthError(input: {
  code: OAuthFlowErrorCode
  message: string
  flowId?: string
  field?: OAuthErrorFieldName
}): OAuthFlowError {
  return input
}

function normalizeOAuthError(error: unknown, fallback: OAuthFlowErrorCode): OAuthFlowError {
  if (error instanceof OAuthError) {
    if (
      error.code === OAuthErrorCode.InvalidClient &&
      error.message.includes("Client ID and client secret are required")
    ) {
      return oauthError({
        code: "manual_client_credentials_required",
        field: oauthErrorFieldNames[0],
        message:
          "This MCP server requires client credentials for re-authorization. Enter the client ID and client secret to continue.",
      })
    }
    return oauthError({
      code: fallback,
      message: error.message,
    })
  }

  if (error instanceof Error) {
    return oauthError({
      code: fallback,
      message: error.message,
    })
  }

  return oauthError({
    code: fallback,
    message: "OAuth flow could not be completed.",
  })
}

function registrationPayload(clientInformation: OAuthClientInformationMixed) {
  const jsonValueSchema: z.ZodType<JsonObject[keyof JsonObject]> = z.lazy(() =>
    z.union([
      z.boolean(),
      z.number(),
      z.string(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema),
    ])
  )
  const registrationSchema = z.record(z.string(), jsonValueSchema)
  const parsed = registrationSchema.safeParse(clientInformation)
  if (!parsed.success) {
    return undefined
  }
  return parsed.data satisfies JsonObject
}

function incompleteOAuthError(flowId: string, message: string): OAuthFlowError {
  return oauthError({
    code: "oauth_not_ready",
    flowId,
    message,
  })
}

export async function beginOAuthFlow(
  operation: PendingOAuthOperation
): Promise<OAuthResult<BeginOAuthFlowValue>> {
  const state = randomBytes(24).toString("base64url")
  const flowId = randomBytes(18).toString("base64url")
  try {
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
      return {
        ok: false,
        error: incompleteOAuthError(flowId, "OAuth authorization redirect could not be started."),
      }
    }

    if (!runtime.clientInformation) {
      return {
        ok: false,
        error: incompleteOAuthError(
          flowId,
          "OAuth client registration did not produce client information."
        ),
      }
    }

    const pending = {
      version: 1,
      flowId,
      operation,
      state,
      codeVerifier: runtime.codeVerifier,
      // Only store the minimal discovery identifiers in the cookie.
      // The library re-discovers the full authorizationServerMetadata
      // and resourceMetadata during completeOAuthFlow if they are absent
      // (see @modelcontextprotocol/client authInternal).
      discoveryState: runtime.discoveryState
        ? {
            authorizationServerUrl: runtime.discoveryState.authorizationServerUrl,
            resourceMetadataUrl: runtime.discoveryState.resourceMetadataUrl,
          }
        : undefined,
      clientInformation: runtime.clientInformation,
    } satisfies PendingOAuthState
    const sealed = await sealPendingOAuthState(pending)
    if (sealed.length > oauthPendingCookieBudget) {
      return {
        ok: false,
        error: oauthError({
          code: "cookie_too_large",
          flowId,
          message: "OAuth flow could not be started because the pending state is too large.",
        }),
      }
    }

    return {
      ok: true,
      value: {
        authorizationURL: runtime.authorizationUrl,
        pending,
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        ...normalizeOAuthError(error, "oauth_start_failed"),
        flowId,
      },
    }
  }
}

export async function completeOAuthFlow(input: {
  pending: PendingOAuthState
  callbackURL: URL
}): Promise<OAuthResult<CompleteOAuthFlowValue>> {
  const stateParam = input.callbackURL.searchParams.get("state")
  if (!stateParam) {
    return {
      ok: false,
      error: oauthError({
        code: "callback_missing_state",
        flowId: input.pending.flowId,
        message: "OAuth callback is missing state.",
      }),
    }
  }
  if (!timingSafeEqual(Buffer.from(stateParam), Buffer.from(input.pending.state))) {
    return {
      ok: false,
      error: oauthError({
        code: "callback_state_invalid",
        flowId: input.pending.flowId,
        message: "OAuth callback state is invalid.",
      }),
    }
  }

  const code = input.callbackURL.searchParams.get("code")
  if (!code) {
    const error = input.callbackURL.searchParams.get("error")
    const description = input.callbackURL.searchParams.get("error_description")
    if (error) {
      return {
        ok: false,
        error: oauthError({
          code: "callback_provider_error",
          flowId: input.pending.flowId,
          message: description ? `${error}: ${description}` : error,
        }),
      }
    }
    return {
      ok: false,
      error: oauthError({
        code: "callback_missing_code",
        flowId: input.pending.flowId,
        message: "OAuth callback is missing code.",
      }),
    }
  }

  try {
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
      return {
        ok: false,
        error: incompleteOAuthError(input.pending.flowId, "OAuth callback could not be completed."),
      }
    }

    const refreshWarning = runtime.tokens.refresh_token
      ? undefined
      : "OAuth completed without a refresh token. You may need to reconnect later."

    return {
      ok: true,
      value: {
        flowId: input.pending.flowId,
        auth: oauthAuthFromPending(runtime.discoveryState, input.pending.operation.form),
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
              ? registrationPayload(input.pending.clientInformation)
              : undefined,
        }),
        message: refreshWarning ?? "OAuth flow completed.",
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        ...normalizeOAuthError(error, "oauth_complete_failed"),
        flowId: input.pending.flowId,
      },
    }
  }
}

export function discoveredOAuthAuth(
  discoveryState: StoredOAuthDiscoveryState
): DiscoverOAuthAuthValue {
  return {
    issuer:
      discoveryState.authorizationServerMetadata?.issuer ?? discoveryState.authorizationServerUrl,
    authorization_endpoint: discoveryState.authorizationServerMetadata?.authorization_endpoint,
    token_endpoint: discoveryState.authorizationServerMetadata?.token_endpoint,
    registration_endpoint: discoveryState.authorizationServerMetadata?.registration_endpoint,
    resource: discoveryState.resourceMetadata?.resource,
    scopes: discoveryState.resourceMetadata?.scopes_supported,
    location: mcpAuthLocation(),
  }
}

export function oauthAuthFromPending(
  discoveryState: StoredOAuthDiscoveryState,
  form: ParsedMcpForm
): McpConnectionAuth {
  const discovered = discoveredOAuthAuth(discoveryState)

  return {
    oauth: {
      issuer: form.oauth.issuer ?? discovered.issuer,
      authorization_endpoint: form.oauth.authorizationEndpoint ?? discovered.authorization_endpoint,
      token_endpoint: form.oauth.tokenEndpoint ?? discovered.token_endpoint,
      registration_endpoint: form.oauth.registrationEndpoint ?? discovered.registration_endpoint,
      resource: form.oauth.resource ?? discovered.resource,
      scopes: form.oauth.scopes ?? discovered.scopes,
      location: form.oauth.location ?? discovered.location,
    },
  }
}

export function oauthCallbackResultPage(input: {
  success: boolean
  flowId: string
  message: string
}) {
  const payload = JSON.stringify({
    source: oauthWindowMessageSource,
    kind: "result",
    flowId: input.flowId,
    status: input.success ? "success" : "error",
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
