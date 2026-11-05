"use client"

import { openDB, type DBSchema } from "idb"
import { useEffect, useSyncExternalStore } from "react"
import { toast } from "sonner"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { ChatInput, CodingProject, CodingTextRequest } from "@/lib/gateway/client"
import type { Session } from "@opencode-ai/sdk/v2"

export type SessionDraft = {
  id: string
  scope: string
  projectId: CodingProject["id"]
  agentName: string
  createdAt?: number
  sessionID?: Session["id"]
  checkout: string
  model?: CodingTextRequest["model"]
  mode?: Session["agent"]
  baseRef?: string
  message: PromptInputMessage
  submission?: PromptInputMessage
  queueEdit?: { item: ChatInput; sessionID: string; draft: PromptInputMessage }
}

export type DraftMetadata = Omit<SessionDraft, "message" | "submission" | "queueEdit">

interface DraftDatabase extends DBSchema {
  drafts: { key: [string, string]; value: SessionDraft; indexes: { scope: string } }
  discarded: { key: [string, string]; value: true }
}

type DraftChange = { scope: string; id: string; removed: boolean }
const empty: SessionDraft[] = []
const records = new Map<string, SessionDraft>()
// Metadata subscribers must never retain attachment Files or stale composer contents.
const metadata = new Map<string, DraftMetadata>()
const snapshots = new Map<string, SessionDraft[]>()
const pending = new Map<string, Promise<SessionDraft[]>>()
const listeners = new Set<() => void>()
const active = new Set<string>()
const persisted = new Set<string>()
const writes = new Map<string, ReturnType<typeof setTimeout>>()
const writing = new Map<string, symbol>()
let database: ReturnType<typeof openDB<DraftDatabase>> | undefined
let channel: BroadcastChannel | undefined

// The sidebar freezes an open draft's preview, just like the reference. Typing
// changes the durable record without notifying React or reordering the list.
function publish(scope: string) {
  const previous = snapshots.get(scope) ?? empty
  const rows = [...records.values()]
    .filter((draft) => draft.scope === scope && !draft.queueEdit)
    .flatMap((draft) => {
      if (active.has(JSON.stringify([scope, draft.id]))) {
        const row = previous.find((row) => row.id === draft.id)
        if (!row) return []
        if (
          row.agentName === draft.agentName &&
          row.sessionID === draft.sessionID &&
          row.submission === draft.submission
        )
          return row
        return { ...draft, message: row.message }
      }
      const message = draft.submission ?? draft.message
      if (!message.text.trim() && !message.files.length) return []
      return draft.submission ? { ...draft, message } : draft
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  // Active message changes don't publish at all. Other changes are infrequent:
  // navigation, metadata edits, cross-tab updates, promotion and discard.
  if (rows.length !== previous.length || rows.some((row, index) => row !== previous[index])) {
    snapshots.set(scope, rows)
  } else if (!snapshots.has(scope)) {
    snapshots.set(scope, previous)
  }
  for (const listener of listeners) listener()
}

async function openDrafts(): ReturnType<typeof openDB<DraftDatabase>> {
  if (!channel) {
    channel = new BroadcastChannel("agentz-session-drafts")
    channel.onmessage = async ({ data }: MessageEvent<DraftChange>) => {
      if (!snapshots.has(data.scope)) return
      const key = JSON.stringify([data.scope, data.id])
      if (data.removed) {
        clearTimeout(writes.get(key))
        writes.delete(key)
        records.delete(key)
        metadata.delete(key)
        persisted.delete(key)
        publish(data.scope)
        return
      }
      try {
        const db = await openDrafts()
        const draft = await db.get("drafts", [data.scope, data.id])
        // A remote edit must not replace this tab's unflushed input.
        if (!draft || writes.has(key) || writing.has(key)) return
        records.set(key, draft)
        const { message: _message, submission: _submission, queueEdit: _queueEdit, ...info } = draft
        metadata.set(key, info)
        persisted.add(key)
        publish(data.scope)
      } catch {
        toast.error("Could not sync drafts")
      }
    }
    window.addEventListener("pagehide", () => sessionDrafts.flush())
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) sessionDrafts.flush()
    })
  }
  database ??= openDB<DraftDatabase>("agentz-coding-drafts", 4, {
    upgrade(db, version, _nextVersion, tx) {
      void tx.done.catch(() => {})
      db.createObjectStore("discarded")
      if (version >= 3) return
      if (version === 0) {
        db.createObjectStore("drafts", { keyPath: ["scope", "id"] }).createIndex("scope", "scope")
        return
      }
      // Re-key existing drafts once; route IDs alone are not unique across
      // users or workspaces. Later loads still use only the scope index.
      void tx
        .objectStore("drafts")
        .getAll()
        .then((rows) => {
          db.deleteObjectStore("drafts")
          const store = db.createObjectStore("drafts", { keyPath: ["scope", "id"] })
          store.createIndex("scope", "scope")
          return Promise.all(rows.map((row) => store.put(row)))
        })
        .catch(() => {
          try {
            tx.abort()
          } catch {
            // A failed request can already have aborted the upgrade.
          }
        })
    },
    blocking() {
      void database?.then((db) => db.close())
      database = undefined
    },
    terminated() {
      database = undefined
    },
  }).catch((error) => {
    database = undefined
    throw error
  })
  return database
}

