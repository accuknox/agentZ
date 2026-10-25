"use client"

import { useOptimistic, useState, useTransition } from "react"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronDown, FunnelPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { GuardrailEvent } from "@/lib/gateway/client"

const fields = { action: "Outcome", trace_id: "Trace ID" }
const names = ["action", "trace_id"] as const
type FilterField = keyof typeof fields

const outcomes = [
  { value: "reject", label: "Blocked" },
  { value: "mask", label: "Masked" },
  { value: "audit", label: "Audit finding" },
  { value: "failOpen", label: "Allowed after checker error" },
  { value: "allow", label: "Allowed" },
] satisfies { value: GuardrailEvent["evaluation"]["action"]; label: string }[]

type GuardrailEventFiltersProps = {
  action?: GuardrailEvent["evaluation"]["action"]
  traceId?: string
}

export function GuardrailEventFilters(props: GuardrailEventFiltersProps) {
  const { action, traceId } = props

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useOptimistic({ action, trace_id: traceId })
  const [activeField, setActiveField] = useState<FilterField>()
  const [editorOpen, setEditorOpen] = useState(false)

  function setFilter(field: FilterField, value: string) {
    const next = { ...current, [field]: value || undefined }
    const params = new URLSearchParams(searchParams)
    params.delete("cursor")
    params.delete("token_stack")
    for (const name of names) {
      const value = next[name]
      if (!value) {
        params.delete(name)
        continue
      }
      params.set(name, value)
    }
    startTransition(() => {
      setCurrent(next)
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    })
    setActiveField(undefined)
    setEditorOpen(false)
  }

  const visibleFields = names.filter((field) => current[field] || field === activeField)
  const availableFields = names.filter((field) => !current[field])

  return (
    <div
      aria-busy={pending}
      aria-label="Guardrail event filters"
      className="flex min-h-12 flex-wrap items-center gap-1.5 border-b px-4 py-2 transition-opacity aria-busy:opacity-70 md:px-6"
    >
      {visibleFields.map((field) => {
        const label = fields[field]
        const value = current[field]
        if (field === activeField) {
          const trigger = (
            <Button
              className="min-w-32 justify-between border-primary/20 bg-primary/5 font-normal hover:bg-primary/10"
              size="sm"
              variant="outline"
            >
              {field === "action" ? "Select outcome" : "Enter trace ID"}
              <ChevronDown data-icon="inline-end" />
            </Button>
          )
          const onOpenChange = (open: boolean) => {
            setEditorOpen(open)
            if (!open) setActiveField(undefined)
          }

          return (
            <ButtonGroup key={field}>
              <ButtonGroupText className="h-7 border-primary/20 bg-primary/5 text-xs text-primary">
                {label}
              </ButtonGroupText>
              {field === "action" ? (
                <DropdownMenu open={editorOpen} onOpenChange={onOpenChange}>
                  <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {outcomes.map((outcome) => (
                      <DropdownMenuCheckboxItem
                        checked={value === outcome.value}
                        key={outcome.value}
                        onCheckedChange={(checked) =>
                          setFilter(field, checked ? outcome.value : "")
                        }
                      >
                        {outcome.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Popover open={editorOpen} onOpenChange={onOpenChange}>
                  <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                  <PopoverContent align="start">
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        const traceId = data.get("trace_id")
                        if (typeof traceId !== "string") return
                        setFilter(field, traceId.trim())
                      }}
                    >
                      <Input
                        aria-label="Trace ID"
                        defaultValue={value}
                        name="trace_id"
                        placeholder="Trace ID"
                      />
                      <Button className="self-end" size="sm" type="submit">
                        Apply
                      </Button>
                    </form>
                  </PopoverContent>
                </Popover>
              )}
            </ButtonGroup>
          )
        }

        return (
          <ButtonGroup key={field}>
            <Button
              aria-label={`Edit ${label} filter`}
              className="max-w-72 border-primary/20 bg-primary/5 font-normal hover:bg-primary/10"
              onClick={() => {
                setActiveField(field)
                setEditorOpen(true)
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <span className="text-primary">{label}:</span>
              <span className="truncate font-medium">
                {field === "action"
                  ? (outcomes.find((outcome) => outcome.value === value)?.label ?? value)
                  : value}
              </span>
            </Button>
            <Button
              aria-label={`Remove ${label} filter`}
              className="border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary"
              onClick={() => setFilter(field, "")}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <X />
            </Button>
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
                  setEditorOpen(false)
                }}
              >
                {fields[field]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
