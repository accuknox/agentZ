"use client"

import { useEffect, useSyncExternalStore } from "react"
import { toast } from "sonner"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { CodingProject, CodingTextRequest } from "@/lib/gateway/client"
import type { Session } from "@opencode-ai/sdk/v2"

export type CodingDraft = {
  id: string
  scope: string
  projectId: CodingProject["id"]
  agentName: string
  checkout: string
  model?: CodingTextRequest["model"]
  mode?: Session["agent"]
  baseRef?: string
  message: PromptInputMessage
}

const empty: CodingDraft[] = []
const snapshots = new Map<string, CodingDraft[]>()
const pending = new Map<string, Promise<CodingDraft[]>>()
const listeners = new Set<() => void>()
let database: Promise<IDBDatabase> | undefined

// IndexedDB preserves File objects; serialized object URLs cannot survive reload.
function openDrafts(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("agentz-coding-drafts", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      database = undefined
      reject(request.error)
    }
  })
  return database
}

export const codingDrafts = {
  async load(scope: string): Promise<CodingDraft[]> {
    const saved = snapshots.get(scope)
    if (saved) return saved
    const existing = pending.get(scope)
    if (existing) return existing
    const loading = (async () => {
      const db = await openDrafts()
      const rows = await new Promise<CodingDraft[]>((resolve, reject) => {
        const request = db.transaction("drafts").objectStore("drafts").getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const scoped = rows.filter((draft) => draft.scope === scope)
      snapshots.set(scope, scoped)
      for (const listener of listeners) listener()
      return scoped
    })()
    pending.set(scope, loading)
    try {
      return await loading
    } finally {
      pending.delete(scope)
    }
  },
  async start(scope: string, projectId: string, agentName: string): Promise<CodingDraft> {
    await this.load(scope).catch(() => {
      toast.error("Draft storage is unavailable. Keep this tab open to preserve your draft.")
    })
    const existing = snapshots
      .get(scope)
      ?.find(
        (draft) =>
          draft.projectId === projectId &&
          draft.agentName === agentName &&
          !draft.message.text &&
          !draft.message.files.length
      )
    if (existing) return existing
    const draft: CodingDraft = {
      id: crypto.randomUUID(),
      scope,
      projectId,
      agentName,
      checkout: "new",
      message: { text: "", files: [] },
    }
    this.save(draft)
    return draft
  },
  save(draft: CodingDraft): void {
    const rows = snapshots.get(draft.scope) ?? empty
    snapshots.set(draft.scope, [...rows.filter((row) => row.id !== draft.id), draft])
    for (const listener of listeners) listener()
    void openDrafts()
      .then((db) => {
        const tx = db.transaction("drafts", "readwrite")
        tx.objectStore("drafts").put(draft)
        tx.onerror = () =>
          toast.error("Could not save the draft. Keep this tab open to preserve it.")
      })
      .catch(() => toast.error("Could not save the draft. Keep this tab open to preserve it."))
  },
  remove(scope: string, id: string): void {
    snapshots.set(
      scope,
      (snapshots.get(scope) ?? empty).filter((draft) => draft.id !== id)
    )
    for (const listener of listeners) listener()
    void openDrafts()
      .then((db) => {
        const tx = db.transaction("drafts", "readwrite")
        tx.objectStore("drafts").delete(id)
        tx.onerror = () => toast.error("Could not remove the saved draft")
      })
      .catch(() => toast.error("Could not remove the saved draft"))
  },
}

export function useCodingDrafts(scope: string): CodingDraft[] {
  useEffect(() => {
    if (!scope) return
    void codingDrafts.load(scope).catch(() => toast.error("Could not load saved drafts"))
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