export const sessionDrafts = {
  get(scope: string, id: string): SessionDraft | undefined {
    return records.get(JSON.stringify([scope, id]))
  },
  async load(scope: string): Promise<SessionDraft[]> {
    if (snapshots.has(scope)) return [...records.values()].filter((draft) => draft.scope === scope)
    const existing = pending.get(scope)
    if (existing) return existing
    const loading = (async () => {
      const db = await openDrafts()
      // Scope index avoids cloning other users' drafts and attachment Files.
      const rows = await db.getAllFromIndex("drafts", "scope", scope)
      const tx = db.transaction("drafts", "readwrite")
      void tx.done.catch(() => {})
      for (const row of rows) {
        const message = row.submission ?? row.message
        if (!message.text.trim() && !message.files.length && !row.sessionID && !row.queueEdit) {
          await tx.store.delete([scope, row.id])
          continue
        }
        const draft = row.submission
          ? {
              ...row,
              submission: undefined,
              message: {
                ...row.submission,
                requestID:
                  row.message.text || row.message.files.length
                    ? row.message.requestID
                    : row.submission.requestID,
                text: [row.submission.text, row.message.text].filter(Boolean).join("\n\n"),
                files: [...row.submission.files, ...row.message.files],
              },
            }
          : row
        const key = JSON.stringify([scope, row.id])
        records.set(key, draft)
        const { message: _message, submission: _submission, queueEdit: _queueEdit, ...info } = draft
        metadata.set(key, info)
        persisted.add(key)
      }
      await tx.done
      publish(scope)
      return [...records.values()].filter((draft) => draft.scope === scope)
    })()
    pending.set(scope, loading)
    try {
      return await loading
    } finally {
      pending.delete(scope)
    }
  },
  async start(
    scope: string,
    projectId: string,
    agentName: string,
    id?: string
  ): Promise<SessionDraft> {
    await this.load(scope).catch(() => {
      toast.error("Draft storage is unavailable. Keep this tab open to preserve your draft.")
    })
    if (id && !this.get(scope, id)) {
      const requested = id
      const discarded = await openDrafts()
        .then((db) => db.get("discarded", [scope, requested]))
        .catch(() => false)
      if (discarded) id = undefined
    }
    const existing = id
      ? this.get(scope, id)
      : [...records.values()].find(
          (draft) =>
            draft.scope === scope &&
            draft.projectId === projectId &&
            draft.agentName === agentName &&
            !draft.submission &&
            !draft.queueEdit &&
            !draft.sessionID &&
            !draft.message.text.trim() &&
            !draft.message.files.length &&
            !(snapshots.get(scope) ?? empty).some((row) => row.id === draft.id)
        )
    if (existing && (!projectId || existing.projectId === projectId)) return existing
    const draft: SessionDraft = {
      id: existing ? crypto.randomUUID() : (id ?? crypto.randomUUID()),
      scope,
      projectId,
      agentName,
      createdAt: Date.now(),
      checkout: "new",
      message: { text: "", files: [] },
    }
    const key = JSON.stringify([scope, draft.id])
    records.set(key, draft)
    const { message: _message, submission: _submission, queueEdit: _queueEdit, ...info } = draft
    metadata.set(key, info)
    publish(scope)
    return draft
  },
  activate(scope: string, id: string): () => void {
    const key = JSON.stringify([scope, id])
    active.add(key)
    return () => {
      active.delete(key)
      this.flush(scope, id)
      publish(scope)
    }
  },
  update(scope: string, id: string, change: Partial<Omit<SessionDraft, "id" | "scope">>): void {
    const current = this.get(scope, id)
    if (!current) return
    const key = JSON.stringify([scope, id])
    const draft = { ...current, ...change }
    records.set(key, draft)
    const contentOnly = Object.keys(change).every((key) => key === "message")
    if (!contentOnly) {
      const { message: _message, submission: _submission, queueEdit: _queueEdit, ...info } = draft
      metadata.set(key, info)
    }
    if (!contentOnly || !active.has(key)) publish(scope)
    clearTimeout(writes.get(key))
    writes.set(
      key,
      setTimeout(() => this.flush(scope, id), 250)
    )
  },
  flush(scope?: string, id?: string): void {
    for (const [key, timer] of writes) {
      const draft = records.get(key)
      if (scope && (draft?.scope !== scope || draft.id !== id)) continue
      clearTimeout(timer)
      writes.delete(key)
      if (!draft) continue
      const write = Symbol()
      writing.set(key, write)
      void (async () => {
        const db = await openDrafts()
        if (records.get(key) !== draft) return
        const tx = db.transaction(["drafts", "discarded"], "readwrite")
        void tx.done.catch(() => {})
        const store = tx.objectStore("drafts")
        // An explicit deletion in another tab wins over a stale queued write.
        // Its durable marker also covers suspended tabs that missed broadcasts.
        const discarded = await tx.objectStore("discarded").get([draft.scope, draft.id])
        if (discarded || (persisted.has(key) && !(await store.getKey([draft.scope, draft.id])))) {
          await tx.done
          records.delete(key)
          metadata.delete(key)
          persisted.delete(key)
          publish(draft.scope)
          return
        }
        const message = draft.submission ?? draft.message
        const keep = Boolean(message.text.trim() || message.files.length || draft.queueEdit)
        if (keep) {
          await store.put(draft)
        } else {
          await store.delete([draft.scope, draft.id])
        }
        await tx.done
        if (keep) persisted.add(key)
        else persisted.delete(key)
        channel?.postMessage({
          scope: draft.scope,
          id: draft.id,
          removed: !keep,
        } satisfies DraftChange)
      })()
        .catch(() => toast.error("Could not save the draft. Keep this tab open to preserve it."))
        .finally(() => {
          if (writing.get(key) === write) writing.delete(key)
        })
    }
  },
  remove(scope: string, id: string): void {
    if (!this.get(scope, id)) return
    const key = JSON.stringify([scope, id])
    clearTimeout(writes.get(key))
    writes.delete(key)
    records.delete(key)
    metadata.delete(key)
    persisted.delete(key)
    publish(scope)
    void openDrafts()
      .then(async (db) => {
        const tx = db.transaction(["drafts", "discarded"], "readwrite")
        void tx.done.catch(() => {})
        await tx.objectStore("discarded").put(true, [scope, id])
        await tx.objectStore("drafts").delete([scope, id])
        await tx.done
        channel?.postMessage({ scope, id, removed: true } satisfies DraftChange)
      })
      .catch(() => toast.error("Could not remove the saved draft"))
  },
}

export function useSessionDrafts(scope: string): SessionDraft[] {
  useEffect(() => {
    if (scope)
      void sessionDrafts.load(scope).catch(() => toast.error("Could not load saved drafts"))
  }, [scope])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshots.get(scope) ?? empty,
    () => empty
  )
}

export function useSessionDraft(scope: string, id: string | null): DraftMetadata | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => (id ? metadata.get(JSON.stringify([scope, id])) : undefined),
    () => undefined
  )
}
