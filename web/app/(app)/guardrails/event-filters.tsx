"use client"

import { useEffect, useOptimistic, useState, useTransition } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useRouter } from "@bprogress/next/app"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpDown,
  ChevronDown,
  Fingerprint,
  FunnelPlus,
  Layers3,
  MessageSquare,
  PanelsTopLeft,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react"
import { DateRangePicker } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LensSourceIcon } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/lens-filters"
import type {
  GetGuardrailEventChartData,
  GuardrailEventSources,
  Workspace,
} from "@/lib/gateway/client"
import { dayjs } from "@/lib/format"
import { verdicts } from "./event-shared"

type EventQuery = NonNullable<GetGuardrailEventChartData["query"]>
type GuardrailEventFiltersProps = EventQuery & {
  from: string
  to: string
  sources: GuardrailEventSources
  workspaces: Workspace[]
  scopedWorkspaceId?: string
}

const fields = ["action", "phase", "trace_id", "session_id"] as const satisfies (keyof EventQuery)[]
const fieldByName = {
  action: {
    label: "Outcome",
    icon: ShieldCheck,
    options: [
      { label: "Blocked", value: "reject", icon: verdicts.reject.icon },
      { label: "Masked", value: "mask", icon: verdicts.mask.icon },
      { label: "Audit", value: "audit", icon: verdicts.audit.icon },
      { label: "Fail open", value: "failOpen", icon: verdicts.failOpen.icon },
    ] satisfies { label: string; value: NonNullable<EventQuery["action"]>; icon: LucideIcon }[],
  },
  phase: {
    label: "Phase",
    icon: ArrowUpDown,
    options: [
      { label: "Model request", value: "request", icon: ArrowUpFromLine },
      { label: "Model response", value: "response", icon: ArrowDownToLine },
    ] satisfies { label: string; value: NonNullable<EventQuery["phase"]>; icon: LucideIcon }[],
  },
  trace_id: { label: "Trace ID", icon: Fingerprint },
  session_id: { label: "Session ID", icon: MessageSquare },
}

