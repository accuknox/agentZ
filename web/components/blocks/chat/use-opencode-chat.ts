"use client"

import type {
  Event as OpencodeEventV2,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session as SessionV2,
  SessionStatus,
  SessionStatusResponse,
  Todo,
} from "@opencode-ai/sdk/v2"
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { useCallback, useEffectEvent, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { dayjs } from "@/lib/format"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { describeMessageError, opencodeErrorMessage } from "@/components/blocks/chat/errors"
import { attachmentFromPart, type ChatAttachment } from "@/components/blocks/chat/attachments"

type SessionMessageRecord = {
  info: Message
  parts: Part[]
}

type SessionMessagePage = {
  cursor?: string
  records: SessionMessageRecord[]
}

type SessionMessagePageParam = {
  before?: string
  limit: number
}

const historyMessagePageSize = 200

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
  attachments: ChatAttachment[]
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
  hasEarlierMessages: boolean
  isLoadingEarlier: boolean
  loadEarlier: () => Promise<void>
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
function deriveSessionIsBusy(
  messages: Message[],
  localMessages: OptimisticUserMessage[],
  sessionStatus: SessionStatus | undefined,
  session: SessionV2 | undefined
): boolean {
  // OpenCode owns the lifecycle. Message state only bridges bootstrap before
  // the first status snapshot arrives.
  if (sessionStatus) return sessionStatus.type !== "idle"
  if (localMessages.some((message) => message.status === "pending")) return true
  if (session?.time.compacting) return true

  const last = messages.at(-1)
  if (!last) return false
  if (last.role === "user") return true
  return last.role === "assistant" && last.time.completed === undefined
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

function mergeHistoryPage(
  store: OpencodeChatStore,
  sessionID: string,
  records: SessionMessageRecord[]
) {
  const known = new Set((store.message[sessionID] ?? []).map((message) => message.id))
  const messages = [...(store.message[sessionID] ?? [])]
  const part = { ...store.part }
  const partTextAccumDelta = { ...store.partTextAccumDelta }

  for (const record of records) {
    if (known.has(record.info.id)) continue

    known.add(record.info.id)
    messages.push(record.info)
    part[record.info.id] = record.parts
    for (const item of record.parts) {
      if (item.type !== "text" && item.type !== "reasoning") continue
      partTextAccumDelta[item.id] = item.text
    }
  }

  messages.sort((x, y) => x.time.created - y.time.created)
  return {
    ...store,
    message: { ...store.message, [sessionID]: messages },
    part,
    partTextAccumDelta,
  }
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

function chatOverlayQueryKey(workspaceId: string, agentName: string, chatID?: string) {
  return ["opencode", "chatOverlay", workspaceId, agentName, chatID ?? "new"] as const
}

export function sessionInfoQueryKey(workspaceId: string, agentName: string, sessionID: string) {
  return ["opencode", "sessionInfo", workspaceId, agentName, sessionID] as const
}

function sessionMessagesBaseQueryKey(workspaceId: string, agentName: string, sessionID: string) {
  return ["opencode", "sessionMessages", workspaceId, agentName, sessionID] as const
}

export function upsertOptimisticUserMessage(
  queryClient: QueryClient,
  workspaceId: string,
  agentName: string,
  chatID: string | undefined,
  message: OptimisticUserMessage
) {
  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(workspaceId, agentName, chatID),
    (current) => {
      const messages = [...(current ?? [])]
      const index = messages.findIndex((item) => item.id === message.id)
      if (index === -1) messages.push(message)
      else messages[index] = message
      return messages.slice(-50)
    }
  )
}

export function promoteChatOverlay(
  queryClient: QueryClient,
  workspaceId: string,
  agentName: string,
  draftID: string | undefined,
  sessionID: string
) {
  const messages = queryClient.getQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(workspaceId, agentName, draftID)
  )
  if (!messages?.length) return

  queryClient.setQueryData(chatOverlayQueryKey(workspaceId, agentName, sessionID), messages)
  queryClient.removeQueries({
    exact: true,
    queryKey: chatOverlayQueryKey(workspaceId, agentName, draftID),
  })
}

export function markOptimisticUserMessageFailed(
  queryClient: QueryClient,
  workspaceId: string,
  agentName: string,
  chatID: string | undefined,
  messageID: string
) {
  queryClient.setQueryData<OptimisticUserMessage[]>(
    chatOverlayQueryKey(workspaceId, agentName, chatID),
    (current) =>
      (current ?? []).map((item) => {
        if (item.id !== messageID) return item
        return {
          ...item,
          status: "failed",
        }
      })
  )
}

function sessionInfoQueryOptions(agentName: string, workspaceId: string, sessionID: string) {
  return queryOptions({
    queryFn: async ({ signal }) => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.session.get({ sessionID }, { signal })

      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to load session"))
      }

      return result.data
    },
    queryKey: sessionInfoQueryKey(workspaceId, agentName, sessionID),
    retry: false,
    staleTime: 60_000,
  })
}

