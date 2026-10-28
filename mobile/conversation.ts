import { AppState } from "react-native"
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite"
import * as Crypto from "expo-crypto"
import type { Message, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { submitChatInput, listChatInputs, updateChatInput } from "./gateway/sdk.gen"
import { zChatInputRequest } from "./gateway/zod.gen"
import { AgentClient } from "./client"

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  created: number
  pending?: boolean
  failed?: boolean
}
type CachedMessage = Pick<ChatMessage, "id" | "role" | "text" | "created">
type Snapshot = {
  messages: ChatMessage[]
  working: boolean
  usingTools: boolean
  activity: string
  error: string
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}
// The stable snapshot/subscription model follows Bluesky's conversation agent.
// Durable intent uses AgentZ's existing idempotent input queue.
export class Conversation {
  private state: Snapshot = {
    messages: [],
    working: false,
    usingTools: false,
    activity: "",
    error: "",
    permissions: [],
    questions: [],
  }
  private listeners = new Set<() => void>()
  private messages = new Map<string, { info: Message; parts: Part[] }>()
  private database: SQLiteDatabase | undefined
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private flushing = false
  private accepted = new Map<string, string>()
  private persisted = new Map<string, string>()
  private poll: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private lifecycle: ReturnType<typeof AppState.addEventListener> | undefined
  private reconcile: Promise<void> | undefined
  private refreshAgain = false
  private writing: Promise<void> = Promise.resolve()
  private revision = 0
  private statusRevision = 0

