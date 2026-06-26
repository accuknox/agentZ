import "server-only"

import {
  auth,
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  type FetchLike,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/client"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import ipaddr from "ipaddr.js"
import * as z from "zod"
import type { JsonObject, McpConnectionAuth } from "@/lib/gateway/client"
import { getEnv } from "@/lib/env"
import {
  defaultMcpAuthLocation,
  oauthCredentialsFromTokens,
  type ParsedMcpForm,
} from "@/data/mcp.schema"
import { serverWebBaseURL } from "@/lib/gateway/server-base-url"
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

export type PendingOAuthOperation = PendingCreateOperation
export type PendingOAuthInitiator = {
  organizationId: string
  sessionId: string
  userId: string
}

const httpsURLSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value)
  if (url.protocol !== "https:") {
    ctx.addIssue({
      code: "custom",
      message: "URL must use HTTPS",
    })
  }
  if (url.username || url.password) {
    ctx.addIssue({
      code: "custom",
      message: "URL must not include credentials",
    })
  }
})

const storedOAuthProtectedResourceMetadataSchema = z
  .object({
    resource: httpsURLSchema,
    authorization_servers: z.array(httpsURLSchema).optional(),
    scopes_supported: z.array(z.string().min(1)).optional(),
  })
  .passthrough()

