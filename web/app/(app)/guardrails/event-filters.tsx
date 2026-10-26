"use client"

import { useEffect, useRef, useTransition } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useRouter } from "@bprogress/next/app"
import { DateRangePicker } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GetGuardrailEventChartData } from "@/lib/gateway/client"
import { dayjs } from "@/lib/format"

type GuardrailEventFiltersProps = NonNullable<GetGuardrailEventChartData["query"]> & {
  from: string
  to: string
}

export function GuardrailEventFilters({
  action,
  phase,
  trace_id,
  session_id,
  from,
  to,
}: GuardrailEventFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const traceInput = useRef<HTMLInputElement>(null)
  const sessionInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("from") && url.searchParams.has("to")) return
    url.searchParams.set("from", from)
    url.searchParams.set("to", to)
    window.history.replaceState(null, "", url)
  }, [from, to])

  function update(values: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    params.delete("cursor")
    params.delete("token_stack")
    params.delete("event")
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }))
  }

  return (
    <div
      aria-busy={pending}
      className="flex flex-wrap items-center gap-2 border-b px-4 py-2 aria-busy:opacity-60 md:px-6"
    >
      <DateRangePicker
        size="sm"
        disabled={pending}
        presets={[1, 2, 7, 30].map((days) => ({
          label: days === 1 ? "Today" : `Last ${days} days`,
          getRange: () => ({
            from: dayjs()
              .subtract(days - 1, "day")
              .startOf("day")
              .toDate(),
            to: dayjs().toDate(),
          }),
        }))}
        range={{ from: dayjs(from).toDate(), to: dayjs(to).subtract(1, "millisecond").toDate() }}
        onSelect={(range) =>
          update({
            from: range.from ? dayjs(range.from).startOf("day").toISOString() : undefined,
            to: range.to ? dayjs(range.to).add(1, "day").startOf("day").toISOString() : undefined,
          })
        }
      />
      <Select
        value={action ?? "all"}
        disabled={pending}
        onValueChange={(value) => update({ action: value === "all" ? undefined : value })}
      >
        <SelectTrigger size="sm" aria-label="Filter outcome">
          <SelectValue placeholder="All outcomes" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="reject">Blocked</SelectItem>
            <SelectItem value="mask">Masked</SelectItem>
            <SelectItem value="audit">Audit findings</SelectItem>
            <SelectItem value="failOpen">Allowed after checker error</SelectItem>
            <SelectItem value="allow">Allowed</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={phase ?? "all"}
        disabled={pending}
        onValueChange={(value) => update({ phase: value === "all" ? undefined : value })}
      >
        <SelectTrigger size="sm" aria-label="Filter phase">
          <SelectValue placeholder="Input and output" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">Input and output</SelectItem>
            <SelectItem value="request">Input</SelectItem>
            <SelectItem value="response">Output</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <form
        className="flex min-w-0 flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          update({
            trace_id: traceInput.current?.value.trim(),
            session_id: sessionInput.current?.value.trim(),
          })
        }}
      >
        <Input
          ref={traceInput}
          aria-label="Trace ID"
          name="trace_id"
          placeholder="Trace ID"
          className="h-8 w-48 font-mono text-xs"
          defaultValue={trace_id}
          key={`trace:${trace_id}`}
        />
        <Input
          ref={sessionInput}
          aria-label="Session ID"
          name="session_id"
          placeholder="Session ID"
          className="h-8 w-48 text-xs"
          defaultValue={session_id}
          key={`session:${session_id}`}
        />
        <Button size="sm" variant="outline" disabled={pending} type="submit">
          Apply
        </Button>
      </form>
    </div>
  )
}