function sessionMessagesQueryOptions(
  agentName: string,
  workspaceId: string,
  sessionID: string,
  directory: string
) {
  return infiniteQueryOptions({
    initialPageParam: { limit: 20 } satisfies SessionMessagePageParam,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: SessionMessagePageParam
      signal: AbortSignal
    }): Promise<SessionMessagePage> => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const records: SessionMessageRecord[] = []
      let before = pageParam.before
      let limit = pageParam.limit

      // OpenCode pages individual messages, while the timeline renders turns
      // rooted at user prompts. Follow cursors when a page starts inside an
      // assistant response.
      for (;;) {
        const result = await client.session.messages(
          {
            before,
            directory,
            limit,
            sessionID,
          },
          { signal }
        )

        if (result.error || !result.data) {
          throw new Error(opencodeErrorMessage(result.error, "Failed to load session messages"))
        }

        records.push(...result.data)
        const cursor = result.response.headers.get("X-Next-Cursor") ?? undefined
        if (!cursor || result.data[0]?.info.role !== "assistant") {
          return { cursor, records }
        }

        before = cursor
        limit = historyMessagePageSize
      }
    },
    getNextPageParam: (page): SessionMessagePageParam | undefined =>
      page.cursor ? { before: page.cursor, limit: historyMessagePageSize } : undefined,
    queryKey: [
      ...sessionMessagesBaseQueryKey(workspaceId, agentName, sessionID),
      directory,
    ] as const,
    retry: false,
    staleTime: 5_000,
  })
}

function sessionTreeQueryOptions(agentName: string, workspaceId: string, directory: string) {
  return queryOptions({
    queryFn: async () => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
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
    queryKey: ["opencode", "chatHitl", workspaceId, agentName, directory],
    retry: false,
    staleTime: 5_000,
  })
}

export function sessionStatusQueryOptions(
  agentName: string,
  workspaceId: string,
  directory: string
) {
  return queryOptions({
    queryFn: async () => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.session.status({ directory })

      if (result.error || !result.data) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to load session status"))
      }

      return result.data
    },
    queryKey: ["opencode", "sessionStatus", workspaceId, agentName, directory] as const,
    retry: false,
  })
}