const storedAuthorizationServerMetadataSchema = z
  .object({
    issuer: httpsURLSchema,
    authorization_endpoint: httpsURLSchema,
    token_endpoint: httpsURLSchema,
    registration_endpoint: httpsURLSchema.optional(),
    scopes_supported: z.array(z.string().min(1)).optional(),
    response_types_supported: z.array(z.string().min(1)),
    response_modes_supported: z.array(z.string().min(1)).optional(),
    grant_types_supported: z.array(z.string().min(1)).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
    token_endpoint_auth_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
    service_documentation: httpsURLSchema.optional(),
    revocation_endpoint: httpsURLSchema.optional(),
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
  name: z.string().min(1),
  endpoint: z.object({
    url: httpsURLSchema,
    timeout: z.string().min(1).optional(),
    insecure_skip_verify: z.boolean(),
    headers: z.record(z.string(), z.string()),
  }),
  authMode: z.enum(["bearer", "oauth"]),
  bearerToken: z.string().min(1).optional(),
  bearerLocation: z
    .object({
      header: z
        .object({
          name: z.string().min(1),
          prefix: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  oauth: z.object({
    issuer: httpsURLSchema.optional(),
    authorizationEndpoint: httpsURLSchema.optional(),
    tokenEndpoint: httpsURLSchema.optional(),
    registrationEndpoint: httpsURLSchema.optional(),
    resource: httpsURLSchema.optional(),
    scopes: z.array(z.string().min(1)).optional(),
    location: z
      .object({
        header: z
          .object({
            name: z.string().min(1),
            prefix: z.string().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  }),
})

const pendingOAuthOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
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
  authorizationServerUrl: httpsURLSchema,
  resourceMetadataUrl: httpsURLSchema.optional(),
  resourceMetadata: storedOAuthProtectedResourceMetadataSchema.optional(),
  authorizationServerMetadata: storedAuthorizationServerMetadataSchema.optional(),
})

const pendingOAuthStateSchema = z.object({
  version: z.literal(1),
  flowId: z.string().min(1),
  initiator: z.object({
    organizationId: z.string().min(1),
    sessionId: z.string().min(1),
    userId: z.string().min(1),
  }),
  operation: pendingOAuthOperationSchema,
  state: z.string().min(1),
  redirectURL: z.url().optional(),
  codeVerifier: z.string().min(1),
  discoveryState: oauthDiscoveryStateSchema.optional(),
  clientInformation: oauthClientInformationMixedSchema,
})

export type PendingOAuthState = {
  version: 1
  flowId: string
  initiator: PendingOAuthInitiator
  operation: PendingOAuthOperation
  state: string
  redirectURL?: string
  codeVerifier: string
  discoveryState?: StoredOAuthDiscoveryState
  clientInformation: OAuthClientInformationMixed
}

export type StoredOAuthDiscoveryState = z.infer<typeof oauthDiscoveryStateSchema>
type DiscoverOAuthAuthValue = NonNullable<McpConnectionAuth["oauth"]>
export type OAuthDiscoveryValue = {
  oauth: DiscoverOAuthAuthValue
  defaultScopes?: string[]
  supportedScopes?: string[]
}

type OAuthFlowErrorCode =
  | "cookie_too_large"
  | "callback_missing_state"
  | "callback_state_invalid"
  | "callback_missing_code"
  | "callback_provider_error"
  | "oauth_not_ready"
  | "oauth_start_failed"
  | "oauth_complete_failed"
  | "manual_client_credentials_required"

type OAuthFlowError = {
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

export function parseStoredOAuthDiscoveryState(input: unknown): StoredOAuthDiscoveryState {
  return oauthDiscoveryStateSchema.parse(input)
}

export const mcpOAuthCookieName = "clawarmor-mcp-oauth"
const oauthCookieTTLSeconds = 15 * 60
const googleAuthorizationHosts = new Set(["accounts.google.com"])
const dropboxAuthorizationHosts = new Set(["www.dropbox.com", "dropbox.com"])

// requirePublicOAuthURL keeps OAuth discovery, registration, and token exchange
// from becoming authenticated SSRF primitives.
export async function requirePublicOAuthURL(input: string | URL, label: string) {
  const url = input instanceof URL ? input : new URL(input)
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`)
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`)
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`${label} must resolve to a public address`)
  }

  try {
    if (ipaddr.process(hostname).range() === "unicast") {
      return url
    }
    throw new Error(`${label} must resolve to a public address`)
  } catch (error) {
    if (ipaddr.isValid(hostname)) {
      throw error
    }
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: false })
  } catch {
    throw new Error(`${label} could not be resolved`)
  }
  if (addresses.length === 0) {
    throw new Error(`${label} could not be resolved`)
  }
  for (const { address } of addresses) {
    try {
      if (ipaddr.process(address).range() === "unicast") {
        continue
      }
    } catch {
      throw new Error(`${label} must resolve to a public address`)
    }
    throw new Error(`${label} must resolve to a public address`)
  }

  return url
}

export const publicOAuthFetch: FetchLike = async (input, init) => {
  const fetchInit: RequestInit = {
    ...init,
    cache: "no-store",
    redirect: "error",
  }

  if (input instanceof Request) {
    await requirePublicOAuthURL(input.url, "OAuth fetch URL")
    return fetch(input, fetchInit)
  }

  await requirePublicOAuthURL(input, "OAuth fetch URL")
  return fetch(input, fetchInit)
}

export async function requirePublicOAuthDiscoveryState(discoveryState: StoredOAuthDiscoveryState) {
  const checks: [string | undefined, string][] = [
    [discoveryState.authorizationServerUrl, "OAuth issuer URL"],
    [discoveryState.resourceMetadataUrl, "OAuth resource metadata URL"],
    [discoveryState.resourceMetadata?.resource, "OAuth resource URL"],
    [discoveryState.authorizationServerMetadata?.issuer, "OAuth issuer URL"],
    [discoveryState.authorizationServerMetadata?.authorization_endpoint, "OAuth authorization URL"],
    [discoveryState.authorizationServerMetadata?.token_endpoint, "OAuth token URL"],
    [discoveryState.authorizationServerMetadata?.registration_endpoint, "OAuth registration URL"],
  ]
  for (const authorizationServer of discoveryState.resourceMetadata?.authorization_servers ?? []) {
    checks.push([authorizationServer, "OAuth issuer URL"])
  }
  for (const [value, label] of checks) {
    if (!value) {
      continue
    }
    await requirePublicOAuthURL(value, label)
  }
}

function secretKeyMaterial() {
  return createHash("sha256").update(getEnv().MCP_OAUTH_COOKIE_SECRET).digest()
}

function redirectURL() {
  return new URL("/mcps/oauth/callback", serverWebBaseURL())
}

function oauthClientMetadata(redirectURL: URL): OAuthClientMetadata {
  const base = new URL("/", redirectURL)
  return {
    client_name: "AccuKnox ClawArmor MCP Gateway",
    redirect_uris: [redirectURL.toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope: "offline_access",
    client_uri: base.toString(),
  }
}

function applyProviderAuthorizationURLCompat(authorizationUrl: URL) {
  if (googleAuthorizationHosts.has(authorizationUrl.hostname)) {
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
  }

  if (
    dropboxAuthorizationHosts.has(authorizationUrl.hostname) &&
    !authorizationUrl.searchParams.has("token_access_type")
  ) {
    authorizationUrl.searchParams.set("token_access_type", "offline")
  }

  return authorizationUrl
}

function requiresManualClientInput(form: ParsedMcpForm) {
  if (form.oauth.clientId && form.oauth.clientSecret) {
    return false
  }
  return !form.oauth.clientId && !form.oauth.clientSecret
}

function oauthResourceURL(input: {
  form: ParsedMcpForm
  serverUrl: string | URL
  discoveredResource?: string
}) {
  if (input.form.oauth.resource) {
    return new URL(input.form.oauth.resource)
  }

  if (!input.discoveredResource) {
    return undefined
  }

  const defaultResource = resourceUrlFromServerUrl(input.serverUrl)
  if (
    !checkResourceAllowed({
      requestedResource: defaultResource,
      configuredResource: input.discoveredResource,
    })
  ) {
    throw new Error(
      `Protected resource ${input.discoveredResource} does not match expected ${defaultResource} (or origin)`
    )
  }

  return new URL(input.discoveredResource)
}

function hasOAuthDiscoveryOverrides(form: ParsedMcpForm) {
  return Boolean(
    form.oauth.issuer ||
    form.oauth.authorizationEndpoint ||
    form.oauth.tokenEndpoint ||
    form.oauth.registrationEndpoint ||
    form.oauth.resource
  )
}

function mergeDiscoveryStateWithForm(input: {
  form: ParsedMcpForm
  discoveryState: StoredOAuthDiscoveryState
}): StoredOAuthDiscoveryState {
  const { form, discoveryState } = input
  const authorizationServerUrl = form.oauth.issuer ?? discoveryState.authorizationServerUrl
  const authorizationServerMetadata = discoveryState.authorizationServerMetadata
    ? {
        ...discoveryState.authorizationServerMetadata,
        issuer:
          form.oauth.issuer ??
          discoveryState.authorizationServerMetadata.issuer ??
          authorizationServerUrl,
        authorization_endpoint:
          form.oauth.authorizationEndpoint ??
          discoveryState.authorizationServerMetadata.authorization_endpoint,
        token_endpoint:
          form.oauth.tokenEndpoint ?? discoveryState.authorizationServerMetadata.token_endpoint,
        registration_endpoint:
          form.oauth.registrationEndpoint ??
          discoveryState.authorizationServerMetadata.registration_endpoint,
      }
    : undefined

  return {
    ...discoveryState,
    authorizationServerUrl,
    authorizationServerMetadata,
    resourceMetadata: form.oauth.resource
      ? {
          ...discoveryState.resourceMetadata,
          resource: form.oauth.resource,
        }
      : discoveryState.resourceMetadata,
  }
}

async function effectiveDiscoveryState(input: {
  form: ParsedMcpForm
  discoveryState?: StoredOAuthDiscoveryState
}) {
  const { form } = input
  let discoveryState = input.discoveryState

  if (!discoveryState && !hasOAuthDiscoveryOverrides(form)) {
    return undefined
  }

  if (!discoveryState) {
    const authorizationServerUrl = form.oauth.issuer
    if (!authorizationServerUrl) {
      return undefined
    }
    const publicAuthorizationServerURL = await requirePublicOAuthURL(
      authorizationServerUrl,
      "OAuth issuer URL"
    )

    discoveryState = {
      authorizationServerUrl: publicAuthorizationServerURL.toString(),
      authorizationServerMetadata: await discoverAuthorizationServerMetadata(
        publicAuthorizationServerURL.toString(),
        { fetchFn: publicOAuthFetch }
      ),
      resourceMetadata: undefined,
      resourceMetadataUrl: undefined,
    }
  }

  if (!discoveryState.authorizationServerMetadata) {
    const publicAuthorizationServerURL = await requirePublicOAuthURL(
      discoveryState.authorizationServerUrl,
      "OAuth issuer URL"
    )
    discoveryState = {
      ...discoveryState,
      authorizationServerMetadata: await discoverAuthorizationServerMetadata(
        publicAuthorizationServerURL.toString(),
        { fetchFn: publicOAuthFetch }
      ),
    }
  }

  const merged = mergeDiscoveryStateWithForm({
    form,
    discoveryState,
  })
  await requirePublicOAuthDiscoveryState(merged)
  return merged
}

function oauthProvider(input: {
  form: ParsedMcpForm
  runtime: RuntimeOAuthState
  state: string
  redirectURL: URL
}) {
  const metadata = oauthClientMetadata(input.redirectURL)

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return input.redirectURL
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
    async validateResourceURL(serverUrl, discoveredResource) {
      const resourceURL = oauthResourceURL({
        form: input.form,
        serverUrl,
        discoveredResource,
      })
      if (resourceURL) {
        await requirePublicOAuthURL(resourceURL, "OAuth resource URL")
      }
      return resourceURL
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
  return `${iv.toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`
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
    { name: "AES-GCM", iv: Buffer.from(ivPart, "base64url") },
    key,
    Buffer.from(ciphertextPart, "base64url")
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

function oauthFlowErrorFrom(error: unknown, fallback: OAuthFlowErrorCode): OAuthFlowError {
  if (error instanceof OAuthError) {
    if (
      error.code === OAuthErrorCode.InvalidClient &&
      error.message.includes("Client ID and client secret are required")
    ) {
      return {
        code: "manual_client_credentials_required",
        field: oauthErrorFieldNames[0],
        message:
          "This MCP server requires client credentials for re-authorization. Enter the client ID and client secret to continue.",
      }
    }
    return {
      code: fallback,
      message: error.message,
    }
  }

  if (error instanceof Error) {
    return {
      code: fallback,
      message: error.message,
    }
  }

  return {
    code: fallback,
    message: "OAuth flow could not be completed.",
  }
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

function scriptJSON(value: unknown) {
  const json = JSON.stringify(value)
  if (json === undefined) {
    return "null"
  }

  return json.replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c"
      case ">":
        return "\\u003e"
      case "&":
        return "\\u0026"
      case "\u2028":
        return "\\u2028"
      case "\u2029":
        return "\\u2029"
      default:
        return char
    }
  })
}

export async function beginOAuthFlow(input: {
  initiator: PendingOAuthInitiator
  operation: PendingOAuthOperation
}): Promise<OAuthResult<BeginOAuthFlowValue>> {
  const state = randomBytes(24).toString("base64url")
  const flowId = randomBytes(18).toString("base64url")
  const oauthRedirectURL = redirectURL()
  try {
    const serverURL = await requirePublicOAuthURL(
      input.operation.form.endpoint.url,
      "MCP server URL"
    )
    const runtime: RuntimeOAuthState = {
      discoveryState: await effectiveDiscoveryState({
        form: input.operation.form,
      }),
    }
    if (requiresManualClientInput(input.operation.form)) {
      if (!runtime.discoveryState) {
        runtime.discoveryState = await discoverOAuthServerInfo(serverURL.toString(), {
          fetchFn: publicOAuthFetch,
        })
      }

      runtime.discoveryState = await effectiveDiscoveryState({
        form: input.operation.form,
        discoveryState: runtime.discoveryState,
      })
      if (!runtime.discoveryState?.authorizationServerMetadata?.registration_endpoint) {
        throw new OAuthError(
          OAuthErrorCode.InvalidClient,
          "Client ID and client secret are required because this MCP server does not support dynamic client registration."
        )
      }
    }
    const provider = oauthProvider({
      form: input.operation.form,
      runtime,
      redirectURL: oauthRedirectURL,
      state,
    })

    const result = await auth(provider, {
      serverUrl: serverURL.toString(),
      scope: input.operation.form.oauth.scopes?.join(" "),
      fetchFn: publicOAuthFetch,
    })
    if (result !== "REDIRECT" || !runtime.authorizationUrl || !runtime.codeVerifier) {
      return {
        ok: false,
        error: {
          code: "oauth_not_ready",
          flowId,
          message: "OAuth authorization redirect could not be started.",
        },
      }
    }

    if (!runtime.clientInformation) {
      return {
        ok: false,
        error: {
          code: "oauth_not_ready",
          flowId,
          message: "OAuth client registration did not produce client information.",
        },
      }
    }

    const pending = {
      version: 1,
      flowId,
      initiator: input.initiator,
      operation: input.operation,
      state,
      // Reuse the exact redirect URL on the callback exchange because the
      // incoming request URL may reflect an internal proxy address.
      redirectURL: oauthRedirectURL.toString(),
      codeVerifier: runtime.codeVerifier,
      // Persist only compact discovery identifiers. The callback rebuilds
      // the effective discovery state from these identifiers plus form values.
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
        error: {
          code: "cookie_too_large",
          flowId,
          message: "OAuth flow could not be started because the pending state is too large.",
        },
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
        ...oauthFlowErrorFrom(error, "oauth_start_failed"),
        flowId,
      },
    }
  }
}

export async function completeOAuthFlow(input: {
  pending: PendingOAuthState
  callbackURL: URL
}): Promise<OAuthResult<CompleteOAuthFlowValue>> {
  const callbackRedirectURL = input.pending.redirectURL
    ? new URL(input.pending.redirectURL)
    : redirectURL()
  const stateParam = input.callbackURL.searchParams.get("state")
  if (!stateParam) {
    return {
      ok: false,
      error: {
        code: "callback_missing_state",
        flowId: input.pending.flowId,
        message: "OAuth callback is missing state.",
      },
    }
  }
  const callbackState = Buffer.from(stateParam)
  const pendingState = Buffer.from(input.pending.state)
  if (
    callbackState.length !== pendingState.length ||
    !timingSafeEqual(callbackState, pendingState)
  ) {
    return {
      ok: false,
      error: {
        code: "callback_state_invalid",
        flowId: input.pending.flowId,
        message: "OAuth callback state is invalid.",
      },
    }
  }

  const code = input.callbackURL.searchParams.get("code")
  if (!code) {
    const error = input.callbackURL.searchParams.get("error")
    const description = input.callbackURL.searchParams.get("error_description")
    if (error) {
      return {
        ok: false,
        error: {
          code: "callback_provider_error",
          flowId: input.pending.flowId,
          message: description ? `${error}: ${description}` : error,
        },
      }
    }
    return {
      ok: false,
      error: {
        code: "callback_missing_code",
        flowId: input.pending.flowId,
        message: "OAuth callback is missing code.",
      },
    }
  }

  try {
    const serverURL = await requirePublicOAuthURL(
      input.pending.operation.form.endpoint.url,
      "MCP server URL"
    )
    const runtime: RuntimeOAuthState = {
      codeVerifier: input.pending.codeVerifier,
      clientInformation: input.pending.clientInformation,
      discoveryState: await effectiveDiscoveryState({
        form: input.pending.operation.form,
        discoveryState: input.pending.discoveryState,
      }),
    }
    const provider = oauthProvider({
      form: input.pending.operation.form,
      runtime,
      redirectURL: callbackRedirectURL,
      state: input.pending.state,
    })

    const result = await auth(provider, {
      serverUrl: serverURL.toString(),
      authorizationCode: code,
      scope: input.pending.operation.form.oauth.scopes?.join(" "),
      fetchFn: publicOAuthFetch,
    })
    if (result !== "AUTHORIZED" || !runtime.tokens || !runtime.discoveryState) {
      return {
        ok: false,
        error: {
          code: "oauth_not_ready",
          flowId: input.pending.flowId,
          message: "OAuth callback could not be completed.",
        },
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
        ...oauthFlowErrorFrom(error, "oauth_complete_failed"),
        flowId: input.pending.flowId,
      },
    }
  }
}

function discoveredOAuthAuth(discoveryState: StoredOAuthDiscoveryState): DiscoverOAuthAuthValue {
  return {
    issuer:
      discoveryState.authorizationServerMetadata?.issuer ?? discoveryState.authorizationServerUrl,
    authorization_endpoint: discoveryState.authorizationServerMetadata?.authorization_endpoint,
    token_endpoint: discoveryState.authorizationServerMetadata?.token_endpoint,
    registration_endpoint: discoveryState.authorizationServerMetadata?.registration_endpoint,
    resource: discoveryState.resourceMetadata?.resource,
    location: defaultMcpAuthLocation,
  }
}

export function discoveredOAuth(discoveryState: StoredOAuthDiscoveryState): OAuthDiscoveryValue {
  const defaultScopes = discoveryState.resourceMetadata?.scopes_supported
  const supportedScopeSet = new Set<string>(defaultScopes ?? [])
  for (const scope of discoveryState.authorizationServerMetadata?.scopes_supported ?? []) {
    supportedScopeSet.add(scope)
  }

  let supportedScopes: string[] | undefined
  if (supportedScopeSet.size > 0) {
    supportedScopes = Array.from(supportedScopeSet)
  }

  return {
    oauth: discoveredOAuthAuth(discoveryState),
    defaultScopes,
    supportedScopes,
  }
}

function oauthAuthFromPending(
  discoveryState: StoredOAuthDiscoveryState,
  form: ParsedMcpForm
): McpConnectionAuth {
  const discovered = discoveredOAuth(discoveryState).oauth

  return {
    oauth: {
      issuer: form.oauth.issuer ?? discovered.issuer,
      authorization_endpoint: form.oauth.authorizationEndpoint ?? discovered.authorization_endpoint,
      token_endpoint: form.oauth.tokenEndpoint ?? discovered.token_endpoint,
      registration_endpoint: form.oauth.registrationEndpoint ?? discovered.registration_endpoint,
      resource: form.oauth.resource ?? discovered.resource,
      scopes: form.oauth.scopes,
      location: form.oauth.location ?? discovered.location,
    },
  }
}

export function oauthCallbackResultPage(input: {
  success: boolean
  flowId: string
  message: string
}) {
  const payload = scriptJSON({
    source: oauthWindowMessageSource,
    kind: "result",
    flowId: input.flowId,
    status: input.success ? "success" : "error",
    message: input.message,
  } satisfies OAuthPopupMessage)
  const message = scriptJSON(input.message)
  const channelName = scriptJSON(oauthBroadcastChannelName)

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
      const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(${channelName}) : null;
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
