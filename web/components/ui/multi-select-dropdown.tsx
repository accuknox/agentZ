"use client"

import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react"
import { ChevronDownIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type MultiSelectDropdownOptionIdentity =
  | {
      icon: ComponentType<SVGProps<SVGSVGElement>>
      image?: never
      initials?: never
    }
  | {
      icon?: never
      image: string | null
      initials: string
    }

export type MultiSelectDropdownOption = MultiSelectDropdownOptionIdentity & {
  badge?: string
  badgeIcon?: ComponentType<SVGProps<SVGSVGElement>>
  group?: string
  label: string
  value: string
  disabled?: boolean
}

function MultiSelectDropdown({
  allowCustomValues = false,
  className,
  closeOnSelect = false,
  contentClassName,
  disabled,
  emptyMessage = "No options found.",
  id,
  invalid = false,
  onBlurAction,
  onValueChangeAction,
  options,
  placeholder = "Select options",
  searchPlaceholder = "Search...",
  value,
}: {
  allowCustomValues?: boolean
  className?: string
  /** Closes after a choice. Event trail filters use this compact interaction. */
  closeOnSelect?: boolean
  contentClassName?: string
  disabled?: boolean
  emptyMessage?: string
  id?: string
  invalid?: boolean
  onBlurAction?: () => void
  onValueChangeAction: (value: string[]) => void
  options: MultiSelectDropdownOption[]
  placeholder?: string
  searchPlaceholder?: string
  value: string[]
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const selectedValues = new Set(value)
  const customValue = search.trim()
  const groups = new Map<string | undefined, MultiSelectDropdownOption[]>()
  for (const option of options) {
    const group = groups.get(option.group)
    if (group) {
      group.push(option)
      continue
    }
    groups.set(option.group, [option])
  }
  const canCreate =
    allowCustomValues &&
    customValue.length > 0 &&
    !selectedValues.has(customValue) &&
    !options.some((option) => option.value === customValue)
  const triggerLabel =
    value.length === 0
      ? placeholder
      : value.length <= 2
        ? value.map((item, index) => {
            const option = options.find((option) => option.value === item)
            if (!option) {
              return (
                <Fragment key={item}>
                  {index > 0 ? ", " : null}
                  {item}
                </Fragment>
              )
            }
            const BadgeIcon = option.badgeIcon
            return (
              <span className="flex min-w-0 items-center gap-1" key={item}>
                {index > 0 ? ", " : null}
                <TruncatedOptionText className="min-w-0 flex-1" value={option.label} />
                {option.badge ? (
                  <span className="text-muted-foreground inline-flex max-w-40 min-w-0 shrink-[10] items-center gap-1 truncate">
                    <span aria-hidden="true">·</span>
                    {BadgeIcon ? <BadgeIcon aria-hidden="true" className="size-3.5" /> : null}
                    <span className="truncate">{option.badge}</span>
                  </span>
                ) : null}
              </span>
            )
          })
        : `${value.length} selected`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            "border-input focus-visible:border-ring focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
            value.length === 0 && "text-muted-foreground",
            invalid &&
              "border-destructive ring-destructive/20 dark:border-destructive/50 focus-visible:ring-destructive/20",
            className
          )}
        >
          <span className="flex min-w-0 items-center gap-1 truncate text-left">{triggerLabel}</span>
          <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          "w-[max(var(--radix-popover-trigger-width),24rem)] max-w-[calc(100vw-2rem)] p-0",
          contentClassName
        )}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onBlurAction?.()
        }}
        sideOffset={8}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {canCreate ? (
              <CommandGroup>
                <CommandItem
                  value={customValue}
                  onSelect={() => {
                    onValueChangeAction([...value, customValue].toSorted())
                    setSearch("")
                    if (closeOnSelect) {
                      setOpen(false)
                    }
                  }}
                >
                  <PlusIcon />
                  Add {customValue}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {[...groups].map(([group, groupOptions]) => (
              <CommandGroup heading={group} key={group ?? "options"}>
                {groupOptions.map((option) => {
                  const Icon = option.icon
                  const BadgeIcon = option.badgeIcon
                  const checked = selectedValues.has(option.value)
                  const nextValue = checked
                    ? value.filter((item) => item !== option.value)
                    : [...value, option.value].toSorted()

                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.badge ?? ""} ${option.value}`}
                      disabled={option.disabled}
                      onSelect={() => {
                        if (option.disabled) return
                        onValueChangeAction(nextValue)
                        if (closeOnSelect) setOpen(false)
                      }}
                    >
                      <Checkbox className="pointer-events-none" checked={checked} />
                      {option.image !== undefined ? (
                        <Avatar size="sm">
                          <AvatarImage alt="" src={option.image ?? undefined} />
                          <AvatarFallback>{option.initials}</AvatarFallback>
                        </Avatar>
                      ) : Icon ? (
                        <Icon aria-hidden="true" />
                      ) : null}
                      <TruncatedOptionText className="min-w-0 flex-1" value={option.label} />
                      {option.badge ? (
                        <Badge
                          className="max-w-40 min-w-0 shrink-[10] truncate"
                          variant="secondary"
                        >
                          {BadgeIcon ? (
                            <BadgeIcon aria-hidden="true" data-icon="inline-start" />
                          ) : null}
                          {option.badge}
                        </Badge>
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TruncatedOptionText({ className, value }: { className?: string; value: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [value])

  const label = (
    <span className={cn("truncate", className)} ref={ref} tabIndex={truncated ? 0 : undefined}>
      {value}
    </span>
  )
  if (!truncated) return label

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>{value}</TooltipContent>
    </Tooltip>
  )
}

export { MultiSelectDropdown }
