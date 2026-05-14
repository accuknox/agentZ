"use client"

import type { Event, Message, Part, Session, SessionStatus, TextPart } from "@opencode-ai/sdk"
import { QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { startTransition, useEffectEvent, useEffect, useMemo, useRef, useState } from "react"
import { createAgentOpencodeClient } from "@/lib/opencode/client"

type SessionMessageRecord = {
  info: Message
  parts: Part[]
}

type OpencodeChatStore = {
  part: Record<string, Part[]>
  partTextAccumDelta: Record<string, string>
  message: Record<string, Message[]>
  session?: Session
  sessionStatus: Record<string, SessionStatus>
}

export type ChatSystemPrompt = {
  content: string
  createdAt: number
  id: string
  kind: "system"
}

export type OptimisticUserMessage = {
  createdAt: number
  id: string
  kind: "optimistic-user"
  status: "failed" | "pending"
  text: string
}

export type LocalChatMessage = ChatSystemPrompt | OptimisticUserMessage

type UseOpencodeChatResult = {
  historyError?: string
  isBusy: boolean
  isPending: boolean
  localMessages: LocalChatMessage[]
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  session?: Session
  sessionStatus?: SessionStatus
  streamError?: string
  textByPart: Record<string, string>
}

const idleSessionStatus: SessionStatus = { type: "idle" }

function deriveSessionIsBusy(
  messages: Message[],
  localMessages: LocalChatMessage[],
  sessionStatus: SessionStatus | undefined,
  session: Session | undefined
): boolean {
  // Pending optimistic user message not yet acknowledged by the server.
  if (localMessages.some((m) => m.kind === "optimistic-user" && m.status === "pending")) {
    return true
  }

  // Session status reported by the server. Catches "busy" during active
  // processing and "retry" during transient error backoff (SessionStatus
  // is a three-variant union: idle | busy | retry).
  if (sessionStatus && sessionStatus.type !== "idle") {
    return true
  }

  // Compaction rewrites the message store — metadata is in flux so the
  // heuristic below would be unreliable. Mirrors the TUI's early return
  // in sync.tsx.
  if (session?.time.compacting) {
    return true
  }

  // Derive from messages: either waiting for a response (last from user)
  // or the assistant response hasn't finished streaming yet.
  const last = messages.at(-1)
  if (!last) return false
  if (last.role === "user") return true
  if (last.role === "assistant" && last.time.completed === undefined) return true

  return false
}

function sdkErrorMessage(error: { data?: { message?: string } } | undefined, fallback: string) {
  return error?.data?.message ?? fallback
}

function sessionErrorMessage(
  error: Extract<Event, { type: "session.error" }>["properties"]["error"]
) {
  if (!error) return "Session error"

  switch (error.name) {
    case "ProviderAuthError":
    case "UnknownError":
    case "MessageAbortedError":
    case "APIError":
      return error.data.message
    case "MessageOutputLengthError":
      return "Response exceeded the model output limit"
    default:
      return "Session error"
  }
}

function emptyStore(): OpencodeChatStore {
  return {
    part: {},
    partTextAccumDelta: {},
    message: {},
    session: undefined,
    sessionStatus: {},
  }
}

function normalizeText(value: string) {
  return value.trim().replaceAll(/\s+/g, " ")
}

function upsertMessage(messages: Message[], next: Message) {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index < 0) {
    return [...messages, next].sort((x, y) => x.time.created - y.time.created)
  }

  return messages.map((message) => {
    if (message.id === next.id) return next
    return message
  })
}

function upsertPart(parts: Part[], next: Part) {
  const index = parts.findIndex((part) => part.id === next.id)
  if (index < 0) {
    return [...parts, next]
  }

  return parts.map((part) => {
    if (part.id === next.id) return next
    return part
  })
}

function buildStore(
  sessionID: string,
  session: Session | undefined,
  records: SessionMessageRecord[]
) {
  const store = emptyStore()
  store.session = session
  store.message[sessionID] = records
    .map((record) => record.info)
    .sort((x, y) => x.time.created - y.time.created)

  for (const record of records) {
    store.part[record.info.id] = record.parts

    for (const part of record.parts) {
      if (part.type !== "text" && part.type !== "reasoning") continue
      store.partTextAccumDelta[part.id] = part.text
    }
  }

  return store
}

function sessionMessageText(parts: Part[]) {
  return parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function messageSessionID(event: Event) {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "message.removed":
      return event.properties.sessionID
    case "message.part.updated":
      return event.properties.part.sessionID
    case "message.part.removed":
    case "session.status":
    case "session.idle":
    case "session.error":
      return event.properties.sessionID
    case "session.deleted":
      return event.properties.info.id
    case "session.created":
    case "session.updated":
      return event.properties.info.id
    default:
      return undefined
  }
}

