"use client"

import { useCallback, useSyncExternalStore } from "react"
import * as z from "zod"

const storedModelRefSchema = z.object({
  modelID: z.string().min(1),
  providerID: z.string().min(1),
})

const chatModelStoragePayloadSchema = z.object({
  recent: z.array(storedModelRefSchema).catch([]),
  variant: z.record(z.string(), z.string()).catch({}),
})

type StoredModelRef = z.infer<typeof storedModelRefSchema>

type ChatModelStoragePayload = {
  recent: StoredModelRef[]
  variant: Record<string, string | undefined>
}

type ChatModelStorageSnapshot = ChatModelStoragePayload & {
  ready: boolean
}

type UseChatModelStorageResult = {
  clearInvalid: (isValid: (model: StoredModelRef) => boolean) => void
  getVariant: (model: StoredModelRef) => string | undefined
  pushRecent: (model: StoredModelRef) => void
  ready: boolean
  recent: StoredModelRef[]
  setVariant: (model: StoredModelRef, variant: string | undefined) => void
}

const MAX_RECENT_MODELS = 10
const storageListeners = new Map<string, Set<() => void>>()
const storageSnapshotCache = new Map<
  string,
  {
    raw: string | null
    snapshot: ChatModelStorageSnapshot
  }
>()
const emptyStorageSnapshot = {
  ready: false,
  recent: [],
  variant: {},
} satisfies ChatModelStorageSnapshot

function parseStoragePayload(value: string | null): ChatModelStoragePayload {
  if (!value) {
    return {
      recent: [],
      variant: {},
    }
  }

  try {
    return chatModelStoragePayloadSchema.parse(JSON.parse(value))
  } catch {
    return {
      recent: [],
      variant: {},
    }
  }
}

function modelKey(model: StoredModelRef) {
  return `${model.providerID}/${model.modelID}`
}

function readSnapshot(storageKey: string): ChatModelStorageSnapshot {
  if (typeof window === "undefined") {
    return emptyStorageSnapshot
  }

  const raw = window.localStorage.getItem(storageKey)
  const cached = storageSnapshotCache.get(storageKey)
  if (cached && cached.raw === raw) {
    return cached.snapshot
  }

  const payload = parseStoragePayload(raw)
  const snapshot = {
    ready: true,
    recent: payload.recent,
    variant: payload.variant,
  }
  storageSnapshotCache.set(storageKey, {
    raw,
    snapshot,
  })
  return snapshot
}

function writeSnapshot(storageKey: string, payload: ChatModelStoragePayload) {
  const raw = JSON.stringify(payload)
  const snapshot = {
    ready: true,
    recent: payload.recent,
    variant: payload.variant,
  } satisfies ChatModelStorageSnapshot
  window.localStorage.setItem(storageKey, raw)
  storageSnapshotCache.set(storageKey, {
    raw,
    snapshot,
  })
  storageListeners.get(storageKey)?.forEach((listener) => listener())
}

export function useChatModelStorage(agentName: string): UseChatModelStorageResult {
  const storageKey = `agentz:chat-model-state:${agentName}`
  const snapshot = useSyncExternalStore(
    (onStoreChange) => {
      const listeners = storageListeners.get(storageKey) ?? new Set<() => void>()
      listeners.add(onStoreChange)
      storageListeners.set(storageKey, listeners)

      function handleStorage(event: StorageEvent) {
        if (event.key !== storageKey) return
        onStoreChange()
      }

      window.addEventListener("storage", handleStorage)
      return () => {
        listeners.delete(onStoreChange)
        if (listeners.size === 0) {
          storageListeners.delete(storageKey)
        }
        window.removeEventListener("storage", handleStorage)
      }
    },
    () => readSnapshot(storageKey),
    () => emptyStorageSnapshot
  )

  const getVariant = useCallback(
    (model: StoredModelRef) => {
      return snapshot.variant[modelKey(model)]
    },
    [snapshot.variant]
  )

  const pushRecent = useCallback(
    (model: StoredModelRef) => {
      const deduped = [
        model,
        ...snapshot.recent.filter((item) => modelKey(item) !== modelKey(model)),
      ]
      writeSnapshot(storageKey, {
        recent: deduped.slice(0, MAX_RECENT_MODELS),
        variant: snapshot.variant,
      })
    },
    [snapshot.recent, snapshot.variant, storageKey]
  )

  const setVariant = useCallback(
    (model: StoredModelRef, variant: string | undefined) => {
      const key = modelKey(model)
      const nextVariant = { ...snapshot.variant }

      if (!variant) {
        delete nextVariant[key]
      } else {
        nextVariant[key] = variant
      }

      writeSnapshot(storageKey, {
        recent: snapshot.recent,
        variant: nextVariant,
      })
    },
    [snapshot.recent, snapshot.variant, storageKey]
  )

  const clearInvalid = useCallback(
    (isValid: (model: StoredModelRef) => boolean) => {
      const recent = snapshot.recent.filter(isValid)
      const variant = Object.fromEntries(
        Object.entries(snapshot.variant).filter(([key]) => {
          const [providerID, ...modelID] = key.split("/")
          if (!providerID || modelID.length === 0) return false

          return isValid({
            modelID: modelID.join("/"),
            providerID,
          })
        })
      )

      if (
        recent.length === snapshot.recent.length &&
        Object.keys(variant).length === Object.keys(snapshot.variant).length
      ) {
        return
      }

      writeSnapshot(storageKey, {
        recent,
        variant,
      })
    },
    [snapshot.recent, snapshot.variant, storageKey]
  )

  return {
    clearInvalid,
    getVariant,
    pushRecent,
    ready: snapshot.ready,
    recent: snapshot.recent,
    setVariant,
  }
}