export function useOpencodeChat(
  agentName: string,
  workspaceId: string,
  sessionID?: string,
  draftID?: string
): UseOpencodeChatResult {
  const queryClient = useQueryClient()
  const [liveStore, setLiveStore] = useState<{
    store: OpencodeChatStore
    version: object
  }>()
  const [hitlLive, setHitlLive] = useState<{ key: number; store: HitlStore }>()
  const [streamError, setStreamError] = useState<string>()
  const [streamEpoch, setStreamEpoch] = useState(0)
  const session = useQuery({
    ...sessionInfoQueryOptions(agentName, workspaceId, sessionID ?? ""),
    enabled: Boolean(sessionID),
  })
  const history = useInfiniteQuery({
    ...sessionMessagesQueryOptions(
      agentName,
      workspaceId,
      sessionID ?? "",
      session.data?.directory ?? ""
    ),
    enabled: false,
  })
  const { fetchNextPage: fetchNextHistoryPage } = history
  const hitl = useQuery({
    ...sessionTreeQueryOptions(agentName, workspaceId, session.data?.directory ?? ""),
    enabled: false,
  })
  const refetchSession = session.refetch
  const refetchHistory = history.refetch
  const refetchHitl = hitl.refetch
  const sessionStatusOptions = sessionStatusQueryOptions(
    agentName,
    workspaceId,
    session.data?.directory ?? ""
  )
  const sessionStatusKey = sessionStatusOptions.queryKey
  const status = useQuery({ ...sessionStatusOptions, enabled: false })
  const refetchStatus = status.refetch
  const localMessages = useQuery({
    ...queryOptions({
      queryFn: (): OptimisticUserMessage[] => [],
      queryKey: chatOverlayQueryKey(workspaceId, agentName, sessionID ?? draftID),
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

    const records = new Map<string, SessionMessageRecord>()
    for (const page of history.data?.pages ?? []) {
      for (const record of page.records) records.set(record.info.id, record)
    }
    return buildStore(sessionID, session.data, [...records.values()])
  }, [history.data, session.data, sessionID])
  // Loading another history page retains the first page object, while an
  // authoritative refetch replaces it. Session metadata refetches must not
  // discard messages received from the live stream.
  const firstHistoryPage = history.data?.pages[0]
  const baseStoreVersion = useMemo(
    () => ({ firstHistoryPage, sessionID }),
    [firstHistoryPage, sessionID]
  )
  const store = liveStore?.version === baseStoreVersion ? liveStore.store : baseStore

  // HITL state reconciles like the chat store: live events fold onto the
  // refetched base, keyed to the fetch so a refetch drops stale events and the
  // server's pending set stays authoritative.
  const hitlBase = hitl.data ?? emptyHitlStore
  const hitlKey = hitl.dataUpdatedAt
  const hitlStore = hitlLive?.key === hitlKey ? hitlLive.store : hitlBase

  const flushEvents = useEffectEvent((events: StreamEvent[]) => {
    if (!sessionID) return

    let hasStoreUpdate = false
    let refreshSession = false
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
        // The gateway persists the status response for the shared session
        // sidebar. Reconcile on the terminal event so its activity state does
        // not remain busy after the local event stream has settled.
        void refetchStatus()
        if (event.properties.sessionID === sessionID) refreshSession = true
      }

      if (
        event.type === "session.updated" &&
        event.properties.info.id === sessionID &&
        event.properties.info.title !== store.session?.title
      ) {
        refreshSession = true
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
        store: events.reduce(
          applyEvent,
          current?.version === baseStoreVersion ? current.store : baseStore
        ),
        version: baseStoreVersion,
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

    // Session GET responses update the gateway catalog. Title changes and the
    // terminal event both reconcile so a transient first fetch cannot leave
    // workspace sidebars stale.
    if (refreshSession) void refetchSession()
  })

  useEffect(() => {
    if (!sessionID || !session.data?.directory) return

    const directory = session.data.directory
    const abortController = new AbortController()
    const queue: StreamEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let lastFlush = 0

    function flushQueue() {
      if (queue.length === 0) return
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }

      const events = queue.splice(0)
      lastFlush = dayjs().valueOf()
      flushEvents(events)
    }

    function scheduleFlush() {
      if (flushTimer) return

      const elapsed = dayjs().valueOf() - lastFlush
      const delay = elapsed >= 16 ? 0 : 16 - elapsed
      flushTimer = setTimeout(() => {
        flushQueue()
      }, delay)
    }

    async function consume() {
      try {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const result = await client.event.subscribe(
          {
            directory,
          },
          {
            onSseError: () => {
              if (abortController.signal.aborted) return
              setStreamError("Connection lost. Reconnecting...")
            },
            signal: abortController.signal,
          }
        )

        for await (const event of result.stream) {
          if (abortController.signal.aborted) return

          if (event.type === "server.connected") {
            flushQueue()
            await Promise.all([refetchSession(), refetchHistory(), refetchHitl(), refetchStatus()])
            setStreamError(undefined)
            continue
          }

          queue.push(event)
          scheduleFlush()
        }

        flushQueue()
        if (abortController.signal.aborted) return

        setStreamError("Connection closed. Reconnecting...")
        reconnectTimer = setTimeout(() => {
          setStreamEpoch((current) => current + 1)
        }, 1_000)
      } catch {
        if (abortController.signal.aborted) return

        setStreamError("Failed to subscribe to session events. Reconnecting...")
        reconnectTimer = setTimeout(() => {
          setStreamEpoch((current) => current + 1)
        }, 1_000)
      }
    }

    void consume()

    return () => {
      abortController.abort()
      if (flushTimer) clearTimeout(flushTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [
    agentName,
    refetchHistory,
    refetchHitl,
    refetchSession,
    refetchStatus,
    session.data?.directory,
    sessionID,
    streamEpoch,
    workspaceId,
  ])

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
  const sessionStatus =
    sessionID && status.data ? (status.data[sessionID] ?? idleSessionStatus) : undefined
  const acknowledgedLocalMessageIDs = useMemo(() => {
    const ids = new Set<string>()
    const localByID = new Map(localMessages.data.map((message) => [message.id, message]))

    for (const message of messages) {
      if (message.role !== "user") continue
      const local = localByID.get(message.id)
      if (!local) continue

      const parts = partsByMessage[message.id] ?? []
      const hasText =
        local.text.length === 0 ||
        parts.some((part) => {
          if (part.type !== "text" || part.synthetic === true) return false
          return (textByPart[part.id] ?? part.text).length > 0
        })
      if (!hasText) continue

      const attachmentIDs = new Set(
        parts.flatMap((part) => {
          if (part.type !== "text") return []
          const attachment = attachmentFromPart(part)
          return attachment ? [attachment.id] : []
        })
      )
      if (!local.attachments.every((attachment) => attachmentIDs.has(attachment.id))) continue

      ids.add(message.id)
    }
    return ids
  }, [localMessages.data, messages, partsByMessage, textByPart])
  const visibleLocalMessages = useMemo(
    () => localMessages.data.filter((message) => !acknowledgedLocalMessageIDs.has(message.id)),
    [acknowledgedLocalMessageIDs, localMessages.data]
  )

  useEffect(() => {
    if (!sessionID) return
    if (!localMessages.data.some((message) => acknowledgedLocalMessageIDs.has(message.id))) return

    queryClient.setQueryData<OptimisticUserMessage[]>(
      chatOverlayQueryKey(workspaceId, agentName, sessionID),
      (current) => (current ?? []).filter((item) => !acknowledgedLocalMessageIDs.has(item.id))
    )
  }, [
    acknowledgedLocalMessageIDs,
    agentName,
    localMessages.data,
    queryClient,
    sessionID,
    workspaceId,
  ])

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
        const currentStore = current?.version === baseStoreVersion ? current.store : baseStore
        if (currentStore.session?.id !== info.id) return current
        return { store: { ...currentStore, session: info }, version: baseStoreVersion }
      })
    },
    [baseStore, baseStoreVersion]
  )

  const reconnectStream = useCallback(() => {
    setStreamError(undefined)
    setStreamEpoch((current) => current + 1)
  }, [])
  const loadEarlier = useCallback(async () => {
    if (!sessionID) return

    const result = await fetchNextHistoryPage({ cancelRefetch: false })
    const page = result.data?.pages.at(-1)
    if (!page) return

    setLiveStore((current) => ({
      store: mergeHistoryPage(
        current?.version === baseStoreVersion ? current.store : baseStore,
        sessionID,
        page.records
      ),
      version: baseStoreVersion,
    }))
  }, [baseStore, baseStoreVersion, fetchNextHistoryPage, sessionID])

  return {
    applyOptimisticSession,
    blocked: permissionRequest !== undefined || questionRequest !== undefined,
    loadError:
      session.error?.message ??
      history.error?.message ??
      hitl.error?.message ??
      status.error?.message,
    isBusy: deriveSessionIsBusy(messages, visibleLocalMessages, sessionStatus, store.session),
    hasEarlierMessages: history.hasNextPage,
    isLoadingEarlier: history.isFetchingNextPage,
    isPending: Boolean(sessionID) && (session.isPending || history.isPending),
    loadEarlier,
    localMessages: visibleLocalMessages,
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
