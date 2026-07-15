"use client"

import type { AttachmentData } from "@/components/ai-elements/attachments"
import type {
  Event as OpencodeEventV2,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session as SessionV2,
  SessionStatus,
  SessionStatusResponse,
  TextPart,
  Todo,
} from "@opencode-ai/sdk/v2"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { useCallback, useEffectEvent, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { describeMessageError, opencodeErrorMessage } from "@/components/blocks/chat/errors"

type SessionMessageRecord = {
  info: Message
  parts: Part[]
}

type OpencodeChatStore = {
  part: Record<string, Part[]>
  partTextAccumDelta: Record<string, string>
  message: Record<string, Message[]>
  session?: SessionV2
  // Todos are keyed by sessionID and cleared whenever the turn that produced
  // them completes. Empty arrays collapse to "no todos" so the dock hides.
  todos: Record<string, Todo[]>
}

type HitlStore = {
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  sessions: SessionV2[]
}

const emptyHitlStore: HitlStore = { permissions: {}, questions: {}, sessions: [] }

type StreamEvent = OpencodeEventV2

export type OptimisticUserMessage = {
  attachments: AttachmentData[]
  createdAt: number
  id: string
  status: "failed" | "pending"
  text: string
}

type UseOpencodeChatResult = {
  applyOptimisticSession: (info: SessionV2) => void
  blocked: boolean
  loadError?: string
  isBusy: boolean
  isPending: boolean
  localMessages: OptimisticUserMessage[]
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  permissionRequest?: PermissionRequest
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  questionRequest?: QuestionRequest
  session?: SessionV2
  sessionCost: number
  sessionStatus?: SessionStatus
  reload: () => void
  reconnectStream: () => void
  streamError?: string
  textByPart: Record<string, string>
  todos: Todo[]
}

const idleSessionStatus: SessionStatus = { type: "idle" }
const MAX_CHAT_TURNS = 25

// Keep only the newest MAX_CHAT_TURNS user turns and their replies, so a reply
// never outlives the user turn it belongs to.
function visibleMessageIDsForRecentTurns(messages: Message[]): Set<string> {
  const ordered = [...messages].sort((x, y) => x.time.created - y.time.created)
  const userIDs = ordered
    .filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    .map((message) => message.id)
  const visibleUserIDs = new Set(userIDs.slice(-MAX_CHAT_TURNS))
  const visibleMessageIDs = new Set<string>()

  for (const message of ordered) {
    if (message.role === "user") {
      if (visibleUserIDs.has(message.id)) {
        visibleMessageIDs.add(message.id)
      }
      continue
    }

    if (visibleUserIDs.has(message.parentID)) {
      visibleMessageIDs.add(message.id)
    }
  }

  return visibleMessageIDs
}

function pruneStore(store: OpencodeChatStore): OpencodeChatStore {
  const nextMessage = Object.fromEntries(
    Object.entries(store.message).map(([sessionID, messages]) => {
      const visibleMessageIDs = visibleMessageIDsForRecentTurns(messages)
      return [sessionID, messages.filter((message) => visibleMessageIDs.has(message.id))]
    })
  )
  const visibleMessageIDs = new Set(
    Object.values(nextMessage).flatMap((messages) => messages.map((message) => message.id))
  )
  const nextPart = Object.fromEntries(
    Object.entries(store.part).filter(([messageID]) => visibleMessageIDs.has(messageID))
  )
  const visiblePartIDs = new Set(
    Object.values(nextPart).flatMap((parts) => parts.map((part) => part.id))
  )
  const nextText = Object.fromEntries(
    Object.entries(store.partTextAccumDelta).filter(([partID]) => visiblePartIDs.has(partID))
  )

  return {
    ...store,
    message: nextMessage,
    part: nextPart,
    partTextAccumDelta: nextText,
  }
}

function deriveSessionIsBusy(
  messages: Message[],
  localMessages: OptimisticUserMessage[],
  sessionStatus: SessionStatus | undefined,
  session: SessionV2 | undefined
): boolean {
  if (localMessages.some((message) => message.status === "pending")) {
    return true
  }

  // Compaction rewrites the store, so the message heuristics below are unreliable.
  if (session?.time.compacting) {
    return true
  }

  const last = messages.at(-1)

  // The server sets time.completed in a finalizer on every turn exit (success,
  // error, abort), so trust it over a possibly-stale "busy" status to avoid
  // hanging at "Working". A "retry" status still means the turn will re-run.
  if (
    last?.role === "assistant" &&
    last.time.completed !== undefined &&
    sessionStatus?.type !== "retry"
  ) {
    return false
  }

  if (sessionStatus && sessionStatus.type !== "idle") {
    return true
  }

  if (!last) return false
  if (last.role === "user") return true
  if (last.role === "assistant" && last.time.completed === undefined) return true

  return false
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
  if (parts.some((part) => part.id === next.id)) {
    return parts.map((part) => (part.id === next.id ? next : part))
  }
  // Part ids are monotonic ascending, so insert at the sorted position to keep
  // chronological order even if a late update arrives out of sequence.
  const at = parts.findIndex((part) => part.id > next.id)
  return at < 0 ? [...parts, next] : [...parts.slice(0, at), next, ...parts.slice(at)]
}

function buildStore(
  sessionID: string,
  session: SessionV2 | undefined,
  records: SessionMessageRecord[]
) {
  const store: OpencodeChatStore = {
    part: {},
    partTextAccumDelta: {},
    message: {},
    session,
    todos: {},
  }
  const visibleMessageIDs = visibleMessageIDsForRecentTurns(records.map((record) => record.info))
  const visibleRecords = records.filter((record) => visibleMessageIDs.has(record.info.id))
  store.message[sessionID] = visibleRecords
    .map((record) => record.info)
    .sort((x, y) => x.time.created - y.time.created)

  for (const record of visibleRecords) {
    store.part[record.info.id] = record.parts

    for (const part of record.parts) {
      if (part.type !== "text" && part.type !== "reasoning") continue
      store.partTextAccumDelta[part.id] = part.text
    }
  }

  return pruneStore(store)
}

function upsertRequest<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) {
    return [...items, next]
  }

  return items.map((item) => {
    if (item.id === next.id) return next
    return item
  })
}