export function GuardrailEventFilters({
  action,
  phase,
  trace_id,
  session_id,
  from,
  to,
  workspace_id,
  agent_name,
  client_id,
  sources,
  workspaces,
  scopedWorkspaceId,
}: GuardrailEventFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useOptimistic<EventQuery>({
    action,
    phase,
    trace_id,
    session_id,
    from,
    to,
    workspace_id,
    agent_name,
    client_id,
  })
  const [activeField, setActiveField] = useState<(typeof fields)[number]>()
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("from") && url.searchParams.has("to")) return
    url.searchParams.set("from", from)
    url.searchParams.set("to", to)
    window.history.replaceState(null, "", url)
  }, [from, to])

  function update(values: Partial<EventQuery>) {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    params.delete("cursor")
    params.delete("token_stack")
    params.delete("event")
    setActiveField(undefined)
    setEditorOpen(false)
    startTransition(() => {
      setCurrent({ ...current, ...values })
      router.replace(`${pathname}?${params}`, { scroll: false })
    })
  }

  const availableFields = fields.filter((field) => !current[field])
  let selectedSource = "all"
  if (current.agent_name)
    selectedSource = `agent:${current.workspace_id ?? scopedWorkspaceId}/${current.agent_name}`
  if (current.client_id) selectedSource = `app:${current.client_id}`

  return (
    <div
      aria-busy={pending}
      aria-label="Guardrail event filters"
      className="flex min-h-12 flex-wrap items-center gap-1.5 border-b px-4 py-2 transition-opacity aria-busy:opacity-70 md:px-6"
    >
      {!scopedWorkspaceId ? (
        <Select
          value={current.workspace_id ?? "all"}
          disabled={pending}
          onValueChange={(value) =>
            update({
              workspace_id: value === "all" ? undefined : value,
              agent_name: undefined,
              client_id: undefined,
              session_id: undefined,
              trace_id: undefined,
            })
          }
        >
          <SelectTrigger aria-label="Workspace" className="h-8 w-full sm:w-48">
            <SelectValue placeholder="All workspaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">
                <PanelsTopLeft aria-hidden="true" />
                All workspaces
              </SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  <PanelsTopLeft aria-hidden="true" />
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}
      <Select
        value={selectedSource}
        disabled={pending}
        onValueChange={(value) => {
          const agent = sources.agents.find(
            (item) => `agent:${item.workspace_id}/${item.name}` === value
          )
          const app = sources.apps.find((item) => `app:${item.client_id}` === value)
          update({
            workspace_id: agent?.workspace_id ?? current.workspace_id,
            agent_name: agent?.name,
            client_id: app?.client_id,
            session_id: undefined,
            trace_id: undefined,
          })
        }}
      >
        <SelectTrigger aria-label="Agent or external source" className="h-8 w-full sm:w-64">
          <SelectValue placeholder="All sources" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">
              <Layers3 aria-hidden="true" />
              All sources
            </SelectItem>
          </SelectGroup>
          {sources.agents.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Agents</SelectLabel>
              {sources.agents.map((agent) => (
                <SelectItem
                  key={`${agent.workspace_id}/${agent.name}`}
                  value={`agent:${agent.workspace_id}/${agent.name}`}
                >
                  <LensSourceIcon kind="agent" />
                  {agent.name}
                  {!current.workspace_id && !scopedWorkspaceId ? (
                    <span className="text-xs text-muted-foreground">
                      {workspaces.find((workspace) => workspace.id === agent.workspace_id)?.name}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {sources.apps.some((app) => app.agent_kind) ? (
            <SelectGroup>
              <SelectLabel>External agents</SelectLabel>
              {sources.apps.map((app) =>
                app.agent_kind ? (
                  <SelectItem key={app.client_id} value={`app:${app.client_id}`}>
                    <LensSourceIcon kind={app.agent_kind} />
                    {app.name}
                    <span className="text-xs text-muted-foreground">{app.client_id.slice(-8)}</span>
                  </SelectItem>
                ) : null
              )}
            </SelectGroup>
          ) : null}
          {sources.apps.some((app) => !app.agent_kind) ? (
            <SelectGroup>
              <SelectLabel>External apps</SelectLabel>
              {sources.apps.map((app) =>
                !app.agent_kind ? (
                  <SelectItem key={app.client_id} value={`app:${app.client_id}`}>
                    <LensSourceIcon kind="app" />
                    {app.name}
                    <span className="text-xs text-muted-foreground">{app.client_id.slice(-8)}</span>
                  </SelectItem>
                ) : null
              )}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
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
        range={{
          from: dayjs(current.from).toDate(),
          to: dayjs(current.to).subtract(1, "millisecond").toDate(),
        }}
        onSelect={(range) =>
          update({
            from: dayjs(range.from).startOf("day").toISOString(),
            to: dayjs(range.to).add(1, "day").startOf("day").toISOString(),
          })
        }
      />
      {fields.map((name) => {
        const field = fieldByName[name]
        const value = current[name]
        if (!value && activeField !== name) return null

        const label =
          "options" in field ? field.options.find((option) => option.value === value)?.label : value
        const trigger = (
          <Button
            aria-label={`Edit ${field.label} filter`}
            className="max-w-72 min-w-0 shrink"
            disabled={pending}
            size="sm"
            type="button"
            variant="outline-primary"
          >
            <field.icon aria-hidden="true" data-icon="inline-start" />
            <span>{field.label}:</span>
            <span className="truncate">{label || "Select value"}</span>
            {!value ? <ChevronDown data-icon="inline-end" /> : null}
          </Button>
        )

        return (
          <ButtonGroup className="max-w-full min-w-0" key={name}>
            {"options" in field ? (
              <DropdownMenu
                open={activeField === name && editorOpen}
                onOpenChange={(open) => {
                  setActiveField(open ? name : undefined)
                  setEditorOpen(open)
                }}
              >
                <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuRadioGroup
                    value={value ?? ""}
                    onValueChange={(next) => {
                      const option = field.options.find((option) => option.value === next)
                      if (option) update({ [name]: option.value })
                    }}
                  >
                    {field.options.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        <option.icon aria-hidden="true" />
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Popover
                open={activeField === name && editorOpen}
                onOpenChange={(open) => {
                  setActiveField(open ? name : undefined)
                  setEditorOpen(open)
                }}
              >
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      const data = new FormData(event.currentTarget)
                      const next = data.get(name)
                      if (typeof next === "string") update({ [name]: next.trim() || undefined })
                    }}
                  >
                    <FieldGroup>
                      <Field data-disabled={pending}>
                        <FieldLabel htmlFor={`guardrail-filter-${name}`}>{field.label}</FieldLabel>
                        <Input
                          autoComplete="off"
                          defaultValue={value ?? ""}
                          disabled={pending}
                          id={`guardrail-filter-${name}`}
                          name={name}
                          placeholder={field.label}
                        />
                      </Field>
                      <Button disabled={pending} size="sm" type="submit">
                        Apply
                      </Button>
                    </FieldGroup>
                  </form>
                </PopoverContent>
              </Popover>
            )}
            <Button
              aria-label={`Remove ${field.label} filter`}
              disabled={pending}
              onClick={() => {
                if (value) update({ [name]: undefined })
                else setActiveField(undefined)
              }}
              size="icon-sm"
              type="button"
              variant="outline-primary"
            >
              <X />
            </Button>
          </ButtonGroup>
        )
      })}
      {!activeField && availableFields.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={pending} size="sm" type="button" variant="ghost">
              <FunnelPlus data-icon="inline-start" /> Add filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuGroup>
              {availableFields.map((name) => {
                const field = fieldByName[name]
                return (
                  <DropdownMenuItem
                    key={name}
                    onSelect={() => {
                      setActiveField(name)
                      setEditorOpen(false)
                    }}
                  >
                    <field.icon aria-hidden="true" />
                    {field.label}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