function applyEvent(store: OpencodeChatStore, event: Event): OpencodeChatStore {
  switch (event.type) {
    case "message.updated": {
      const sessionID = event.properties.info.sessionID
      const messages = store.message[sessionID] ?? []

      return {
        ...store,
        message: {
          ...store.message,
          [sessionID]: upsertMessage(messages, event.properties.info),
        },
      }
    }

    case "message.removed": {
      const sessionID = event.properties.sessionID
      const messages = store.message[sessionID] ?? []

      return {
        ...store,
        message: {
          ...store.message,
          [sessionID]: messages.filter((message) => message.id !== event.properties.messageID),
        },
      }
    }

    case "message.part.updated": {
      const part = event.properties.part
      const parts = store.part[part.messageID] ?? []
      const nextParts = upsertPart(parts, part)
      const current = store.partTextAccumDelta[part.id] ?? ""
      const nextText =
        part.type === "text" || part.type === "reasoning"
          ? event.properties.delta
            ? current + event.properties.delta
            : part.text
          : undefined

      return {
        ...store,
        part: {
          ...store.part,
          [part.messageID]: nextParts,
        },
        partTextAccumDelta:
          nextText === undefined
            ? store.partTextAccumDelta
            : {
                ...store.partTextAccumDelta,
                [part.id]: nextText,
              },
      }
    }

    case "message.part.removed": {
      const parts = store.part[event.properties.messageID] ?? []
      const nextText = { ...store.partTextAccumDelta }
      delete nextText[event.properties.partID]

      return {
        ...store,
        part: {
          ...store.part,
          [event.properties.messageID]: parts.filter((part) => part.id !== event.properties.partID),
        },
        partTextAccumDelta: nextText,
      }
    }

    case "session.status":
      return {
        ...store,
        sessionStatus: {
          ...store.sessionStatus,
          [event.properties.sessionID]: event.properties.status,
        },
      }

    case "session.idle":
      return {
        ...store,
        sessionStatus: {
          ...store.sessionStatus,
          [event.properties.sessionID]: idleSessionStatus,
        },
      }

    case "session.created":
    case "session.updated":
      return {
        ...store,
        session:
          store.session?.id === event.properties.info.id ? event.properties.info : store.session,
      }

    default:
      return store
  }
}

export function chatOverlayQueryKey(agentName: string, sessionID?: string) {
  return ["opencode", "chatOverlay", agentName, sessionID ?? "new"] as const
}

export function sessionInfoQueryKey(agentName: string, sessionID: string) {
  return ["opencode", "sessionInfo", agentName, sessionID] as const
}

export function sessionMessagesBaseQueryKey(agentName: string, sessionID: string) {
  return ["opencode", "sessionMessages", agentName, sessionID] as const
}

function sessionMessagesQueryKey(agentName: string, sessionID: string, directory: string) {
  return [...sessionMessagesBaseQueryKey(agentName, sessionID), directory] as const
}

function setOverlayMessages(
  current: LocalChatMessage[] | undefined,
  updater: (draft: LocalChatMessage[]) => LocalChatMessage[]
) {
  return updater(current ? [...current] : [])
}

export function appendSystemPrompt(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  message: string
) {
  queryClient.setQueryData<LocalChatMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      return setOverlayMessages(current, (draft) => {
        draft.push({
          content: message,
          createdAt: Date.now(),
          id: `sys-${crypto.randomUUID()}`,
          kind: "system",
        })
        return draft
      })
    }
  )
}

export function upsertOptimisticUserMessage(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  message: OptimisticUserMessage
) {
  queryClient.setQueryData<LocalChatMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      return setOverlayMessages(current, (draft) => {
        const index = draft.findIndex(
          (item) => item.kind === "optimistic-user" && item.id === message.id
        )
        if (index >= 0) {
          draft[index] = message
          return draft
        }

        draft.push(message)
        return draft
      })
    }
  )
}

export function markOptimisticUserMessageFailed(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  messageID: string
) {
  queryClient.setQueryData<LocalChatMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      return setOverlayMessages(current, (draft) => {
        return draft.map((item) => {
          if (item.kind !== "optimistic-user" || item.id !== messageID) return item
          return {
            ...item,
            status: "failed",
          }
        })
      })
    }
  )
}

export function removeOptimisticUserMessage(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  messageID: string
) {
  queryClient.setQueryData<LocalChatMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      return setOverlayMessages(current, (draft) => {
        return draft.filter((item) => item.kind !== "optimistic-user" || item.id !== messageID)
      })
    }
  )
}

export function migrateChatOverlay(
  queryClient: QueryClient,
  agentName: string,
  fromSessionID: string | undefined,
  toSessionID: string
) {
  const current = queryClient.getQueryData<LocalChatMessage[]>(
    chatOverlayQueryKey(agentName, fromSessionID)
  )
  if (!current || current.length === 0) return

  queryClient.setQueryData<LocalChatMessage[]>(chatOverlayQueryKey(agentName, toSessionID), current)
  queryClient.removeQueries({
    queryKey: chatOverlayQueryKey(agentName, fromSessionID),
    exact: true,
  })
}

function sessionInfoQueryOptions(agentName: string, sessionID: string) {
  return queryOptions({
    queryFn: async () => {
      const client = createAgentOpencodeClient(agentName)
      const result = await client.session.get({
        path: {
          id: sessionID,
        },
      })

      if (result.error || !result.data) {
        throw new Error(sdkErrorMessage(result.error, "Failed to load session"))
      }

      return result.data
    },
    queryKey: sessionInfoQueryKey(agentName, sessionID),
    retry: false,
    staleTime: 60_000,
  })
}