function removeRequest<T extends { id: string }>(items: T[], requestID: string) {
  return items.filter((item) => item.id !== requestID)
}

function buildRequestMap<T extends { sessionID: string }>(items: T[]) {
  const result: Record<string, T[]> = {}

  for (const item of items) {
    const existing = result[item.sessionID] ?? []
    result[item.sessionID] = [...existing, item]
  }

  return result
}

function visibleSessionIDs(sessions: SessionV2[], sessionID: string) {
  const childMap = sessions.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID) ?? []
    list.push(item.id)
    acc.set(item.parentID, list)
    return acc
  }, new Map<string, string[]>())

  const result = [sessionID]
  const seen = new Set(result)

  for (const id of result) {
    const children = childMap.get(id) ?? []
    for (const childID of children) {
      if (seen.has(childID)) continue
      seen.add(childID)
      result.push(childID)
    }
  }

  return result
}

function firstVisibleRequest<T extends { sessionID: string }>(
  requests: Record<string, T[]>,
  sessions: SessionV2[],
  sessionID?: string
) {
  if (!sessionID) return undefined

  for (const id of visibleSessionIDs(sessions, sessionID)) {
    const request = requests[id]?.[0]
    if (request) return request
  }

  return undefined
}

function applyEvent(store: OpencodeChatStore, event: StreamEvent): OpencodeChatStore {
  switch (event.type) {
    case "message.updated": {
      const sessionID = event.properties.sessionID
      const messages = store.message[sessionID] ?? []

      return pruneStore({
        ...store,
        message: {
          ...store.message,
          [sessionID]: upsertMessage(messages, event.properties.info),
        },
      })
    }

    case "message.removed": {
      const sessionID = event.properties.sessionID
      const messages = store.message[sessionID] ?? []

      return pruneStore({
        ...store,
        message: {
          ...store.message,
          [sessionID]: messages.filter((message) => message.id !== event.properties.messageID),
        },
      })
    }

    case "message.part.updated": {
      const part = event.properties.part
      const parts = store.part[part.messageID] ?? []
      if (part.type !== "text" && part.type !== "reasoning") {
        return { ...store, part: { ...store.part, [part.messageID]: upsertPart(parts, part) } }
      }
      // Keep already-accumulated deltas when the snapshot lags behind them, so
      // streamed text never flickers backward mid-turn.
      const accumulated = store.partTextAccumDelta[part.id]
      const text = accumulated?.startsWith(part.text) ? accumulated : part.text
      return {
        ...store,
        part: { ...store.part, [part.messageID]: upsertPart(parts, { ...part, text }) },
        partTextAccumDelta: { ...store.partTextAccumDelta, [part.id]: text },
      }
    }

    case "message.part.delta": {
      const { delta, field, messageID, partID } = event.properties
      const parts = store.part[messageID] ?? []
      const part = parts.find((item) => item.id === partID)
      // Only text/reasoning parts stream, and only via their `text` field.
      if (field !== "text" || (part?.type !== "text" && part?.type !== "reasoning")) {
        return store
      }
      const text = (store.partTextAccumDelta[partID] ?? "") + delta
      return {
        ...store,
        part: {
          ...store.part,
          [messageID]: parts.map((item) => (item.id === partID ? { ...part, text } : item)),
        },
        partTextAccumDelta: { ...store.partTextAccumDelta, [partID]: text },
      }
    }

    case "message.part.removed": {
      const { messageID, partID } = event.properties
      const nextText = { ...store.partTextAccumDelta }
      delete nextText[partID]
      return {
        ...store,
        part: {
          ...store.part,
          [messageID]: (store.part[messageID] ?? []).filter((part) => part.id !== partID),
        },
        partTextAccumDelta: nextText,
      }
    }

    case "todo.updated": {
      // Empty todos means the agent finished; drop the key so the dock unmounts.
      const sessionID = event.properties.sessionID
      const nextTodos = { ...store.todos }
      if (event.properties.todos.length === 0) {
        delete nextTodos[sessionID]
      } else {
        nextTodos[sessionID] = event.properties.todos
      }
      return { ...store, todos: nextTodos }
    }

    case "session.created":
    case "session.updated":
      return store.session?.id === event.properties.info.id
        ? { ...store, session: event.properties.info }
        : store

    case "session.deleted":
      return store.session?.id === event.properties.info.id
        ? { ...store, session: undefined }
        : store

    default:
      return store
  }
}

