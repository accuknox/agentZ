"use client"

import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ComponentProps,
  type ReactElement,
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
      iconElement?: never
      image?: never
      initials?: never
    }
  | {
      icon?: never
      iconElement: ReactElement
      image?: never
      initials?: never
    }
  | {
      icon?: never
      iconElement?: never
      image: string | null
      initials: string
    }

export type MultiSelectDropdownOption = MultiSelectDropdownOptionIdentity & {
  badge?: string
  badgeIcon?: ComponentType<SVGProps<SVGSVGElement>>
  group?: string
  label: string
  description?: string
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
  ...triggerProps
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
} & Pick<ComponentProps<"button">, "ref" | "aria-required" | "aria-describedby" | "aria-label">) {
  const listId = useId()
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
                  <span className="inline-flex max-w-40 min-w-0 shrink-[10] items-center gap-1 truncate text-muted-foreground">
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
          {...triggerProps}
          id={id}
          type="button"
          disabled={disabled}
          role="combobox"
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          className={cn(
            "form-control group/multi-select flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border py-2 pr-2 pl-2.5 text-sm whitespace-nowrap outline-none select-none disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground",
            value.length === 0 && "text-muted-foreground",
            className
          )}
        >
          <span className="flex min-w-0 items-center gap-1 truncate text-left">{triggerLabel}</span>
          <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/multi-select:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          "w-[max(var(--radix-popover-trigger-width),24rem)] max-w-[calc(100vw-2rem)] bg-popover p-0 shadow-sm ring-border",
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
          <CommandList id={listId}>
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
                  const iconElement = option.iconElement
                  const BadgeIcon = option.badgeIcon
                  const checked = selectedValues.has(option.value)
                  const nextValue = checked
                    ? value.filter((item) => item !== option.value)
                    : [...value, option.value].toSorted()

                  return (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      keywords={[option.label, option.badge ?? "", option.description ?? ""]}
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
                      ) : iconElement ? (
                        iconElement
                      ) : Icon ? (
                        <Icon aria-hidden="true" />
                      ) : null}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <TruncatedOptionText value={option.label} />
                        {option.description ? (
                          <span className="text-xs wrap-anywhere whitespace-normal text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
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