function sessionMessagesQueryOptions(agentName: string, sessionID: string, directory: string) {
  return queryOptions({
    queryFn: async () => {
      const client = createAgentOpencodeClient(agentName, directory)
      const result = await client.session.messages({
        path: {
          id: sessionID,
        },
      })

      if (result.error || !result.data) {
        throw new Error(sdkErrorMessage(result.error, "Failed to load session messages"))
      }

      return result.data
    },
    queryKey: sessionMessagesQueryKey(agentName, sessionID, directory),
    retry: false,
    staleTime: 5_000,
  })
}

export function textParts(parts: Part[], textByPart: Record<string, string>): TextPart[] {
  return parts.filter((part): part is TextPart => {
    return part.type === "text" && (textByPart[part.id] ?? part.text).length > 0
  })
}

function chatOverlayQueryOptions(agentName: string, sessionID?: string) {
  return queryOptions({
    queryFn: async (): Promise<LocalChatMessage[]> => [],
    queryKey: chatOverlayQueryKey(agentName, sessionID),
    staleTime: Infinity,
  })
}

export function useOpencodeChat(agentName: string, sessionID?: string): UseOpencodeChatResult {
  const queryClient = useQueryClient()
  const client = useMemo(() => {
    return createAgentOpencodeClient(agentName)
  }, [agentName])
  const [events, setEvents] = useState<Event[]>([])
  const [streamError, setStreamError] = useState<string>()
  const session = useQuery({
    ...sessionInfoQueryOptions(agentName, sessionID ?? ""),
    enabled: Boolean(sessionID),
  })
  const history = useQuery({
    ...sessionMessagesQueryOptions(agentName, sessionID ?? "", session.data?.directory ?? ""),
    enabled: Boolean(sessionID && session.data?.directory),
  })
  const localMessages = useQuery({
    ...chatOverlayQueryOptions(agentName, sessionID),
    initialData: [],
  })

  const baseStore = useMemo(() => {
    if (!sessionID) {
      return emptyStore()
    }

    return buildStore(sessionID, session.data, history.data ?? [])
  }, [history.data, session.data, sessionID])

  const store = useMemo(() => {
    return events.reduce((current, event) => applyEvent(current, event), baseStore)
  }, [baseStore, events])

  const handleEvent = useEffectEvent((event: Event) => {
    if (!sessionID) return
    if (messageSessionID(event) !== sessionID) return

    if (event.type === "session.error") {
      appendSystemPrompt(
        queryClient,
        agentName,
        sessionID,
        sessionErrorMessage(event.properties.error)
      )
    }

    startTransition(() => {
      setEvents((current) => [...current, event])
      setStreamError(undefined)
    })
  })

  useEffect(() => {
    if (!sessionID) return

    const abortController = new AbortController()

    async function consume() {
      try {
        const result = await client.event.subscribe({
          signal: abortController.signal,
        })

        for await (const event of result.stream) {
          if (abortController.signal.aborted) return
          handleEvent(event)
        }
      } catch (error) {
        if (abortController.signal.aborted) return

        setStreamError(
          error instanceof Error ? error.message : "Failed to subscribe to session events"
        )
      }
    }

    void consume()

    return () => {
      abortController.abort()
    }
  }, [client, sessionID])

  const messages = useMemo(() => {
    return sessionID ? (store.message[sessionID] ?? []) : []
  }, [sessionID, store.message])
  const partsByMessage = store.part
  const textByPart = store.partTextAccumDelta
  const sessionStatus = sessionID
    ? (store.sessionStatus[sessionID] ?? idleSessionStatus)
    : undefined

  const processedIds = useRef(new Set<string>())

  useEffect(() => {
    if (!sessionID) return

    for (const localMessage of localMessages.data) {
      if (localMessage.kind !== "optimistic-user") continue
      if (processedIds.current.has(localMessage.id)) continue

      const match = messages.find((message) => {
        if (message.role !== "user") return false
        const parts = partsByMessage[message.id] ?? []
        const messageText = normalizeText(sessionMessageText(parts))
        const optimisticText = normalizeText(localMessage.text)

        return (
          messageText.length > 0 &&
          messageText === optimisticText &&
          Math.abs(message.time.created - localMessage.createdAt) < 60_000
        )
      })

      if (!match) continue
      processedIds.current.add(localMessage.id)
      removeOptimisticUserMessage(queryClient, agentName, sessionID, localMessage.id)
    }
  }, [agentName, localMessages.data, messages, partsByMessage, queryClient, sessionID])

  return {
    historyError: history.error instanceof Error ? history.error.message : undefined,
    isBusy: deriveSessionIsBusy(messages, localMessages.data, sessionStatus, store.session),
    isPending: Boolean(sessionID) && (session.isPending || history.isPending),
    localMessages: localMessages.data,
    messages,
    partsByMessage,
    session: store.session,
    sessionStatus,
    streamError,
    textByPart,
  }
}
