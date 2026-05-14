"use client"

import {
  type Event,
  type Message,
  type Part,
  type Session,
  type SessionStatus,
  type TextPart,
} from "@opencode-ai/sdk/v2"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { startTransition, useEffectEvent, useEffect, useMemo, useState } from "react"
import { createAgentOpencodeClientV2 } from "@/lib/opencode/client"

type SessionMessageRecord = {
  info: Message
  parts: Part[]
}

type SessionTextStream = {
  active: boolean
  text: string
}

type OpencodeChatStore = {
  part: Record<string, Part[]>
  partTextAccumDelta: Record<string, string>
  message: Record<string, Message[]>
  session?: Session
  sessionStatus: Record<string, SessionStatus>
  sessionText: Record<string, SessionTextStream>
}

type UseOpencodeChatResult = {
  isPending: boolean
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  session?: Session
  sessionStatus?: SessionStatus
  streamError?: string
  textByPart: Record<string, string>
}

const idleSessionStatus: SessionStatus = { type: "idle" }

function emptyStore(): OpencodeChatStore {
  return {
    part: {},
    partTextAccumDelta: {},
    message: {},
    session: undefined,
    sessionStatus: {},
    sessionText: {},
  }
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

function buildStore(sessionID: string, records: SessionMessageRecord[]) {
  const store = emptyStore()

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

function opencodeErrorMessage(error: { data?: { message?: string } }) {
  return error.data?.message ?? "Failed to load session messages"
}

function messageSessionID(event: Event) {
  switch (event.type) {
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.removed":
    case "message.part.delta":
    case "session.status":
    case "session.idle":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
      return event.properties.sessionID
    default:
      return undefined
  }
}

function applyEvent(store: OpencodeChatStore, event: Event): OpencodeChatStore {
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
          [sessionID]: messages.filter((message) => {
            return message.id !== event.properties.messageID
          }),
        },
      }
    }

    case "message.part.updated": {
      const part = event.properties.part
      const parts = store.part[part.messageID] ?? []
      const next = upsertPart(parts, part)
      const text =
        part.type === "text" || part.type === "reasoning"
          ? part.text
          : store.partTextAccumDelta[part.id]

      return {
        ...store,
        part: {
          ...store.part,
          [part.messageID]: next,
        },
        partTextAccumDelta:
          text === undefined
            ? store.partTextAccumDelta
            : {
                ...store.partTextAccumDelta,
                [part.id]: text,
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
          [event.properties.messageID]: parts.filter((part) => {
            return part.id !== event.properties.partID
          }),
        },
        partTextAccumDelta: nextText,
      }
    }

    case "message.part.delta": {
      const current = store.partTextAccumDelta[event.properties.partID] ?? ""
      const text = current + event.properties.delta

      return {
        ...store,
        partTextAccumDelta: {
          ...store.partTextAccumDelta,
          [event.properties.partID]: text,
        },
      }
    }

    case "session.status": {
      return {
        ...store,
        sessionStatus: {
          ...store.sessionStatus,
          [event.properties.sessionID]: event.properties.status,
        },
      }
    }

    case "session.idle": {
      return {
        ...store,
        sessionStatus: {
          ...store.sessionStatus,
          [event.properties.sessionID]: idleSessionStatus,
        },
      }
    }

    case "session.created":
    case "session.updated": {
      const matches = store.session?.id === event.properties.sessionID

      return {
        ...store,
        session: matches ? event.properties.info : store.session,
      }
    }

    case "session.next.text.started": {
      return {
        ...store,
        sessionText: {
          ...store.sessionText,
          [event.properties.sessionID]: {
            active: true,
            text: "",
          },
        },
      }
    }

    case "session.next.text.delta": {
      const current = store.sessionText[event.properties.sessionID]

      return {
        ...store,
        sessionText: {
          ...store.sessionText,
          [event.properties.sessionID]: {
            active: true,
            text: (current?.text ?? "") + event.properties.delta,
          },
        },
      }
    }

    case "session.next.text.ended": {
      return {
        ...store,
        sessionText: {
          ...store.sessionText,
          [event.properties.sessionID]: {
            active: false,
            text: event.properties.text,
          },
        },
      }
    }

    default:
      return store
  }
}

function sessionMessagesQueryOptions(agentName: string, sessionID: string) {
  return queryOptions({
    queryFn: async () => {
      const client = createAgentOpencodeClientV2(agentName)
      const result = await client.session.messages({ sessionID })

      if (result.error) {
        throw new Error(opencodeErrorMessage(result.error))
      }

      return result.data ?? []
    },
    queryKey: ["opencode", "sessionMessages", agentName, sessionID],
    retry: false,
    staleTime: Infinity,
  })
}

export function textParts(parts: Part[], textByPart: Record<string, string>): TextPart[] {
  return parts.filter((part): part is TextPart => {
    return part.type === "text" && (textByPart[part.id] ?? part.text).length > 0
  })
}

export function useOpencodeChat(agentName: string, sessionID?: string): UseOpencodeChatResult {
  const client = useMemo(() => createAgentOpencodeClientV2(agentName), [agentName])
  const [events, setEvents] = useState<Event[]>([])
  const [streamError, setStreamError] = useState<string>()
  const history = useQuery({
    ...sessionMessagesQueryOptions(agentName, sessionID ?? ""),
    enabled: Boolean(sessionID),
  })
  const baseStore = useMemo(() => {
    if (!sessionID || !history.data) {
      return emptyStore()
    }

    return buildStore(sessionID, history.data)
  }, [history.data, sessionID])

  const store = useMemo(() => {
    return events.reduce((current, event) => applyEvent(current, event), baseStore)
  }, [baseStore, events])

  const handleEvent = useEffectEvent((event: Event) => {
    if (!sessionID) return
    if (messageSessionID(event) !== sessionID) return

    startTransition(() => {
      setEvents((current) => [...current, event])
      setStreamError(undefined)
    })
  })

  useEffect(() => {
    if (!sessionID) return
    if (history.isPending) return
    if (history.isError) return

    const controller = new AbortController()

    async function consume() {
      try {
        const result = await client.event.subscribe(undefined, {
          signal: controller.signal,
        })

        for await (const event of result.stream) {
          if (controller.signal.aborted) return
          handleEvent(event)
        }
      } catch (error) {
        if (controller.signal.aborted) return

        setStreamError(
          error instanceof Error ? error.message : "Failed to subscribe to session events"
        )
      }
    }

    void consume()

    return () => controller.abort()
  }, [client, history.isError, history.isPending, sessionID])

  const messages = sessionID ? (store.message[sessionID] ?? []) : []
  const sessionStatus = sessionID
    ? (store.sessionStatus[sessionID] ?? idleSessionStatus)
    : undefined

  return {
    isPending: Boolean(sessionID) && history.isPending,
    messages,
    partsByMessage: store.part,
    session: store.session,
    sessionStatus,
    streamError:
      streamError ??
      (history.error
        ? opencodeErrorMessage(history.error as { data?: { message?: string } })
        : undefined),
    textByPart: store.partTextAccumDelta,
  }
}