function applyHitlEvent(store: HitlStore, event: StreamEvent): HitlStore {
  switch (event.type) {
    case "permission.asked": {
      const sessionID = event.properties.sessionID
      const current = store.permissions[sessionID] ?? []

      return {
        ...store,
        permissions: {
          ...store.permissions,
          [sessionID]: upsertRequest(current, event.properties),
        },
      }
    }

    case "permission.replied": {
      const sessionID = event.properties.sessionID
      const current = store.permissions[sessionID] ?? []

      return {
        ...store,
        permissions: {
          ...store.permissions,
          [sessionID]: removeRequest(current, event.properties.requestID),
        },
      }
    }

    case "question.asked": {
      const sessionID = event.properties.sessionID
      const current = store.questions[sessionID] ?? []

      return {
        ...store,
        questions: {
          ...store.questions,
          [sessionID]: upsertRequest(current, event.properties),
        },
      }
    }

    case "question.replied":
    case "question.rejected": {
      const sessionID = event.properties.sessionID
      const current = store.questions[sessionID] ?? []

      return {
        ...store,
        questions: {
          ...store.questions,
          [sessionID]: removeRequest(current, event.properties.requestID),
        },
      }
    }

    case "session.created": {
      const info = event.properties.info
      const current = store.sessions.filter((item) => item.id !== info.id)
      return {
        ...store,
        sessions: [...current, info],
      }
    }

    case "session.updated": {
      const info = event.properties.info
      return {
        ...store,
        sessions: store.sessions.map((item) => {
          if (item.id === info.id) return info
          return item
        }),
      }
    }

    case "session.deleted":
      return {
        ...store,
        permissions: Object.fromEntries(
          Object.entries(store.permissions).filter(([id]) => id !== event.properties.info.id)
        ),
        questions: Object.fromEntries(
          Object.entries(store.questions).filter(([id]) => id !== event.properties.info.id)
        ),
        sessions: store.sessions.filter((item) => item.id !== event.properties.info.id),
      }

    default:
      return store
  }
}

