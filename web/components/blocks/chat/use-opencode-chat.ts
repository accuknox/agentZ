"use client"

import type {
  Event as StreamEvent,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionMessagesResponse2,
  SessionStatus,
  SessionStatusResponse,
  SnapshotFileDiff,
  Todo,
} from "@opencode-ai/sdk/v2"
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
  type Query,
  type InfiniteData,
} from "@tanstack/react-query"
import { useCallback, useEffectEvent, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { describeMessageError, opencodeErrorMessage } from "@/components/blocks/chat/errors"
import { chatCache } from "./cache"

type SessionMessageRecord = SessionMessagesResponse2[number]

type SessionMessagePage = {
  cursor?: string
  records: SessionMessageRecord[]
}

type SessionMessagePageParam = {
  before?: string
  limit: number
}

const historyMessagePageSize = 200

/*
 * Paragraph boundaries adapted from T3 Code's assistantStreaming.ts.
 * MIT License. Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const markdownFence = /^( *)(`{3,}|~{3,})/
const markdownListItem = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/
const markdownSection = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/
const markdownHeading = /^#{1,6}(?:[ \t]|$)/

// Keep unfinished paragraphs, section headings and fences out of the rendered
// prefix. The authoritative stream retains every character for completion.
function readyAssistantText(text: string): string {
  let fence = ""
  let fenceIndent = 0
  let boundary = 0
  let start = 0
  let title = false
  for (;;) {
    const newline = text.indexOf("\n", start)
    const line = text.slice(start, newline < 0 ? text.length : newline).replace(/[ \t\r]+$/, "")
    if (!fence && start > 0 && !title && markdownListItem.test(line)) boundary = start
    if (newline < 0) break
    const match = markdownFence.exec(line)
    if (match) {
      const marker = match[0].trimStart()
      const indent = match[0].length - marker.length
      if (!fence) {
        fence = marker
        fenceIndent = indent
        title = false
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        indent <= fenceIndent + 3 &&
        line.length === indent + marker.length
      ) {
        fence = ""
        boundary = newline + 1
      }
    } else if (!fence && /^[ \t]*$/.test(line) && start > 0) {
      if (!title) boundary = newline + 1
    } else if (!fence) {
      if (start > 0 && !title && markdownHeading.test(line)) boundary = start
      title = markdownSection.test(line)
    }
    start = newline + 1
  }
  return text.slice(0, boundary)
}

type OpencodeChatStore = {
  part: Record<string, Part[]>
  message: Record<string, Message[]>
  // Todos are keyed by sessionID and cleared whenever the turn that produced
  // them completes. Empty arrays collapse to "no todos" so the dock hides.
  todos: Record<string, Todo[]>
}

type HitlStore = {
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  sessions: Session[]
}

const emptyHitlStore: HitlStore = { permissions: {}, questions: {}, sessions: [] }

const idleSessionStatus: SessionStatus = { type: "idle" }
function deriveSessionIsBusy(
  messages: Message[],
  sessionStatus: SessionStatus | undefined,
  session: Session | undefined
): boolean {
  // OpenCode owns the lifecycle. Message state only bridges bootstrap before
  // the first status snapshot arrives.
  if (sessionStatus) return sessionStatus.type !== "idle"
  if (session?.time.compacting) return true

  const last = messages.at(-1)
  if (!last) return false
  if (last.role === "user") return true
  return last.time.completed === undefined
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

export function buildStore(sessionID: string, records: SessionMessageRecord[]) {
  const store: OpencodeChatStore = {
    part: {},
    message: {},
    todos: {},
  }
  store.message[sessionID] = records
    .map((record) => record.info)
    .sort((x, y) => x.time.created - y.time.created)

  for (const record of records) {
    store.part[record.info.id] = record.parts
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

  for (const record of records) {
    if (known.has(record.info.id)) continue

    known.add(record.info.id)
    messages.push(record.info)
    part[record.info.id] = record.parts
  }

  messages.sort((x, y) => x.time.created - y.time.created)
  return {
    ...store,
    message: { ...store.message, [sessionID]: messages },
    part,
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

function buildRequestMap<T extends { sessionID: string }>(items: T[]) {
  const result: Record<string, T[]> = {}

  for (const item of items) {
    const existing = result[item.sessionID] ?? []
    result[item.sessionID] = [...existing, item]
  }

  return result
}

function visibleSessionIDs(sessions: Session[], sessionID: string) {
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
  sessions: Session[],
  sessionID?: string
) {
  if (!sessionID) return undefined

  for (const id of visibleSessionIDs(sessions, sessionID)) {
    const request = requests[id]?.[0]
    if (request) return request
  }

  return undefined
}

export function applyEvent(store: OpencodeChatStore, event: StreamEvent): OpencodeChatStore {
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
      const part = { ...store.part }
      delete part[event.properties.messageID]

      return {
        ...store,
        part,
        message: {
          ...store.message,
          [sessionID]: messages.filter((message) => message.id !== event.properties.messageID),
        },
      }
    }

    case "message.part.updated": {
      const part = event.properties.part
      const parts = store.part[part.messageID] ?? []
      // A part update is an authoritative snapshot. Queued stream events can
      // overlap a history read, so reset the delta base to this snapshot.
      return {
        ...store,
        part: { ...store.part, [part.messageID]: upsertPart(parts, part) },
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
      const text = part.text + delta
      return {
        ...store,
        part: {
          ...store.part,
          [messageID]: parts.map((item) => (item.id === partID ? { ...part, text } : item)),
        },
      }
    }

    case "message.part.removed": {
      const { messageID, partID } = event.properties
      return {
        ...store,
        part: {
          ...store.part,
          [messageID]: (store.part[messageID] ?? []).filter((part) => part.id !== partID),
        },
      }
    }

    case "todo.updated": {
      // Empty todos means the agent finished; drop the key so the dock unmounts.
      const sessionID = event.properties.sessionID
      const nextTodos = { ...store.todos }
      nextTodos[sessionID] = event.properties.todos
      if (event.properties.todos.length === 0) {
        delete nextTodos[sessionID]
      }
      return { ...store, todos: nextTodos }
    }

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
          [sessionID]: current.filter((item) => item.id !== event.properties.requestID),
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
          [sessionID]: current.filter((item) => item.id !== event.properties.requestID),
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

export function sessionInfoQueryOptions(agentName: string, workspaceId: string, sessionID: string) {
  return queryOptions({
    queryFn: async ({ signal, client: queryClient, queryKey }): Promise<Session | null> => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.session.get({ sessionID }, { signal })
      signal.throwIfAborted()

      if (result.error || !result.data) {
        // The SDK omits the response when fetch fails before receiving HTTP.
        const status = result.response?.status
        if (status === 401 || status === 403 || status === 404) {
          await removeSessionState(queryClient, agentName, workspaceId, sessionID)
        }
        throw new Error(opencodeErrorMessage(result.error, "Failed to load session"))
      }

      // An event may have advanced metadata while this snapshot was in flight.
      const current = queryClient.getQueryData<Session | null>(queryKey)
      if (current && current.time.updated > result.data.time.updated) {
        return current
      }
      return result.data
    },
    queryKey: ["opencode", "sessionInfo", workspaceId, agentName, sessionID] as const,
    retry: false,
    staleTime: 60_000,
  })
}

// removeSessionState quarantines an unavailable chat and cancels reads before
// clearing its transcript, drafts and previews. The metadata tombstone also
// rejects delayed stream updates until a fresh authorized read succeeds.
export async function removeSessionState(
  queryClient: QueryClient,
  agentName: string,
  workspaceId: string,
  sessionID: string
) {
  const info = sessionInfoQueryOptions(agentName, workspaceId, sessionID)
  const matches = (query: Query) => {
    const key = query.queryKey
    if (key[0] === "opencode")
      return key[2] === workspaceId && key[3] === agentName && key[4] === sessionID
    if (key[0] === "chatInputs" || key[0] === "chatPreview" || key[0] === "chatQuestionDraft")
      return key[1] === workspaceId && key[2] === agentName && key[3] === sessionID
    return (
      (key[0] === "chatDraft" || key[0] === "chatScroll" || key[0] === "chatPreparedInput") &&
      key[1] === workspaceId &&
      key[2] === agentName &&
      key[4] === sessionID
    )
  }
  await queryClient.cancelQueries({ predicate: matches })
  queryClient.setQueryData(info.queryKey, null)
  await queryClient.invalidateQueries({ queryKey: info.queryKey, exact: true, refetchType: "none" })
  queryClient.removeQueries({
    predicate: (query) => matches(query) && query.queryKey[1] !== "sessionInfo",
  })
  await chatCache.clear([workspaceId, agentName, sessionID])
}

// reconcileHistory preserves page boundaries while folding live records back
// into cached history. Removed turns and their parts cannot reappear on return.
function reconcileHistory(
  history: InfiniteData<SessionMessagePage>,
  sessionID: string,
  store: OpencodeChatStore
): InfiniteData<SessionMessagePage> {
  const records = new Map(
    (store.message[sessionID] ?? []).map((info) => [
      info.id,
      { info, parts: store.part[info.id] ?? [] },
    ])
  )
  const older = new Set(
    history.pages.slice(1).flatMap((page) => page.records.map(({ info }) => info.id))
  )
  return {
    ...history,
    pages: history.pages.map((page, index) => ({
      ...page,
      records:
        index === 0
          ? [...records.values()].filter(({ info }) => !older.has(info.id))
          : page.records.flatMap(({ info }) => {
              const record = records.get(info.id)
              return record ? [record] : []
            }),
    })),
  }
}

// Creation, stream events and revert responses all publish the same metadata.
export async function updateSessionInfo(
  queryClient: QueryClient,
  agentName: string,
  workspaceId: string,
  info: Session
) {
  const { queryKey } = sessionInfoQueryOptions(agentName, workspaceId, info.id)
  await queryClient.cancelQueries({ queryKey, exact: true })
  queryClient.setQueryData(queryKey, (current) => {
    if (current === null || (current && current.time.updated > info.time.updated)) return current
    return info
  })
}

// OpenCode's session totals are placeholders; only message summaries contain
// real diffs. Read backward so long sessions need only their latest turn.
export function sessionDiffQueryOptions(agentName: string, workspaceId: string, sessionID: string) {
  return queryOptions({
    queryKey: ["opencode", "sessionDiff", workspaceId, agentName, sessionID] as const,
    queryFn: async ({
      signal,
    }): Promise<Pick<SnapshotFileDiff, "additions" | "deletions"> | null> => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const session = await client.session.get({ sessionID }, { signal })
      if (session.error || !session.data) {
        throw new Error(opencodeErrorMessage(session.error, "Failed to load session"))
      }

      const boundary = session.data.revert?.messageID
      const completed = new Set<string>()
      let before: string | undefined
      for (;;) {
        const result = await client.session.messages({ sessionID, before, limit: 20 }, { signal })
        if (result.error || !result.data) {
          throw new Error(opencodeErrorMessage(result.error, "Failed to load session changes"))
        }

        for (const { info } of result.data.toReversed()) {
          if (boundary && info.id >= boundary) continue
          if (info.role === "assistant") {
            if (
              info.time.completed &&
              (info.error || (info.finish && !["tool-calls", "unknown"].includes(info.finish)))
            ) {
              completed.add(info.parentID)
            }
            continue
          }
          if (!completed.has(info.id) || !info.summary) continue
          return info.summary.diffs.reduce(
            (total, diff) => ({
              additions: total.additions + diff.additions,
              deletions: total.deletions + diff.deletions,
            }),
            { additions: 0, deletions: 0 }
          )
        }

        before = result.response.headers.get("X-Next-Cursor") ?? undefined
        if (!before) return null
      }
    },
    retry: false,
    staleTime: 60_000,
  })
}

export function sessionMessagesQueryOptions(
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
      "opencode",
      "sessionMessages",
      workspaceId,
      agentName,
      sessionID,
      directory,
    ] as const,
    // The SSE connection owns reconciliation, including browser reconnects.
    refetchOnMount: (query) => query.state.isInvalidated,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 5_000,
  })
}

function sessionTreeQueryOptions(agentName: string, workspaceId: string, directory: string) {
  return queryOptions({
    queryFn: async ({ signal }) => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const [sessionResult, questionResult, permissionResult] = await Promise.all([
        client.session.list({ directory, limit: 1000 }, { signal }),
        client.question.list({ directory }, { signal }),
        client.permission.list({ directory }, { signal }),
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

function sessionStatusQueryOptions(agentName: string, workspaceId: string, directory: string) {
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
  userID?: string
) {
  const queryClient = useQueryClient()
  const [liveStore, setLiveStore] = useState<{
    store: OpencodeChatStore
    version: object
  }>()
  const [streamError, setStreamError] = useState<string>()
  const [streamEpoch, setStreamEpoch] = useState(0)
  const sessionOptions = sessionInfoQueryOptions(agentName, workspaceId, sessionID ?? "")
  const [openingSession] = useState(() => queryClient.getQueryState(sessionOptions.queryKey))
  const session = useQuery({
    ...sessionOptions,
    enabled: Boolean(sessionID),
  })
  const previewKey = JSON.stringify([userID, workspaceId, agentName, sessionID])
  const historyOptions = sessionMessagesQueryOptions(
    agentName,
    workspaceId,
    sessionID ?? "",
    session.data?.directory ?? ""
  )
  const [openingHistory] = useState(() => queryClient.getQueryState(historyOptions.queryKey))
  const history = useInfiniteQuery({
    ...historyOptions,
    enabled: Boolean(sessionID && session.data?.directory),
  })
  const preview = useQuery(
    queryOptions({
      queryKey: ["chatPreview", workspaceId, agentName, sessionID, previewKey],
      queryFn: async () => (await chatCache.read(previewKey)) ?? null,
      enabled: Boolean(userID && sessionID && !history.data),
      staleTime: Infinity,
      gcTime: 0,
    })
  )
  const { fetchNextPage: fetchNextHistoryPage } = history
  const hitlOptions = sessionTreeQueryOptions(agentName, workspaceId, session.data?.directory ?? "")
  const hitl = useQuery({
    ...hitlOptions,
    enabled: Boolean(sessionID && session.data?.directory),
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
  const status = useQuery({
    ...sessionStatusOptions,
    enabled: Boolean(sessionID && session.data?.directory),
  })
  const refetchStatus = status.refetch
  const sessionUnavailable = session.data === null
  const authorized = session.data !== null && session.data !== undefined
  const sessionReady =
    !openingSession?.isInvalidated || session.dataUpdatedAt !== openingSession.dataUpdatedAt
  const historyReady =
    !openingHistory?.isInvalidated || history.dataUpdatedAt !== openingHistory.dataUpdatedAt
  const previewRecords =
    authorized && !history.data && !openingSession?.isInvalidated ? preview.data : undefined
  const baseStore = useMemo(() => {
    if (!sessionID || !authorized || !sessionReady || !historyReady) {
      return {
        part: {},
        message: {},
        todos: {},
      }
    }

    const records = new Map<string, SessionMessageRecord>()
    for (const record of previewRecords ?? []) records.set(record.info.id, record)
    for (const page of history.data?.pages ?? []) {
      for (const record of page.records) records.set(record.info.id, record)
    }
    return buildStore(sessionID, [...records.values()])
  }, [authorized, history.data, historyReady, sessionID, sessionReady, previewRecords])
  // Loading another history page retains the first page object, while an
  // authoritative refetch replaces it. Session metadata refetches must not
  // discard messages received from the live stream.
  const firstHistoryPage = history.data?.pages[0]
  const baseStoreVersion = useMemo(
    () => ({ firstHistoryPage, sessionID }),
    [firstHistoryPage, sessionID]
  )
  const store = sessionUnavailable
    ? baseStore
    : liveStore?.version === baseStoreVersion
      ? liveStore.store
      : baseStore

  const hitlStore = hitl.data ?? emptyHitlStore

  const flushEvents = useEffectEvent((events: StreamEvent[]) => {
    if (!sessionID) return

    const storeEvents: StreamEvent[] = []
    let refreshSession = false
    const changedDiffs = new Set<string>()
    const nextHitlEvents: StreamEvent[] = []
    const inactive = new Map<string, StreamEvent[]>()
    const removed = new Set<string>()

    for (const event of events) {
      if (event.type === "message.removed" || event.type === "message.part.removed")
        removed.add(event.properties.sessionID)
      switch (event.type) {
        case "message.updated":
          if (
            (event.properties.info.role === "user" && event.properties.info.summary) ||
            (event.properties.info.role === "assistant" && event.properties.info.time.completed)
          ) {
            changedDiffs.add(event.properties.info.sessionID)
          }
          break
        case "message.removed":
        case "session.idle":
          changedDiffs.add(event.properties.sessionID)
          break
        case "session.updated":
          changedDiffs.add(event.properties.info.id)
          break
      }

      // A provider-global error has no sessionID; still surface it here.
      if (event.type === "session.error") {
        const errorSessionID = event.properties.sessionID
        if (!errorSessionID || errorSessionID === sessionID) {
          const error = describeMessageError(event.properties.error)
          if (!error.guardrail || !errorSessionID) {
            toast.error(error.label, {
              description: error.body,
              id: `chat:${agentName}:${sessionID}:session-error`,
            })
          }
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
        if (event.properties.sessionID === sessionID) refreshSession = true
      }

      switch (event.type) {
        case "message.updated":
        case "message.removed":
        case "message.part.updated":
        case "message.part.delta":
        case "message.part.removed":
        case "todo.updated":
          if (event.properties.sessionID === sessionID) storeEvents.push(event)
          else if (event.type !== "todo.updated") {
            const events = inactive.get(event.properties.sessionID) ?? []
            events.push(event)
            inactive.set(event.properties.sessionID, events)
          }
          break
        default:
          break
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        void updateSessionInfo(queryClient, agentName, workspaceId, event.properties.info)
      }
      if (event.type === "session.deleted") {
        void removeSessionState(queryClient, agentName, workspaceId, event.properties.info.id)
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

    for (const id of removed) void chatCache.clear([workspaceId, agentName, id])

    for (const [id, events] of inactive) {
      const queryKey = sessionMessagesQueryOptions(agentName, workspaceId, id, "").queryKey.slice(
        0,
        -1
      )
      void queryClient.cancelQueries({ queryKey }).then(() => {
        queryClient.setQueriesData<InfiniteData<SessionMessagePage>>({ queryKey }, (history) => {
          if (!history) return history
          const base = buildStore(
            id,
            history.pages.flatMap((page) => page.records)
          )
          return reconcileHistory(history, id, events.reduce(applyEvent, base))
        })
      })
    }

    for (const id of changedDiffs) {
      const { queryKey } = sessionDiffQueryOptions(agentName, workspaceId, id)
      // Cancel initial reads too, so an older response cannot replace a diff
      // published while that read was in flight.
      void queryClient
        .cancelQueries({ queryKey })
        .then(() => queryClient.invalidateQueries({ queryKey }))
    }

    if (storeEvents.length > 0) {
      setLiveStore((current) => ({
        store: storeEvents.reduce(
          applyEvent,
          current?.version === baseStoreVersion ? current.store : baseStore
        ),
        version: baseStoreVersion,
      }))
    }

    if (nextHitlEvents.length > 0) {
      // A pending snapshot must not resurrect a question already answered
      // while navigating back. Keep events in the same cache as snapshots.
      void queryClient.cancelQueries({ queryKey: hitlOptions.queryKey, exact: true }).then(() => {
        queryClient.setQueryData(hitlOptions.queryKey, (current) =>
          current ? nextHitlEvents.reduce(applyHitlEvent, current) : current
        )
      })
    }

    // SSE already supplies final parts and removals. Refetching a moving
    // history page on completion replaces mounted turns and their geometry.
    if (refreshSession) void refetchSession()
  })

  useEffect(() => {
    if (!sessionID || !session.data?.directory) return

    const directory = session.data.directory
    const { queryKey } = sessionDiffQueryOptions(agentName, workspaceId, sessionID)
    const sessionKey = sessionInfoQueryOptions(agentName, workspaceId, sessionID).queryKey.slice(
      0,
      -1
    )
    const abortController = new AbortController()
    const queue: StreamEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    function flushQueue() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      if (queue.length === 0) return
      const events = queue.splice(0)
      flushEvents(events)
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
              void queryClient.invalidateQueries({
                queryKey: sessionKey,
                refetchType: "none",
              })
              void refetchSession()
              setStreamError("Connection lost. Reconnecting...")
            },
            signal: abortController.signal,
          }
        )

        for await (const event of result.stream) {
          if (abortController.signal.aborted) return

          if (event.type === "server.connected") {
            flushQueue()
            void queryClient.invalidateQueries({
              queryKey: queryKey.slice(0, -1),
            })
            await Promise.all([refetchSession(), refetchHistory(), refetchHitl(), refetchStatus()])
            setStreamError(undefined)
            continue
          }

          // Bound raw delta processing; visible paragraphs are gated below.
          // Lifecycle events flush preceding text immediately, so approvals
          // and final output never wait. Only adjacent deltas can safely merge.
          if (event.type === "message.part.delta" && event.properties.field === "text") {
            const previous = queue.at(-1)
            if (
              previous?.type === "message.part.delta" &&
              previous.properties.sessionID === event.properties.sessionID &&
              previous.properties.messageID === event.properties.messageID &&
              previous.properties.partID === event.properties.partID &&
              previous.properties.field === event.properties.field
            ) {
              queue[queue.length - 1] = {
                ...event,
                properties: {
                  ...event.properties,
                  delta: previous.properties.delta + event.properties.delta,
                },
              }
            } else {
              queue.push(event)
            }
            if (queue.length >= 512) flushQueue()
            else flushTimer ??= setTimeout(flushQueue, 50)
            continue
          }
          queue.push(event)
          flushQueue()
        }

        flushQueue()
        if (abortController.signal.aborted) return

        void queryClient.invalidateQueries({
          queryKey: sessionKey,
          refetchType: "none",
        })
        void refetchSession()
        setStreamError("Connection closed. Reconnecting...")
        reconnectTimer = setTimeout(() => {
          setStreamEpoch((current) => current + 1)
        }, 1_000)
      } catch {
        if (abortController.signal.aborted) return
        flushQueue()
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
    queryClient,
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
  const permissionRequest = firstVisibleRequest(
    hitlStore.permissions,
    hitlStore.sessions,
    sessionID
  )
  const questionRequest =
    permissionRequest === undefined
      ? firstVisibleRequest(hitlStore.questions, hitlStore.sessions, sessionID)
      : undefined
  const sessionStatus =
    sessionID && status.data ? (status.data[sessionID] ?? idleSessionStatus) : undefined
  const isBusy = deriveSessionIsBusy(messages, sessionStatus, session.data ?? undefined)
  const publishHistory = useEffectEvent(async (leaving: boolean) => {
    if (
      !sessionID ||
      !firstHistoryPage ||
      sessionUnavailable ||
      !liveStore ||
      liveStore.version !== baseStoreVersion
    )
      return
    if (history.isFetching && !leaving) return
    if (leaving) await queryClient.cancelQueries({ queryKey: historyOptions.queryKey, exact: true })
    const info = sessionInfoQueryOptions(agentName, workspaceId, sessionID)
    // Logout and deletion clear metadata before unmounting this view.
    if (!queryClient.getQueryData(info.queryKey)) return
    queryClient.setQueryData<InfiniteData<SessionMessagePage>>(
      historyOptions.queryKey,
      (current) => (current ? reconcileHistory(current, sessionID, liveStore.store) : current)
    )
  })
  useEffect(() => {
    if (!isBusy) void publishHistory(false)
  }, [isBusy, liveStore, baseStoreVersion, history.isFetching])
  useEffect(
    () => () => {
      void publishHistory(true)
    },
    [sessionID]
  )
  useEffect(() => {
    if (!userID || !sessionID || !authorized || !history.data || session.error || isBusy) return
    // Persist settled live text without refetching or serializing each chunk.
    const records = messages.slice(-40).map((info) => ({
      info,
      parts: store.part[info.id] ?? [],
    }))
    return chatCache.schedule(previewKey, [workspaceId, agentName, sessionID], records)
  }, [
    userID,
    sessionID,
    authorized,
    history.data,
    session.error,
    isBusy,
    messages,
    store.part,
    previewKey,
    workspaceId,
    agentName,
  ])
  const bufferText =
    isBusy && !permissionRequest && !questionRequest && sessionStatus?.type !== "retry"
  const streamingParts = useMemo(
    () =>
      bufferText
        ? messages.flatMap((message) =>
            message.role === "assistant" && !message.time.completed && !message.error
              ? (store.part[message.id] ?? []).filter(
                  (part): part is Extract<Part, { type: "text" }> =>
                    part.type === "text" && part.time?.end === undefined
                )
              : []
          )
        : [],
    [bufferText, messages, store.part]
  )
  const [publishedText, setPublishedText] = useState<Record<string, { text: string; at: number }>>(
    {}
  )
  const publishParagraphs = useEffectEvent(() => {
    const now = performance.now()
    const next: typeof publishedText = {}
    let changed = false
    for (const part of streamingParts) {
      const previous = publishedText[part.id]
      if (previous) next[part.id] = previous
      if (previous && now - previous.at < 400) continue
      const text = readyAssistantText(part.text)
      if (!text || text === previous?.text) continue
      next[part.id] = { text, at: now }
      changed = true
    }
    if (changed) setPublishedText(next)
  })
  useEffect(() => {
    if (streamingParts.length === 0) return
    const now = performance.now()
    const delay = Math.min(
      ...streamingParts.map((part) =>
        Math.max(0, 400 - (now - (publishedText[part.id]?.at ?? -400)))
      )
    )
    const timer = setTimeout(publishParagraphs, delay)
    return () => clearTimeout(timer)
  }, [streamingParts, publishedText])
  const textByPart = useMemo(() => {
    const text: Record<string, string> = {}
    for (const part of streamingParts) {
      const prefix = publishedText[part.id]?.text ?? ""
      text[part.id] = part.text.startsWith(prefix) ? prefix : ""
    }
    return text
  }, [streamingParts, publishedText])
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

  const updateSession = useCallback(
    async (info: Session) => {
      if (info.id !== sessionID) return
      await updateSessionInfo(queryClient, agentName, workspaceId, info)
    },
    [queryClient, agentName, workspaceId, sessionID]
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
    updateSession,
    blocked: permissionRequest !== undefined || questionRequest !== undefined,
    loadError:
      session.error?.message ??
      history.error?.message ??
      hitl.error?.message ??
      status.error?.message,
    isBusy,
    hasEarlierMessages: history.hasNextPage,
    isLoadingEarlier: history.isFetchingNextPage,
    isRefreshingHistory: history.isFetching && !history.isFetchingNextPage,
    isPending:
      Boolean(sessionID) &&
      !sessionUnavailable &&
      (session.isPending || history.isPending || !sessionReady || !historyReady),
    loadEarlier,
    messages,
    partsByMessage,
    permissionRequest,
    questionRequest,
    reconnectStream,
    reload,
    session: session.data ?? undefined,
    sessionUnavailable,
    sessionStatus,
    streamError,
    textByPart,
    todos,
  }
}
