"use client"

import type { Route } from "next"
import { useRouter } from "@bprogress/next/app"
import type { ComponentProps, MouseEvent } from "react"
import { TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

type RoutedTableRowProps = Omit<
  ComponentProps<typeof TableRow>,
  "aria-label" | "onAuxClick" | "onClick" | "onKeyDown" | "role" | "tabIndex"
> & {
  "aria-label": string
  href: Route
}

export function RoutedTableRow({
  "aria-label": ariaLabel,
  children,
  className,
  href,
  ...props
}: RoutedTableRowProps) {
  const router = useRouter()

  function blocksRowNavigation(target: EventTarget | null, row: HTMLTableRowElement) {
    return (
      !(target instanceof Node) ||
      !row.contains(target) ||
      (target instanceof Element && Boolean(target.closest("a,button,input,select,textarea")))
    )
  }

  function open(event: MouseEvent<HTMLTableRowElement>) {
    if (blocksRowNavigation(event.target, event.currentTarget)) return
    if (event.metaKey || event.ctrlKey) {
      window.open(String(href), "_blank", "noopener,noreferrer")
      return
    }
    router.push(href)
  }

  return (
    <TableRow
      {...props}
      aria-label={ariaLabel}
      className={cn(
        "focus-visible:ring-ring cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-inset",
        className
      )}
      onAuxClick={(event) => {
        if (event.button !== 1 || blocksRowNavigation(event.target, event.currentTarget)) return
        window.open(String(href), "_blank", "noopener,noreferrer")
      }}
      onClick={open}
      onKeyDown={(event) => {
        if (
          blocksRowNavigation(event.target, event.currentTarget) ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return
        event.preventDefault()
        router.push(href)
      }}
      role="link"
      tabIndex={0}
    >
      {children}
    </TableRow>
  )
}
