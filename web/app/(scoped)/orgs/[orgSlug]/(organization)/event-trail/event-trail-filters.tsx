"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { RotateCcw } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import type { EventTrailActorType, EventTrailFilters, EventTrailResult } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const allResults = ["succeeded", "denied", "failed"] as const satisfies readonly EventTrailResult[]
const allActorTypes = [
  "user",
  "api_key",
  "system",
] as const satisfies readonly EventTrailActorType[]

export function EventTrailFiltersBar({
  filters,
  hideWorkspace,
  selected,
}: {
  filters: EventTrailFilters
  hideWorkspace?: boolean
  selected: {
    actorType?: EventTrailActorType
    actorId?: string
    category?: string
    workspaceId?: string
    targetType?: string
    result?: EventTrailResult
    createdAfter?: string
    createdBefore?: string
  }
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  function update(key: string, value?: string, clear: string[] = []) {
    const params = new URLSearchParams(searchParams)
    params.delete("page_token")
    params.delete("token_stack")
    for (const clearedKey of clear) params.delete(clearedKey)
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    startTransition(() => {
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname)
    })
  }

  function clear() {
    startTransition(() => router.replace(pathname))
  }

  return (
    <form
      aria-busy={pending}
      aria-label="Event Trail filters"
      className="bg-background grid gap-3 border-b px-4 py-3 opacity-100 transition-opacity aria-busy:opacity-65 sm:grid-cols-2 md:px-6 xl:grid-cols-4"
      onSubmit={(event) => event.preventDefault()}
      role="search"
    >
      <FilterSelect
        id="event-trail-actor-type"
        label="Actor type"
        onValueChange={(value) => update("actor_type", value, ["actor_id"])}
        options={allActorTypes.map((type) => ({ label: type, value: type }))}
        value={selected.actorType}
      />
      <FilterSelect
        id="event-trail-actor"
        label="Actor"
        onValueChange={(value) => update("actor_id", value)}
        options={filters.actors.flatMap((actor) =>
          actor.id && (!selected.actorType || actor.type === selected.actorType)
            ? [{ label: actor.name ?? actor.email ?? actor.id, value: actor.id }]
            : []
        )}
        value={selected.actorId}
      />
      <FilterSelect
        id="event-trail-category"
        label="Category"
        onValueChange={(value) => update("category", value)}
        options={filters.categories.map((category) => ({ label: category, value: category }))}
        value={selected.category}
      />
      {!hideWorkspace ? (
        <FilterSelect
          id="event-trail-workspace"
          label="Workspace"
          onValueChange={(value) => update("workspace_id", value)}
          options={filters.workspaces.map((workspace) => ({
            label: workspace.name ?? workspace.slug ?? workspace.id,
            value: workspace.id,
          }))}
          value={selected.workspaceId}
        />
      ) : null}
      <FilterSelect
        id="event-trail-target-type"
        label="Resource type"
        onValueChange={(value) => update("target_type", value)}
        options={filters.target_types.map((type) => ({ label: type, value: type }))}
        value={selected.targetType}
      />
      <FilterSelect
        id="event-trail-result"
        label="Result"
        onValueChange={(value) => update("result", value)}
        options={allResults.map((result) => ({ label: result, value: result }))}
        value={selected.result}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="event-trail-created-after">From</Label>
        <Input
          id="event-trail-created-after"
          max={selected.createdBefore?.slice(0, 10)}
          type="date"
          value={selected.createdAfter?.slice(0, 10) ?? ""}
          onChange={(event) =>
            update(
              "created_after",
              event.target.value ? `${event.target.value}T00:00:00.000Z` : undefined
            )
          }
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="event-trail-created-before">To</Label>
        <Input
          id="event-trail-created-before"
          min={selected.createdAfter?.slice(0, 10)}
          type="date"
          value={selected.createdBefore?.slice(0, 10) ?? ""}
          onChange={(event) =>
            update(
              "created_before",
              event.target.value ? `${event.target.value}T23:59:59.999Z` : undefined
            )
          }
        />
      </div>
      <div className="flex items-end">
        <Button
          className="w-full xl:w-auto"
          disabled={pending}
          onClick={clear}
          type="button"
          variant="ghost"
        >
          <RotateCcw data-icon="inline-start" />
          Clear filters
        </Button>
      </div>
    </form>
  )
}

function FilterSelect({
  id,
  label,
  onValueChange,
  options,
  value,
}: {
  id: string
  label: string
  onValueChange: (value: string) => void
  options: { label: string; value: string }[]
  value?: string
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select key={value ?? "unset"} value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Any" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="block max-w-72 truncate">{option.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