function chatOverlayQueryKey(agentName: string, sessionID?: string) {
  return ["opencode", "chatOverlay", agentName, sessionID ?? "new"] as const
}

export function sessionInfoQueryKey(agentName: string, sessionID: string) {
  return ["opencode", "sessionInfo", agentName, sessionID] as const
}

function sessionMessagesBaseQueryKey(agentName: string, sessionID: string) {
  return ["opencode", "sessionMessages", agentName, sessionID] as const
}

export function upsertOptimisticUserMessage(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  message: OptimisticUserMessage
) {
  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      const draft = current ? [...current] : []
      const index = draft.findIndex((item) => item.id === message.id)
      if (index >= 0) {
        draft[index] = message
        return draft
      }

      draft.push(message)
      return draft.slice(-MAX_CHAT_TURNS)
    }
  )
}

export function markOptimisticUserMessageFailed(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  messageID: string
) {
  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      const draft = current ? [...current] : []
      return draft.map((item) => {
        if (item.id !== messageID) return item
        return {
          ...item,
          status: "failed",
        }
      })
    }
  )
}

function removeOptimisticUserMessage(
  queryClient: QueryClient,
  agentName: string,
  sessionID: string | undefined,
  messageID: string
) {
  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(agentName, sessionID),
    (current) => {
      const draft = current ? [...current] : []
      return draft.filter((item) => item.id !== messageID)
    }
  )
}

export function migrateChatOverlay(
  queryClient: QueryClient,
  agentName: string,
  fromSessionID: string | undefined,
  toSessionID: string
) {
  const current = queryClient.getQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(agentName, fromSessionID)
  )
  if (!current || current.length === 0) return

  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(agentName, toSessionID),
    current
  )
  queryClient.removeQueries({
    queryKey: chatOverlayQueryKey(agentName, fromSessionID),
    exact: true,
  })
}

function sessionInfoQueryOptions(agentName: string, sessionID: string) {
  return queryOptions({
    queryFn: async () => {
      const client = await createAgentOpencodeClient(agentName)
      const result = await client.session.get({
        sessionID,
      })

      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to load session"))
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
      const client = await createAgentOpencodeClient(agentName)
      const result = await client.session.messages({
        directory,
        sessionID,
      })

      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to load session messages"))
      }

      return result.data
    },
    queryKey: [...sessionMessagesBaseQueryKey(agentName, sessionID), directory] as const,
    retry: false,
    staleTime: 5_000,
  })
}

