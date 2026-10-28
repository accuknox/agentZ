import { fetch } from "expo/fetch"
import * as Crypto from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"
import * as z from "zod/mini"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createClient } from "./gateway/client"
import { zMobileConnection, zMobilePairing, zMobileToken } from "./gateway/zod.gen"
import type { MobilePairing } from "./gateway/types.gen"

const savedConnection = z.object({
  secret: z.string().check(z.length(64)),
  connection: zMobileConnection,
})
export type Connection = z.infer<typeof savedConnection>
export type Pairing = {
  origin: string
  secret: string
  request: MobilePairing
}

export async function restoreConnection(): Promise<Connection | null> {
  const value =
    Platform.OS === "web"
      ? sessionStorage.getItem("agentz.connection")
      : await SecureStore.getItemAsync("agentz.connection")
  if (!value) return null
  const parsed = savedConnection.safeParse(JSON.parse(value))
  if (!parsed.success) return null
  return parsed.data
}

export async function claimConnection(link: string): Promise<Pairing> {
  const url = new URL(link.trim())
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Use the connection link shown in AgentZ.")
  const match = /^\/api\/mobile\/pairing\/([a-f0-9]{48})$/.exec(url.pathname)
  const id = match?.[1]
  if (!id) throw new Error("This is not an AgentZ connection QR.")
  const bytes = await Crypto.getRandomBytesAsync(32)
  const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  const response = await fetch(url.toString(), {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, secret }),
  })
  if (!response.ok)
    throw new Error("This QR expired or was already scanned. Generate a new one in AgentZ.")
  return {
    origin: url.origin,
    secret,
    request: zMobilePairing.parse(await response.json()),
  }
}

export async function finishConnection(pairing: Pairing): Promise<Connection | null> {
  const response = await fetch(`${pairing.origin}/api/mobile/token`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pairing.request.id, secret: pairing.secret }),
  })
  if (response.status === 425) return null
  if (!response.ok) throw new Error("Connection denied or expired. Scan a new QR from AgentZ.")
  const result = zMobileToken.parse(await response.json())
  if (result.connection.origin !== pairing.origin)
    throw new Error("The server returned a different connection origin.")
  const saved: Connection = {
    secret: pairing.secret,
    connection: result.connection,
  }
  const value = JSON.stringify(saved)
  if (Platform.OS === "web") sessionStorage.setItem("agentz.connection", value)
  if (Platform.OS !== "web") await SecureStore.setItemAsync("agentz.connection", value)
  return saved
}

export class AgentClient {
  private token = ""
  private validUntil = 0
  private refresh: Promise<string> | undefined
  readonly gateway
  readonly agent

  constructor(readonly saved: Connection) {
    const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
      const token = await this.accessToken()
      const request = new Request(input, init)
      if (new URL(request.url).origin !== new URL(saved.connection.gateway_url).origin)
        throw new Error("The request does not belong to your gateway.")
      request.headers.set("Authorization", `Bearer ${token}`)
      request.headers.set("X-AgentZ-Workspace-ID", saved.connection.workspace_id)
      return fetch(request)
    }
    this.gateway = createClient({
      baseUrl: saved.connection.gateway_url,
      fetch: authenticatedFetch,
    })
    this.agent = createOpencodeClient({
      baseUrl: `${saved.connection.gateway_url}/api/opencode/${encodeURIComponent(saved.connection.agent_name)}`,
      fetch: authenticatedFetch,
      headers: { "X-AgentZ-Workspace-ID": saved.connection.workspace_id },
    })
  }

  async accessToken(): Promise<string> {
    if (this.validUntil > Date.now()) return this.token
    if (this.refresh) return this.refresh
    this.refresh = (async () => {
      const response = await fetch(`${this.saved.connection.origin}/api/mobile/token`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.saved.connection.id,
          secret: this.saved.secret,
        }),
      })
      if (!response.ok)
        throw new Error(
          response.status === 401 || response.status === 403
            ? "This phone was disconnected. Connect it again from AgentZ."
            : "Your agent is unavailable. Retrying…"
        )
      const result = zMobileToken.parse(await response.json())
      this.token = result.token
      this.validUntil = Date.now() + 100_000
      return this.token
    })()
    try {
      return await this.refresh
    } finally {
      this.refresh = undefined
    }
  }

  async disconnect(): Promise<boolean> {
    try {
      const response = await fetch(`${this.saved.connection.origin}/api/mobile/token`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.saved.connection.id,
          secret: this.saved.secret,
        }),
      })
      return response.ok || response.status === 401
    } catch {
      return false
    } finally {
      this.validUntil = 0
      this.token = ""
      if (Platform.OS === "web") sessionStorage.removeItem("agentz.connection")
      if (Platform.OS !== "web") await SecureStore.deleteItemAsync("agentz.connection")
    }
  }
}
