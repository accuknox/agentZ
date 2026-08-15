"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { CalendarIcon, ChevronDown, FunnelPlus, X } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import { Calendar } from "@/components/ui/calendar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type {
  EventTrailFilter,
  EventTrailFilterField,
  EventTrailFilters as EventTrailFilterOptions,
} from "@/lib/gateway/client"
import { dayjs } from "@/lib/format"

type FilterField = { label: string } & (
  | { kind: "date" }
  | { kind: "options"; options: { label: string; value: string }[] }
)

export function EventTrailFilters({
  actorImages,
  filters,
  options,
  hideWorkspace,
}: {
  actorImages: Record<string, string>
  filters: EventTrailFilter[]
  options: EventTrailFilterOptions
  hideWorkspace?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const [current, setCurrent] = React.useOptimistic(filters)
  const [activeField, setActiveField] = React.useState<EventTrailFilterField>()
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [dateRange, setDateRange] = React.useState<DateRange>()

  const fieldByName = {
    actor_type: {
      kind: "options",
      label: "Actor type",
      options: [
        { label: "User", value: "user" },
        { label: "API key", value: "api_key" },
        { label: "System", value: "system" },
      ],
    },
    actor_id: {
      kind: "options",
      label: "Actor",
      options: options.actors.flatMap((actor) =>
        actor.id
          ? [
              {
                label: actor.name ?? actor.email ?? actor.id,
                value: actor.id,
              },
            ]
          : []
      ),
    },
    category: {
      kind: "options",
      label: "Category",
      options: options.categories.map((category) => ({ label: category, value: category })),
    },
    workspace_id: {
      kind: "options",
      label: "Workspace",
      options: options.workspaces.map((workspace) => ({
        label: workspace.name ?? workspace.slug ?? workspace.id,
        value: workspace.id,
      })),
    },
    target_type: {
      kind: "options",
      label: "Resource type",
      options: options.target_types.map((type) => ({ label: type, value: type })),
    },
    result: {
      kind: "options",
      label: "Result",
      options: [
        { label: "Succeeded", value: "succeeded" },
        { label: "Denied", value: "denied" },
        { label: "Failed", value: "failed" },
      ],
    },
    created_at: { kind: "date", label: "Created at" },
  } satisfies Record<EventTrailFilterField, FilterField>
  const fieldNames: EventTrailFilterField[] = [
    "actor_type",
    "actor_id",
    "category",
    "workspace_id",
    "target_type",
    "result",
    "created_at",
  ]

  function setFilter(field: EventTrailFilterField, values: string[]) {
    const next = current.slice()
    const index = next.findIndex((filter) => filter.field === field)
    if (!values.length && index !== -1) {
      next.splice(index, 1)
    } else if (index === -1) {
      next.push({ field, values })
    } else {
      next[index] = { field, values }
    }
    const params = new URLSearchParams(searchParams)
    params.delete("page_token")
    params.delete("token_stack")
    if (next.length) {
      params.set("filters", JSON.stringify(next))
    } else {
      params.delete("filters")
    }
    startTransition(() => {
      setCurrent(next)
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname)
    })
  }

  const visibleFilters =
    activeField && !current.some((filter) => filter.field === activeField)
      ? [...current, { field: activeField, values: [] }]
      : current
  const availableFields = fieldNames.filter(
    (field) =>
      (!hideWorkspace || field !== "workspace_id") &&
      !current.some((filter) => filter.field === field) &&
      (fieldByName[field].kind === "date" || fieldByName[field].options.length > 0)
  )

  return (
    <div
      aria-busy={pending}
      aria-label="Event Trail filters"
      className="mt-4 flex min-h-12 flex-wrap items-center gap-1.5 border-b px-4 py-2 transition-opacity aria-busy:opacity-70 md:px-6"
    >
      {visibleFilters.map((filter) => {
        const field = fieldByName[filter.field]

        if (filter.field === activeField) {
          return (
            <ButtonGroup key={filter.field}>
              <ButtonGroupText className="border-primary/20 bg-primary/5 text-primary h-7 text-xs">
                {field.label}
              </ButtonGroupText>

              {field.kind === "options" ? (
                <DropdownMenu
                  open={editorOpen}
                  onOpenChange={(open) => {
                    setEditorOpen(open)
                    if (!open) setActiveField(undefined)
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="border-primary/20 bg-primary/5 hover:bg-primary/10 min-w-32 justify-between font-normal"
                      size="sm"
                      variant="outline"
                    >
                      {filter.values.length ? `${filter.values.length} selected` : "Select values"}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="min-w-56">
                    {field.options.map((option) => (
                      <DropdownMenuCheckboxItem
                        checked={filter.values.includes(option.value)}
                        key={option.value}
                        onCheckedChange={(checked) =>
                          setFilter(
                            filter.field,
                            checked
                              ? [...filter.values, option.value]
                              : filter.values.filter((value) => value !== option.value)
                          )
                        }
                      >
                        {filter.field === "actor_id" ? (
                          <Avatar size="sm">
                            <AvatarImage alt={option.label} src={actorImages[option.value]} />
                            <AvatarFallback>
                              {option.label.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        ) : null}
                        {option.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Popover
                  open={editorOpen}
                  onOpenChange={(open) => {
                    setEditorOpen(open)
                    if (!open) setActiveField(undefined)
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      className="border-primary/20 bg-primary/5 hover:bg-primary/10 font-normal"
                      size="sm"
                      variant="outline"
                    >
                      <CalendarIcon data-icon="inline-start" />
                      Select range
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-fit p-0">
                    <Calendar
                      mode="range"
                      numberOfMonths={2}
                      resetOnSelect
                      selected={dateRange}
                      onSelect={(range) => {
                        setDateRange(range)
                        if (!range?.from || !range.to) return

                        setFilter(filter.field, [
                          dayjs(range.from).startOf("day").toISOString(),
                          dayjs(range.to).endOf("day").toISOString(),
                        ])
                        setEditorOpen(false)
                        setActiveField(undefined)
                      }}
                    />
                  </PopoverContent>
                </Popover>
              )}
            </ButtonGroup>
          )
        }

        const value =
          field.kind === "date"
            ? `${dayjs(filter.values[0]).format("MMM D, YYYY")} – ${dayjs(filter.values[1]).format("MMM D, YYYY")}`
            : filter.values.length === 1
              ? (field.options.find((option) => option.value === filter.values[0])?.label ??
                filter.values[0])
              : `${filter.values.length} selected`

        return (
          <ButtonGroup key={filter.field}>
            <Button
              aria-label={`Edit ${field.label} filter`}
              className="border-primary/20 bg-primary/5 hover:bg-primary/10 max-w-72 font-normal"
              onClick={() => {
                setActiveField(filter.field)
                if (filter.field === "created_at") {
                  setDateRange({
                    from: dayjs(filter.values[0]).toDate(),
                    to: dayjs(filter.values[1]).toDate(),
                  })
                }
                setEditorOpen(true)
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <span className="text-primary">{field.label}:</span>
              <span className="truncate font-medium">{value}</span>
            </Button>
            {field.kind === "options" ? (
              <Button
                aria-label={`Remove ${field.label} filter`}
                className="border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary"
                onClick={() => setFilter(filter.field, [])}
                size="icon-sm"
                type="button"
                variant="outline"
              >
                <X />
              </Button>
            ) : null}
          </ButtonGroup>
        )
      })}

      {!activeField && availableFields.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="text-primary hover:bg-primary/10 hover:text-primary"
              size="sm"
              type="button"
              variant="ghost"
            >
              <FunnelPlus data-icon="inline-start" /> Add filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {availableFields.map((field) => (
              <DropdownMenuItem
                key={field}
                onSelect={() => {
                  setActiveField(field)
                  setDateRange(undefined)
                  setEditorOpen(false)
                }}
              >
                {fieldByName[field].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
