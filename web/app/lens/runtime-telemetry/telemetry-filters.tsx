"use client"

import * as React from "react"
import { BotIcon, CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
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
import { dayjs } from "@/lib/dayjs"

interface TelemetryFiltersProps {
  agents: Agent[]
  selectedAgentName?: string
  from?: string
  to?: string
}

export function TelemetryFilters({ agents, selectedAgentName, from, to }: TelemetryFiltersProps) {
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
      router.replace(`${pathname}?${params.toString()}`)
    })
  }

  return (
    <div
      data-pending={pending}
      className="flex min-h-14 flex-col gap-3 px-6 py-2 data-[pending=true]:opacity-70 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={selectedAgentName}
          onValueChange={(agentName) => update({ agent_name: agentName })}
          disabled={agents.length === 0}
        >
          <SelectTrigger className="h-8 w-full min-w-52 rounded-md sm:w-64">
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
        <DateRangeControl key={`${from ?? ""}-${to ?? ""}`} from={from} to={to} update={update} />
      </div>
    </div>
  )
}

function DateRangeControl({
  from,
  to,
  update,
}: {
  from?: string
  to?: string
  update: (values: Record<string, string | undefined>) => void
}) {
  const selectedRange = React.useMemo<DateRange | undefined>(() => {
    const selectedFrom = parseParamDate(from)
    const selectedTo = parseParamDate(to)
    if (!selectedFrom && !selectedTo) {
      return undefined
    }

    return { from: selectedFrom, to: selectedTo ?? selectedFrom }
  }, [from, to])
  const [draftRange, setDraftRange] = React.useState<DateRange | undefined>(selectedRange)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 justify-start rounded-md font-normal">
          <CalendarIcon data-icon="inline-start" />
          <span className="truncate">{rangeLabel(from, to)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
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

            update({ from: formatParamDate(range.from), to: formatParamDate(range.to) })
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function rangeLabel(from?: string, to?: string) {
  const fromDate = paramDate(from)
  const toDate = paramDate(to)
  if (fromDate && toDate) {
    return `${fromDate.format("MMM D, YYYY")} - ${toDate.format("MMM D, YYYY")}`
  }

  if (fromDate) {
    return fromDate.format("MMM D, YYYY")
  }

  return "Date range"
}

function paramDate(value?: string) {
  const date = dayjs(value, "YYYY-MM-DD", true)
  return date.isValid() ? date : undefined
}

function parseParamDate(value?: string) {
  return paramDate(value)?.toDate()
}

function formatParamDate(date?: Date) {
  return date ? dayjs(date).format("YYYY-MM-DD") : undefined
}