  constructor(readonly client: AgentClient) {}
  getSnapshot = (): Snapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(): Promise<void> {
    this.stopped = false
    const db = await openDatabaseAsync("agentz.db")
    this.database = db
    await db.execAsync(
      "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )
    const identity = `${this.client.saved.connection.origin}/${this.client.saved.connection.workspace_id}/${this.client.saved.connection.session_id}`
    const previous = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM preferences WHERE key = ?",
      "connection"
    )
    if (previous?.value !== identity) {
      await db.execAsync("DELETE FROM messages; DELETE FROM outbox; DELETE FROM preferences;")
      await db.runAsync("INSERT INTO preferences (key,value) VALUES (?,?)", "connection", identity)
    }
    const cached = await db.getAllAsync<CachedMessage>(
      "SELECT id, role, text, created FROM messages ORDER BY created DESC LIMIT 100"
    )
    this.publish({
      messages: cached.reverse(),
    })
    const outbox = await db.getAllAsync<{
      id: string
      payload: string
      created: number
    }>("SELECT id,payload,created FROM outbox ORDER BY created")
    if (outbox.length)
      this.publish({
        messages: [
          ...this.state.messages,
          ...outbox.map((item) => ({
            id: item.id,
            role: "user" as const,
            text: zChatInputRequest.parse(JSON.parse(item.payload)).content.text,
            created: item.created,
            pending: true,
          })),
        ],
      })
    if (this.stopped) return
    for (const message of cached) this.persisted.set(message.id, message.text)
    this.lifecycle = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void this.connect()
        return
      }
      this.controller?.abort()
    })
    this.poll = setInterval(() => {
      if (AppState.currentState !== "active") return
      void this.flush()
      if (this.state.working) void this.refresh()
    }, 2500)
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.lifecycle?.remove()
    clearTimeout(this.timer)
    clearTimeout(this.retry)
    clearInterval(this.poll)
  }

  async draft(): Promise<string> {
    const row = await this.database?.getFirstAsync<{ value: string }>(
      "SELECT value FROM preferences WHERE key = ?",
      "draft"
    )
    return row?.value ?? ""
  }

  async saveDraft(text: string): Promise<void> {
    if (this.stopped) return
    await this.writing
    await this.database?.runAsync(
      "INSERT INTO preferences (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "draft",
      text
    )
  }

  send(text: string, id = Crypto.randomUUID()): void {
    if (!text.trim()) return
    const db = this.database
    if (!db) throw new Error("Your conversation is still opening. Try again.")
    const request = {
      id,
      delivery: "queue",
      content: {
        text: text.trim(),
        attachments: [],
        model: this.client.saved.connection.model,
      },
    } as const
    const previous = this.state.messages.find((message) => message.id === id)
    const created = previous?.created ?? Date.now()
    this.publish({
      messages: [
        ...this.state.messages.filter((message) => message.id !== id),
        {
          id,
          role: "user",
          text: text.trim(),
          created,
          pending: true,
        },
      ],
      error: "",
    })
    this.writing = this.writing
      .then(async () => {
        await db.withTransactionAsync(async () => {
          await db.runAsync(
            "INSERT INTO outbox (id,payload,created) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            id,
            JSON.stringify(request),
            created
          )
          await db.runAsync(
            "INSERT INTO preferences (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            "draft",
            ""
          )
        })
        void this.flush()
      })
      .catch(() => {
        this.publish({
          messages: this.state.messages.map((message) =>
            message.id === id ? { ...message, failed: true } : message
          ),
          error: "This message could not be saved. Tap it to retry before closing the app.",
        })
      })
  }

  retryMessage = async (inputId: string): Promise<void> => {
    const { agent_name: agentName, session_id: sessionId } = this.client.saved.connection
    try {
      await this.writing
      const stored = await this.database?.getFirstAsync<{ id: string }>(
        "SELECT id FROM outbox WHERE id = ?",
        inputId
      )
      const local = this.state.messages.find((message) => message.id === inputId)
      if (!stored && local?.pending) {
        this.send(local.text, inputId)
        return
      }
      const queue = await listChatInputs({
        client: this.client.gateway,
        path: { agentName, sessionId },
      })
      const input = queue.data?.items.find((item) => item.id === inputId)
      if (!input) throw new Error("This queued message is unavailable. Reconnect and try again.")
      const response = await updateChatInput({
        client: this.client.gateway,
        path: { agentName, sessionId, inputId },
        body: { action: "retry", revision: input.revision },
      })
      if (response.error) throw new Error("Could not retry this message. Try again.")
      this.publish({
        messages: this.state.messages.map((message) =>
          message.id === inputId ? { ...message, failed: false } : message
        ),
        error: "",
      })
      await this.flush()
    } catch (cause) {
      this.publish({
        error: cause instanceof Error ? cause.message : "Could not retry this message.",
      })
    }
  }

  async interrupt(): Promise<void> {
    const response = await this.client.agent.session.abort({
      sessionID: this.client.saved.connection.session_id,
    })
    if (response.error) throw new Error("Could not stop this task. Try again.")
    await this.refresh()
  }

  async answerPermission(requestID: string, reply: "once" | "reject"): Promise<void> {
    const response = await this.client.agent.permission.reply({
      requestID,
      reply,
    })
    if (response.error)
      throw new Error("This request could not be answered. It may already be resolved.")
    await this.refresh()
  }

  async answerQuestion(requestID: string, answers: string[][]): Promise<void> {
    const response = await this.client.agent.question.reply({
      requestID,
      answers,
    })
    if (response.error)
      throw new Error("This question could not be answered. Refresh and try again.")
    await this.refresh()
  }

  async clear(): Promise<boolean> {
    this.stop()
    await this.writing
    await this.database?.execAsync(
      "DELETE FROM messages; DELETE FROM outbox; DELETE FROM preferences;"
    )
    return this.client.disconnect()
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    this.controller?.abort()
    clearTimeout(this.retry)
    const controller = new AbortController()
    this.controller = controller
    try {
      await this.refresh()
      if (controller.signal.aborted) return
      void this.flush()
      const events = await this.client.agent.event.subscribe(
        {},
        {
          signal: controller.signal,
          onSseError: () =>
            this.publish({
              error: "Reconnecting. Messages you send are saved on this phone.",
            }),
        }
      )
      for await (const event of events.stream) {
        if (controller.signal.aborted || this.stopped) return
        const sessionID = this.client.saved.connection.session_id
        switch (event.type) {
          case "message.updated": {
            const info = event.properties.info
            if (info.sessionID !== sessionID) break
            this.revision++
            const current = this.messages.get(info.id)
            this.messages.set(info.id, { info, parts: current?.parts ?? [] })
            this.schedulePaint()
            break
          }
          case "message.part.updated": {
            const part = event.properties.part
            if (part.sessionID !== sessionID) break
            this.revision++
            const message = this.messages.get(part.messageID)
            if (!message) {
              void this.refresh()
              break
            }
            const index = message.parts.findIndex((item) => item.id === part.id)
            if (index < 0) message.parts.push(part)
            if (index >= 0) message.parts[index] = part
            this.schedulePaint()
            break
          }
          case "message.part.delta": {
            const { messageID, partID, delta, field, sessionID: owner } = event.properties
            if (owner !== sessionID || field !== "text") break
            this.revision++
            const part = this.messages.get(messageID)?.parts.find((item) => item.id === partID)
            if (part?.type === "text" || part?.type === "reasoning") part.text += delta
            this.schedulePaint()
            break
          }
          case "message.removed":
          case "message.part.removed": {
            const { messageID, sessionID: owner } = event.properties
            if (owner !== sessionID) break
            this.revision++
            if (event.type === "message.removed") {
              this.messages.delete(messageID)
            } else {
              const message = this.messages.get(messageID)
              if (message)
                message.parts = message.parts.filter((part) => part.id !== event.properties.partID)
            }
            this.publish({
              messages: this.state.messages.filter((message) => message.id !== messageID),
            })
            const deleting = this.writing.then(async () => {
              await this.database?.runAsync("DELETE FROM messages WHERE id = ?", messageID)
              this.persisted.delete(messageID)
            })
            this.writing = deleting.catch(() => undefined)
            await Promise.all([deleting, this.paint()])
            break
          }
          case "session.status":
            if (event.properties.sessionID === sessionID) {
              this.statusRevision++
              this.publish({
                working: event.properties.status.type !== "idle",
              })
            }
            break
          case "session.idle":
            if (event.properties.sessionID === sessionID) {
              this.statusRevision++
              this.publish({ working: false })
              void this.refresh()
            }
            break
          case "permission.v2.asked":
          case "permission.v2.replied":
          case "permission.asked":
          case "permission.replied":
          case "question.asked":
          case "question.replied":
          case "question.rejected":
            void this.refresh()
            break
          case "server.connected":
            this.publish({ error: "" })
            void this.refresh()
            break
          case "session.error":
            if (event.properties.sessionID === sessionID) {
              this.statusRevision++
              this.publish({
                working: false,
                error: "The agent hit an error. Your message is saved. Try asking it to continue.",
              })
            }
            break
        }
      }
    } catch (cause) {
      if (controller.signal.aborted || this.stopped) return
      this.publish({
        error: cause instanceof Error ? cause.message : "Connection lost. Retrying…",
      })
    }
    if (!controller.signal.aborted && !this.stopped)
      this.retry = setTimeout(() => void this.connect(), 3000)
  }

  async refresh(): Promise<void> {
    if (this.reconcile) {
      this.refreshAgain = true
      return this.reconcile
    }
    this.reconcile = (async () => {
      const sessionID = this.client.saved.connection.session_id
      const revision = this.revision
      const statusRevision = this.statusRevision
      const [history, permissions, questions, status] = await Promise.all([
        this.client.agent.session.messages({ sessionID, limit: 100 }),
        this.client.agent.permission.list(),
        this.client.agent.question.list(),
        this.client.agent.session.status(),
      ])
      if (history.error || !history.data) throw new Error("Could not reach your agent. Retrying…")
      // A history response must not overwrite events received while it was in flight.
      if (revision === this.revision) {
        const ids = new Set(history.data.map((message) => message.info.id))
        const oldest =
          history.data.length === 100
            ? Math.min(...history.data.map((message) => message.info.time.created))
            : 0
        for (const [id, message] of this.messages)
          if (message.info.time.created >= oldest && !ids.has(id)) this.messages.delete(id)
        const removed = this.state.messages.filter(
          (message) => !message.pending && message.created >= oldest && !ids.has(message.id)
        )
        for (const message of history.data) this.messages.set(message.info.id, message)
        if (removed.length) {
          const deleted = new Set(removed.map((message) => message.id))
          this.publish({
            messages: this.state.messages.filter((message) => !deleted.has(message.id)),
          })
          const deleting = this.writing.then(async () => {
            for (const message of removed) {
              await this.database?.runAsync("DELETE FROM messages WHERE id = ?", message.id)
              this.persisted.delete(message.id)
            }
          })
          this.writing = deleting.catch(() => undefined)
          await deleting
        }
      }
      this.publish({
        error: "",
        permissions: permissions.data ?? [],
        questions: questions.data ?? [],
        working:
          statusRevision === this.statusRevision
            ? (status.data?.[sessionID]?.type ?? "idle") !== "idle"
            : this.state.working,
      })
      await this.paint()
    })()
      .catch((cause) => {
        if (!this.stopped)
          this.publish({
            error: cause instanceof Error ? cause.message : "Could not reach your agent. Retrying…",
          })
      })
      .finally(() => {
        this.reconcile = undefined
        if (this.refreshAgain && !this.stopped) {
          this.refreshAgain = false
          void this.refresh()
        }
      })
    return this.reconcile
  }

  private schedulePaint(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.paint().catch(() =>
        this.publish({ error: "Your latest reply could not be saved on this phone." })
      )
    }, 40)
  }

  private async paint(): Promise<void> {
    if (this.stopped) return
    const visible: ChatMessage[] = []
    const empty: string[] = []
    for (const { info, parts } of this.messages.values()) {
      const text = parts
        .flatMap((part) =>
          part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []
        )
        .join("\n")
      if (!text) {
        empty.push(info.id)
        continue
      }
      visible.push({
        id: info.id,
        role: info.role,
        text,
        created: info.time.created,
      })
    }
    const retained = this.state.messages.filter((message) => {
      if (this.messages.has(message.id)) return false
      if (!message.pending) return true
      const serverID = this.accepted.get(message.id)
      for (const item of visible) {
        if (item.id === message.id || item.id === serverID) return false
        if (item.role !== "user") continue
        const received = this.messages
          .get(item.id)
          ?.parts.some(
            (part) => part.type === "text" && part.metadata?.["agentz.dev/input-id"] === message.id
          )
        if (!received) continue
        this.accepted.set(message.id, item.id)
        return false
      }
      return true
    })
    visible.push(...retained)
    visible.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    const previousMessages = new Map(this.state.messages.map((message) => [message.id, message]))
    const messages = visible.map((message) => {
      const previous = previousMessages.get(message.id)
      if (!previous) return message
      const unchanged =
        previous.text === message.text &&
        previous.created === message.created &&
        previous.pending === message.pending &&
        previous.failed === message.failed
      return unchanged ? previous : message
    })
    let usingTools = false
    let activity = ""
    for (const message of this.messages.values()) {
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "pending" && part.state.status !== "running") continue
        usingTools = true
        if (part.state.status === "running" && part.state.title) activity = part.state.title
      }
    }
    const changed =
      messages.length !== this.state.messages.length ||
      messages.some((message, index) => message !== this.state.messages[index])
    if (changed || usingTools !== this.state.usingTools || activity !== this.state.activity)
      this.publish({ messages: changed ? messages : this.state.messages, usingTools, activity })
    const db = this.database
    if (!db) return
    const writing = this.writing.then(async () => {
      for (const id of empty) {
        if (!this.persisted.has(id)) continue
        await db.runAsync("DELETE FROM messages WHERE id = ?", id)
        this.persisted.delete(id)
      }
      for (const message of messages) {
        if (this.stopped) return
        if (message.pending || this.persisted.get(message.id) === message.text) continue
        const info = this.messages.get(message.id)?.info
        if (info?.role === "assistant" && !info.time.completed) continue
        await db.runAsync(
          "INSERT INTO messages (id,role,text,created) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text",
          message.id,
          message.role,
          message.text,
          message.created
        )
        this.persisted.set(message.id, message.text)
      }
    })
    this.writing = writing.catch(() => undefined)
    await writing
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.database || this.stopped) return
    this.flushing = true
    const { agent_name: agentName, session_id: sessionId } = this.client.saved.connection
    try {
      const pending = await this.database.getAllAsync<{
        id: string
        payload: string
        created: number
      }>("SELECT id,payload,created FROM outbox ORDER BY created")
      if (!pending.length) return
      for (const item of pending) {
        const body = zChatInputRequest.parse(JSON.parse(item.payload))
        const result = await submitChatInput({
          client: this.client.gateway,
          path: { agentName, sessionId },
          body,
        })
        if (result.error || !result.data)
          throw new Error("Message saved on your phone. Waiting to send…")
        let removed = result.data.state === "removed"
        const serverID = result.data.message_id
        if (serverID) this.accepted.set(item.id, serverID)
        if (serverID && result.data.state === "delivered") {
          const revision = this.revision
          const message = await this.client.agent.session.message({
            sessionID: sessionId,
            messageID: serverID,
          })
          removed = message.response.status === 404
          if (!removed) {
            if (message.error || !message.data) throw new Error("Could not confirm this message.")
            if (revision === this.revision) this.messages.set(serverID, message.data)
          }
        }
        if (removed) {
          await this.database.runAsync("DELETE FROM outbox WHERE id = ?", item.id)
          this.accepted.delete(item.id)
          this.publish({
            messages: this.state.messages.filter((message) => message.id !== item.id),
          })
          continue
        }
        const received =
          serverID &&
          this.messages
            .get(serverID)
            ?.parts.some(
              (part) => part.type === "text" && !part.ignored && !part.synthetic && part.text
            )
        if (received) {
          await this.paint()
          await this.database.runAsync("DELETE FROM outbox WHERE id = ?", item.id)
          this.accepted.delete(item.id)
        }
        this.publish({ error: "" })
      }
      const queue = await listChatInputs({
        client: this.client.gateway,
        path: { agentName, sessionId },
      })
      if (queue.data) {
        const accepted = new Map(queue.data.items.map((item) => [item.id, item]))
        this.publish({
          messages: this.state.messages.map((message) => {
            const input = accepted.get(message.id)
            return input
              ? {
                  ...message,
                  pending: true,
                  failed: input.state === "failed" || input.state === "recovered",
                }
              : message
          }),
        })
      }
      await this.refresh()
    } catch (cause) {
      this.publish({
        error: cause instanceof Error ? cause.message : "Waiting for connection…",
      })
    } finally {
      this.flushing = false
    }
  }

  private publish(update: Partial<Snapshot>): void {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) listener()
  }
}
