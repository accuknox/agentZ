import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { and, desc, eq, gt, isNull, isNotNull, or } from "drizzle-orm"
import { NextRequest } from "next/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { currentGatewayAuthContext, getGatewayAuthToken } from "@/lib/gateway/auth"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { listAgents, type MobilePairing, type MobileToken } from "@/lib/gateway/client"
import { createClient } from "@/lib/gateway/client/client"
import { zMobileCredential, zMobilePairRequest } from "@/lib/gateway/client/zod.gen"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

type RouteContext = { params: Promise<{ path?: string[] }> }

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path = [] } = await context.params
  const db = getDB()
  const origin = getEnv().BETTER_AUTH_URL
  const mobileOrigin = request.headers.get("origin")
  const browserMutation = request.method !== "GET" && request.method !== "OPTIONS"
  const phoneOperation =
    (path[0] === "token" && (request.method === "POST" || request.method === "DELETE")) ||
    (path[0] === "pairing" && path.length === 2 && request.method === "POST")
  const ownerOperation = !phoneOperation
  if (browserMutation && ownerOperation && mobileOrigin && mobileOrigin !== origin) {
    return Response.json({ message: "This request must come from AgentZ." }, { status: 403 })
  }
  try {
    if (request.method === "GET" && path[0] === "pairing" && path.length === 1) {
      const actor = await currentGatewayAuthContext()
      const query = zMobilePairRequest.parse(Object.fromEntries(request.nextUrl.searchParams))
      const [phone] = await db
        .select({ id: schema.mobileConnections.id })
        .from(schema.mobileConnections)
        .innerJoin(
          schema.mobileConversations,
          eq(schema.mobileConversations.id, schema.mobileConnections.conversationId)
        )
        .where(
          and(
            eq(schema.mobileConversations.userId, actor.userId),
            eq(schema.mobileConversations.workspaceId, query.workspace_id),
            eq(schema.mobileConversations.agentName, query.agent_name),
            isNotNull(schema.mobileConnections.approvedAt),
            isNull(schema.mobileConnections.revokedAt),
            gt(schema.mobileConnections.expiresAt, new Date())
          )
        )
        .orderBy(desc(schema.mobileConnections.createdAt))
        .limit(1)
      if (!phone) return new Response(null, { status: 204 })
      return new Response(null, {
        status: 307,
        headers: { Location: `${origin}/api/mobile/pairing/${phone.id}` },
      })
    }
    if (request.method === "POST" && path[0] === "pairing" && path.length === 1) {
      const body = zMobilePairRequest.parse(await request.json())
      const actor = await currentGatewayAuthContext()
      const token = await getGatewayAuthToken(
        actor.organizationId,
        actor.userId,
        actor.userName,
        body.workspace_id
      )
      const agents = await listAgents({
        client: createClient({ baseUrl: serverGatewayBaseURL(), auth: token }),
        headers: { "X-AgentZ-Workspace-ID": body.workspace_id },
        query: { agent_name: [body.agent_name], limit: 200 },
      })
      if (agents.error) return Response.json({ message: agents.error.message }, { status: 403 })
      const agent = agents.data.agents.find((item) => item.name === body.agent_name)
      if (!agent?.capabilities.use || !agent.uid) {
        return Response.json({ message: "This agent is unavailable for pairing." }, { status: 403 })
      }
      const agentUid = agent.uid
      const [workspace] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, body.workspace_id))
      if (workspace?.type !== "general") {
        return Response.json({ message: "Connect a general-purpose agent." }, { status: 400 })
      }
      const recent = await db
        .select({ id: schema.mobileConnections.id })
        .from(schema.mobileConnections)
        .innerJoin(
          schema.mobileConversations,
          eq(schema.mobileConversations.id, schema.mobileConnections.conversationId)
        )
        .where(
          and(
            eq(schema.mobileConversations.userId, actor.userId),
            gt(schema.mobileConnections.createdAt, new Date(Date.now() - 60_000))
          )
        )
        .limit(6)
      if (recent.length >= 6)
        return Response.json(
          { message: "Wait a minute before creating another QR." },
          { status: 429 }
        )
      const identity = and(
        eq(schema.mobileConversations.userId, actor.userId),
        eq(schema.mobileConversations.workspaceId, body.workspace_id),
        eq(schema.mobileConversations.agentUid, agentUid)
      )
      const conversation = await db.transaction(async (tx) => {
        await tx
          .insert(schema.mobileConversations)
          .values({
            id: randomUUID(),
            userId: actor.userId,
            organizationId: actor.organizationId,
            workspaceId: body.workspace_id,
            agentName: agent.name,
            agentUid,
            sessionId: "",
          })
          .onConflictDoNothing()
        const [current] = await tx
          .select()
          .from(schema.mobileConversations)
          .where(identity)
          .for("update")
        if (!current) throw new Error("Conversation is unavailable.")
        if (current.sessionId) return current
        const client = createOpencodeClient({
          baseUrl: `${serverGatewayBaseURL()}/api/opencode/${encodeURIComponent(agent.name)}`,
          headers: { Authorization: `Bearer ${token}`, "X-AgentZ-Workspace-ID": body.workspace_id },
        })
        const config = await client.config.get({}, { throwOnError: true })
        const model = config.data.model
        if (!model) throw new Error("Configure a default model for this agent.")
        const separator = model.indexOf("/")
        const session = await client.session.create(
          {
            title: "Your conversation",
            model: { providerID: model.slice(0, separator), id: model.slice(separator + 1) },
          },
          { throwOnError: true }
        )
        await tx
          .update(schema.mobileConversations)
          .set({ sessionId: session.data.id })
          .where(eq(schema.mobileConversations.id, current.id))
        return { ...current, sessionId: session.data.id }
      })
      const id = randomBytes(24).toString("hex")
      const now = Date.now()
      await db.insert(schema.mobileConnections).values({
        id,
        conversationId: conversation.id,
        code: randomInt(100000, 1000000).toString(),
        pairingExpiresAt: new Date(now + 120_000),
        expiresAt: new Date(now + 30 * 86400_000),
      })
      const result: MobilePairing = {
        id,
        agent_name: agent.name,
        code: "",
        status: "pending",
        expires_at: new Date(now + 120_000).toISOString(),
        link: `${origin}/api/mobile/pairing/${id}`,
      }
      return Response.json(result)
    }

    if (phoneOperation) {
      const body = zMobileCredential.parse(await request.json())
      if (path[1] && body.id !== path[1])
        return Response.json({ message: "Invalid invitation." }, { status: 400 })
      const deviceHash = createHash("sha256").update(body.secret).digest("hex")
      if (path[0] === "pairing") {
        await db
          .update(schema.mobileConnections)
          .set({ deviceHash })
          .where(
            and(
              eq(schema.mobileConnections.id, body.id),
              isNull(schema.mobileConnections.revokedAt),
              isNull(schema.mobileConnections.approvedAt),
              gt(schema.mobileConnections.pairingExpiresAt, new Date()),
              or(
                isNull(schema.mobileConnections.deviceHash),
                eq(schema.mobileConnections.deviceHash, deviceHash)
              )
            )
          )
      }
      const [entry] = await db
        .select()
        .from(schema.mobileConnections)
        .innerJoin(
          schema.mobileConversations,
          eq(schema.mobileConversations.id, schema.mobileConnections.conversationId)
        )
        .where(
          and(
            eq(schema.mobileConnections.id, body.id),
            eq(schema.mobileConnections.deviceHash, deviceHash),
            isNull(schema.mobileConnections.revokedAt),
            gt(schema.mobileConnections.expiresAt, new Date())
          )
        )
      if (!entry)
        return Response.json(
          { message: "This connection is unavailable. Scan a new QR." },
          { status: 401 }
        )
      const { mobile_connections: phone, mobile_conversations: conversation } = entry
      if (!phone.approvedAt && phone.pairingExpiresAt.getTime() <= Date.now()) {
        return Response.json({ message: "This QR expired. Generate a new one." }, { status: 410 })
      }
      if (request.method === "DELETE") {
        await db
          .update(schema.mobileConnections)
          .set({ revokedAt: new Date() })
          .where(eq(schema.mobileConnections.id, body.id))
        return new Response(null, { status: 204 })
      }
      if (path[0] === "pairing") {
        const result: MobilePairing = {
          id: phone.id,
          agent_name: conversation.agentName,
          code: phone.code,
          status: phone.approvedAt ? "approved" : "waiting",
          expires_at: phone.pairingExpiresAt.toISOString(),
          link: `${origin}/api/mobile/pairing/${phone.id}`,
        }
        return Response.json(result)
      }
      if (!phone.approvedAt)
        return Response.json({ message: "Approve this phone on the web." }, { status: 425 })
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, conversation.userId))
      if (!user) return Response.json({ message: "Account unavailable." }, { status: 401 })
      const token = await getGatewayAuthToken(
        conversation.organizationId,
        conversation.userId,
        user.name,
        conversation.workspaceId,
        phone.id
      )
      const client = createOpencodeClient({
        baseUrl: `${serverGatewayBaseURL()}/api/opencode/${encodeURIComponent(conversation.agentName)}`,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-AgentZ-Workspace-ID": conversation.workspaceId,
        },
      })
      const session = await client.session.get(
        { sessionID: conversation.sessionId },
        { throwOnError: true }
      )
      const model = session.data.model
      if (!model)
        return Response.json(
          { message: "Configure a default model for this agent." },
          { status: 409 }
        )
      const result: MobileToken = {
        token,
        connection: {
          id: phone.id,
          origin,
          gateway_url: gatewayBaseURL(),
          agent_name: conversation.agentName,
          workspace_id: conversation.workspaceId,
          session_id: conversation.sessionId,
          model: { providerID: model.providerID, modelID: model.id },
        },
      }
      return Response.json(result)
    }

    if (path[0] === "pairing" && path.length === 2) {
      const session = await getAuth().api.getSession({ headers: request.headers })
      if (!session) return Response.json({ message: "Sign in to AgentZ." }, { status: 401 })
      const id = path[1]
      if (!id) return Response.json({ message: "Invitation not found." }, { status: 404 })
      const [entry] = await db
        .select()
        .from(schema.mobileConnections)
        .innerJoin(
          schema.mobileConversations,
          eq(schema.mobileConversations.id, schema.mobileConnections.conversationId)
        )
        .where(
          and(
            eq(schema.mobileConnections.id, id),
            eq(schema.mobileConversations.userId, session.user.id)
          )
        )
      if (!entry) return Response.json({ message: "Invitation not found." }, { status: 404 })
      let { mobile_connections: phone } = entry
      if (request.method === "DELETE") {
        await db
          .update(schema.mobileConnections)
          .set({ revokedAt: new Date() })
          .where(eq(schema.mobileConnections.id, id))
        return new Response(null, { status: 204 })
      }
      if (request.method === "PUT") {
        const [approved] = await db
          .update(schema.mobileConnections)
          .set({ approvedAt: new Date() })
          .where(
            and(
              eq(schema.mobileConnections.id, id),
              gt(schema.mobileConnections.pairingExpiresAt, new Date()),
              isNull(schema.mobileConnections.revokedAt),
              eq(schema.mobileConnections.deviceHash, phone.deviceHash ?? "")
            )
          )
          .returning()
        if (!approved)
          return Response.json(
            { message: "This request expired. Generate a new QR." },
            { status: 410 }
          )
        phone = approved
      }
      let status: MobilePairing["status"] = "pending"
      if (phone.deviceHash) status = "waiting"
      if (phone.pairingExpiresAt.getTime() <= Date.now()) status = "expired"
      if (phone.approvedAt) status = "approved"
      if (phone.revokedAt) status = "revoked"
      const result: MobilePairing = {
        id: phone.id,
        agent_name: entry.mobile_conversations.agentName,
        code: phone.deviceHash ? phone.code : "",
        status,
        expires_at: phone.pairingExpiresAt.toISOString(),
        link: `${origin}/api/mobile/pairing/${phone.id}`,
      }
      return Response.json(result)
    }
    return Response.json({ message: "Not found." }, { status: 404 })
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError)
      return Response.json({ message: "Sign in to AgentZ." }, { status: 401 })
    console.error(
      "Mobile connection request failed",
      error instanceof Error ? error.message : "Unknown error"
    )
    return Response.json(
      { message: "The connection could not be completed. Check your agent and try again." },
      { status: 400 }
    )
  }
}

async function route(request: NextRequest, context: RouteContext): Promise<Response> {
  const response =
    request.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : await handle(request, context)
  response.headers.set("Cache-Control", "no-store")
  // Native requests have no Origin. Browser previews receive no cookie access.
  response.headers.set("Access-Control-Allow-Origin", "*")
  response.headers.set("Access-Control-Allow-Headers", "Content-Type")
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  return response
}

export { route as GET, route as POST, route as PUT, route as DELETE, route as OPTIONS }
