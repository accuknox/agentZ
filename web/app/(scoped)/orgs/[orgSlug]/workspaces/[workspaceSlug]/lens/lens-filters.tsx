"use client"

import * as React from "react"
import { BotIcon, MessageSquareQuote } from "lucide-react"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"
import { DateRangePicker } from "@/components/ui/calendar"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TraceSessionFilterItem } from "@/data/types"
import { dayjs, formatDateParam } from "@/lib/format"
import type { Agent } from "@/lib/gateway/client"

type LensFiltersProps = {
  agents: Agent[]
  from: string
  selectedAgentName?: string
  selectedSessionId?: string
  sessions?: TraceSessionFilterItem[]
  to: string
}

export function LensFilters({
  agents,
  from,
  selectedAgentName,
  selectedSessionId,
  sessions,
  to,
}: LensFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  function update(values: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams)
    params.delete("page_token")
    params.delete("token_stack")
    for (const [key, value] of Object.entries(values)) {
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
    }

    startTransition(() => {
      const query = params.toString()
      router.replace(query === "" ? pathname : `${pathname}?${query}`)
    })
  }

  return (
    <div
      data-pending={pending}
      className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 data-[pending=true]:opacity-70 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        <Select
          value={selectedAgentName}
          onValueChange={(agentName) => update({ agent_name: agentName, session_id: undefined })}
          disabled={agents.length === 0}
        >
          <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  <BotIcon className="inline-block" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {sessions ? (
          <Select
            value={selectedSessionId}
            onValueChange={(sessionID) => update({ session_id: sessionID })}
            disabled={sessions.length === 0}
          >
            <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52">
              <SelectValue placeholder="Session" className="truncate" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sessions.map((session) => (
                  <SelectItem key={session.sessionId} value={session.sessionId}>
                    <MessageSquareQuote className="inline-block" />
                    <span className="block min-w-0 flex-1 truncate">{session.title}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <DateRangePicker
          className="w-full sm:w-auto"
          onSelect={(range) =>
            update({
              from: formatDateParam(range.from),
              to: formatDateParam(range.to),
              ...(sessions ? { session_id: undefined } : {}),
            })
          }
          range={{ from: dayjs(from).toDate(), to: dayjs(to).toDate() }}
        />
      </div>
    </div>
  )
}
