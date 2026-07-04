"use client"

import * as React from "react"
import { BotIcon, CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"
import type { Agent } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { dayjs } from "@/lib/format"

type McpFiltersProps = {
  agents: Agent[]
  selectedAgentName?: string
  from?: string
  to?: string
}

/**
 * McpFilters keeps the `/lens/mcp` URL as the single source of truth.
 */
export function McpFilters({ agents, selectedAgentName, from, to }: McpFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  function update(values: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(values)) {
      if (value) {
        params.set(key, value)
        continue
      }

      params.delete(key)
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
          onValueChange={(agentName) => update({ agent_name: agentName })}
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="h-8 w-full max-w-full justify-start rounded-md font-normal sm:w-auto"
            >
              <CalendarIcon data-icon="inline-start" />
              <span className="truncate">
                {(() => {
                  const fromDate = dayjs(from, "YYYY-MM-DD", true)
                  const toDate = dayjs(to, "YYYY-MM-DD", true)
                  if (fromDate.isValid() && toDate.isValid()) {
                    return `${fromDate.format("MMM D, YYYY")} - ${toDate.format("MMM D, YYYY")}`
                  }
                  if (fromDate.isValid()) {
                    return fromDate.format("MMM D, YYYY")
                  }
                  return "Date range"
                })()}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-[calc(100vw-2rem)] overflow-auto p-0">
            <McpDateRangePicker from={from} to={to} update={update} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

/**
 * McpDateRangePicker keeps the date-range control local to the filter bar.
 */
function McpDateRangePicker({
  from,
  to,
  update,
}: {
  from?: string
  to?: string
  update: (values: Record<string, string | undefined>) => void
}) {
  const selectedFrom = dayjs(from, "YYYY-MM-DD", true)
  const selectedTo = dayjs(to, "YYYY-MM-DD", true)
  const selectedRange = React.useMemo<DateRange | undefined>(() => {
    if (!selectedFrom.isValid() && !selectedTo.isValid()) {
      return undefined
    }

    return {
      from: selectedFrom.isValid() ? selectedFrom.toDate() : undefined,
      to: selectedTo.isValid()
        ? selectedTo.toDate()
        : selectedFrom.isValid()
          ? selectedFrom.toDate()
          : undefined,
    }
  }, [selectedFrom, selectedTo])
  const [draftRange, setDraftRange] = React.useState<DateRange | undefined>(selectedRange)

  return (
    <Calendar
      mode="range"
      numberOfMonths={2}
      resetOnSelect
      selected={draftRange}
      onSelect={(range) => {
        setDraftRange(range)
        if (!range?.from || !range.to) {
          return
        }

        update({
          from: dayjs(range.from).format("YYYY-MM-DD"),
          to: dayjs(range.to).format("YYYY-MM-DD"),
        })
      }}
    />
  )
}