function sessionTreeQueryOptions(agentName: string, directory: string) {
  return queryOptions({
    queryFn: async () => {
      const client = await createAgentOpencodeClient(agentName)
      const [sessionResult, questionResult, permissionResult] = await Promise.all([
        client.session.list({
          directory,
          limit: 1000,
        }),
        client.question.list({
          directory,
        }),
        client.permission.list({
          directory,
        }),
      ])

      if (sessionResult.error) {
        throw new Error(opencodeErrorMessage(sessionResult.error, "Failed to load sessions"))
      }

      if (questionResult.error) {
        throw new Error(
          opencodeErrorMessage(questionResult.error, "Failed to load pending questions")
        )
      }

      if (permissionResult.error) {
        throw new Error(
          opencodeErrorMessage(permissionResult.error, "Failed to load pending permissions")
        )
      }

      return {
        permissions: buildRequestMap(permissionResult.data ?? []),
        questions: buildRequestMap(questionResult.data ?? []),
        sessions: sessionResult.data ?? [],
      } satisfies HitlStore
    },
    queryKey: ["opencode", "chatHitl", agentName, directory],
    retry: false,
    staleTime: 5_000,
  })
}

export function useOpencodeChat(agentName: string, sessionID?: string): UseOpencodeChatResult {
  const queryClient = useQueryClient()
  const [liveStore, setLiveStore] = useState<{
    key: string
    store: OpencodeChatStore
  }>()
  const [hitlLive, setHitlLive] = useState<{ key: number; store: HitlStore }>()
  const [streamError, setStreamError] = useState<string>()
  const [streamEpoch, setStreamEpoch] = useState(0)
  const session = useQuery({
    ...sessionInfoQueryOptions(agentName, sessionID ?? ""),
    enabled: Boolean(sessionID),
  })
  const history = useQuery({
    ...sessionMessagesQueryOptions(agentName, sessionID ?? "", session.data?.directory ?? ""),
    enabled: Boolean(sessionID && session.data?.directory),
  })
  const hitl = useQuery({
    ...sessionTreeQueryOptions(agentName, session.data?.directory ?? ""),
    enabled: Boolean(session.data?.directory),
  })
  const refetchSession = session.refetch
  const refetchHistory = history.refetch
  const refetchHitl = hitl.refetch
  const sessionStatusKey = [
    "opencode",
    "sessionStatus",
    agentName,
    session.data?.directory ?? "",
  ] as const
  const status = useQuery(
    queryOptions({
      enabled: Boolean(sessionID && session.data?.directory),
      queryFn: async () => {
        const client = await createAgentOpencodeClient(agentName)
        const result = await client.session.status({
          directory: session.data?.directory,
        })

        if (result.error || !result.data) {
          throw new Error(opencodeErrorMessage(result.error, "Failed to load session status"))
        }

        return result.data
      },
      queryKey: sessionStatusKey,
      refetchInterval: (query) => {
        if (!sessionID) return false
        const current = query.state.data?.[sessionID]
        return current && current.type !== "idle" ? 1_000 : false
      },
      retry: false,
    })
  )
  const refetchStatus = status.refetch
  const localMessages = useQuery({
    ...queryOptions({
      queryFn: (): OptimisticUserMessage[] => [],
      queryKey: chatOverlayQueryKey(agentName, sessionID),
      staleTime: Infinity,
    }),
    initialData: [],
  })

  const baseStore = useMemo(() => {
    if (!sessionID) {
      return {
        part: {},
        partTextAccumDelta: {},
        message: {},
        session: undefined,
        todos: {},
      }
    }

    return buildStore(sessionID, session.data, history.data ?? [])
  }, [history.data, session.data, sessionID])
  const baseStoreKey = useMemo(() => {
    const sessionKey = sessionID ?? "new"
    const historyCount = history.data?.length ?? 0
    const lastMessageID = history.data?.at(-1)?.info.id ?? "none"
    const sessionUpdatedAt = session.data?.time.updated ?? 0

    return `${sessionKey}:${sessionUpdatedAt}:${historyCount}:${lastMessageID}`
  }, [history.data, session.data?.time.updated, sessionID])
  const store = liveStore?.key === baseStoreKey ? liveStore.store : baseStore

  // HITL state reconciles like the chat store: live events fold onto the
  // refetched base, keyed to the fetch so a refetch drops stale events and the
  // server's pending set stays authoritative.
  const hitlBase = hitl.data ?? emptyHitlStore
  const hitlKey = hitl.dataUpdatedAt
  const hitlStore = hitlLive?.key === hitlKey ? hitlLive.store : hitlBase

  const flushEvents = useEffectEvent((events: StreamEvent[]) => {
    if (!sessionID) return

    let hasStoreUpdate = false
    const nextHitlEvents: StreamEvent[] = []

    for (const event of events) {
      // A provider-global error has no sessionID; still surface it here.
      if (event.type === "session.error") {
        const errorSessionID = event.properties.sessionID
        if (!errorSessionID || errorSessionID === sessionID) {
          const error = describeMessageError(event.properties.error)
          toast.error(error.label, {
            description: error.body,
            id: `chat:${agentName}:${sessionID}:session-error`,
          })
        }
      }

      if (event.type === "session.status") {
        queryClient.setQueryData<SessionStatusResponse>(sessionStatusKey, (current) => ({
          ...current,
          [event.properties.sessionID]: event.properties.status,
        }))
      }

      if (event.type === "session.idle") {
        queryClient.setQueryData<SessionStatusResponse>(sessionStatusKey, (current) => ({
          ...current,
          [event.properties.sessionID]: idleSessionStatus,
        }))
      }

      switch (event.type) {
        case "message.updated":
        case "message.removed":
        case "message.part.updated":
        case "message.part.delta":
        case "message.part.removed":
        case "session.created":
        case "session.updated":
        case "session.deleted":
        case "todo.updated":
          hasStoreUpdate = true
          break
        default:
          break
      }

      switch (event.type) {
        case "permission.asked":
        case "permission.replied":
        case "question.asked":
        case "question.replied":
        case "question.rejected":
        case "session.created":
        case "session.updated":
        case "session.deleted":
          nextHitlEvents.push(event)
          break
        default:
          break
      }
    }

    if (hasStoreUpdate) {
      setLiveStore((current) => ({
        key: baseStoreKey,
        store: events.reduce(applyEvent, current?.key === baseStoreKey ? current.store : baseStore),
      }))
    }

    if (nextHitlEvents.length > 0) {
      setHitlLive((current) => ({
        key: hitlKey,
        store: nextHitlEvents.reduce(
          applyHitlEvent,
          current?.key === hitlKey ? current.store : hitlBase
        ),
      }))
    }

    if (events.length > 0) {
      setStreamError(undefined)
    }
  })

  useEffect(() => {
    if (!sessionID || !session.data?.directory) return

    const directory = session.data.directory
    const abortController = new AbortController()
    const queue: StreamEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastFlush = 0

    function flushQueue() {
      if (queue.length === 0) return
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }

      const events = queue.splice(0)
      lastFlush = Date.now()
      flushEvents(events)
    }

    function scheduleFlush() {
      if (timer) return

      const elapsed = Date.now() - lastFlush
      const delay = elapsed >= 16 ? 0 : 16 - elapsed
      timer = setTimeout(() => {
        flushQueue()
      }, delay)
    }

    async function consume() {
      try {
        const client = await createAgentOpencodeClient(agentName)
        const result = await client.event.subscribe(
          {
            directory,
          },
          {
            signal: abortController.signal,
          }
        )

        for await (const event of result.stream) {
          if (abortController.signal.aborted) return

          queue.push(event)
          scheduleFlush()
        }

        flushQueue()
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
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [agentName, session.data?.directory, sessionID, streamEpoch])

  const messages = useMemo(() => {
    return sessionID ? (store.message[sessionID] ?? []) : []
  }, [sessionID, store.message])
  const partsByMessage = store.part
  const textByPart = store.partTextAccumDelta
  const permissionRequest = firstVisibleRequest(
    hitlStore.permissions,
    hitlStore.sessions,
    sessionID
  )
  const questionRequest =
    permissionRequest === undefined
      ? firstVisibleRequest(hitlStore.questions, hitlStore.sessions, sessionID)
      : undefined
  const permissions = useMemo(() => {
    if (!sessionID) return []
    return visibleSessionIDs(hitlStore.sessions, sessionID).flatMap(
      (id) => hitlStore.permissions[id] ?? []
    )
  }, [hitlStore.permissions, hitlStore.sessions, sessionID])
  const questions = useMemo(() => {
    if (!sessionID) return []
    return visibleSessionIDs(hitlStore.sessions, sessionID).flatMap(
      (id) => hitlStore.questions[id] ?? []
    )
  }, [hitlStore.questions, hitlStore.sessions, sessionID])
  const sessionStatus = sessionID ? (status.data?.[sessionID] ?? idleSessionStatus) : undefined

  useEffect(() => {
    if (!sessionID) return

    for (const localMessage of localMessages.data) {
      const match = messages.find((message) => {
        if (message.role !== "user") return false
        const parts = partsByMessage[message.id] ?? []
        const messageText = parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim()
          .replaceAll(/\s+/g, " ")
        const fileCount = parts.filter((part) => part.type === "file").length
        const optimisticText = localMessage.text.trim().replaceAll(/\s+/g, " ")

        // Match on any renderable part: attachment-only prompts have empty text,
        // so a text-only match would never clear them and would hang at "Working".
        const hasArrived = messageText.length > 0 || fileCount > 0

        return (
          hasArrived &&
          messageText === optimisticText &&
          fileCount === localMessage.attachments.length &&
          Math.abs(message.time.created - localMessage.createdAt) < 60_000
        )
      })

      if (!match) continue
      removeOptimisticUserMessage(queryClient, agentName, sessionID, localMessage.id)
    }
  }, [agentName, localMessages.data, messages, partsByMessage, queryClient, sessionID])

  const todos = useMemo(() => {
    if (!sessionID) return []
    return store.todos[sessionID] ?? []
  }, [sessionID, store.todos])

  const reload = useCallback(() => {
    if (sessionID) {
      void refetchSession()
    }
    if (sessionID && session.data?.directory) {
      void refetchHistory()
      void refetchHitl()
      void refetchStatus()
    }
  }, [
    refetchHistory,
    refetchHitl,
    refetchSession,
    refetchStatus,
    session.data?.directory,
    sessionID,
  ])

  // Fold an authoritative Session (e.g. a revert response) into the live store
  // instead of the query cache; seeding the cache flips back to baseStore, which
  // rebuilds messages from stale history.data and drops streamed turns.
  const applyOptimisticSession = useCallback(
    (info: SessionV2) => {
      setLiveStore((current) => {
        const currentStore = current?.key === baseStoreKey ? current.store : baseStore
        if (currentStore.session?.id !== info.id) return current
        return { key: baseStoreKey, store: { ...currentStore, session: info } }
      })
    },
    [baseStore, baseStoreKey]
  )

  const reconnectStream = useCallback(() => {
    setStreamError(undefined)
    setStreamEpoch((current) => current + 1)
    // Recover events missed during the disconnect so a turn that finished
    // mid-gap doesn't leave the UI stuck at "Working".
    void refetchHistory()
    void refetchStatus()
    if (sessionID) {
      void refetchSession()
    }
  }, [refetchHistory, refetchSession, refetchStatus, sessionID])

  return {
    applyOptimisticSession,
    blocked: permissionRequest !== undefined || questionRequest !== undefined,
    loadError: session.error?.message ?? history.error?.message ?? hitl.error?.message,
    isBusy: deriveSessionIsBusy(messages, localMessages.data, sessionStatus, store.session),
    isPending: Boolean(sessionID) && (session.isPending || history.isPending),
    localMessages: localMessages.data,
    messages,
    partsByMessage,
    permissionRequest,
    permissions,
    questions,
    questionRequest,
    reconnectStream,
    reload,
    session: store.session,
    sessionCost: messages.reduce(
      (total, m) => (m.role === "assistant" ? total + m.cost : total),
      0
    ),
    sessionStatus,
    streamError,
    textByPart,
    todos,
  }
}
