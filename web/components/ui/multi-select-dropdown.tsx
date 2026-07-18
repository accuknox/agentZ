"use client"

import { useState } from "react"
import { ChevronDownIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
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

export type MultiSelectDropdownOption = {
  label: string
  value: string
  disabled?: boolean
}

function MultiSelectDropdown({
  allowCustomValues = false,
  className,
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
  const [search, setSearch] = useState("")
  const selectedValues = new Set(value)
  const customValue = search.trim()
  const canCreate =
    allowCustomValues &&
    customValue.length > 0 &&
    !selectedValues.has(customValue) &&
    !options.some((option) => option.value === customValue)
  const triggerLabel =
    value.length === 0
      ? placeholder
      : value.length <= 2
        ? value
            .map((item) => options.find((option) => option.value === item)?.label ?? item)
            .join(", ")
        : `${value.length} selected`

  return (
    <Popover>
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
          <span className="line-clamp-1 text-left">{triggerLabel}</span>
          <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
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
                  }}
                >
                  <PlusIcon />
                  Add {customValue}
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup>
              {options.map((option) => {
                const checked = selectedValues.has(option.value)
                const nextValue = checked
                  ? value.filter((item) => item !== option.value)
                  : [...value, option.value].toSorted()

                return (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    disabled={option.disabled}
                    onSelect={() => {
                      if (option.disabled) {
                        return
                      }
                      onValueChangeAction(nextValue)
                    }}
                  >
                    <Checkbox className="pointer-events-none" checked={checked} />
                    <span>{option.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { MultiSelectDropdown }
