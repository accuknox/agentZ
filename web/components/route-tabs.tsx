"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { tabsListVariants } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export type RouteTab = {
  href: Route
  activePath?: Route
  label: string
  disabled?: boolean
}

export function RouteTabs({ label, tabs }: { label: string; tabs: readonly RouteTab[] }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = searchParams.size ? `${pathname}?${searchParams}` : pathname
  const active = tabs.reduce<RouteTab | undefined>((selected, tab) => {
    const href = String(tab.href)
    const path = String(tab.activePath ?? tab.href)
    const matches = tab.activePath
      ? pathname === path || pathname.startsWith(`${path}/`)
      : href.includes("?")
        ? current === href
        : pathname === href || pathname.startsWith(`${href}/`)
    if (!matches) {
      return selected
    }

    if (!selected || path.length > String(selected.activePath ?? selected.href).length) {
      return tab
    }

    return selected
  }, undefined)

  return (
    <nav
      aria-label={label}
      className="no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain"
    >
      <div className="group/tabs flex gap-2 data-horizontal:flex-col" data-orientation="horizontal">
        <div className={cn(tabsListVariants(), "min-w-max")} data-variant="default">
          {tabs.map((tab) =>
            tab.disabled ? (
              <span
                aria-disabled="true"
                className={cn(routeTabClassName, "pointer-events-none opacity-50")}
                key={tab.href}
              >
                {tab.label}
              </span>
            ) : (
              <Link
                aria-current={active === tab ? "page" : undefined}
                className={routeTabClassName}
                data-active={active === tab ? "" : undefined}
                href={tab.href}
                key={tab.href}
              >
                {tab.label}
              </Link>
            )
          )}
        </div>
      </div>
    </nav>
  )
}

const routeTabClassName = cn(
  "text-foreground/60 hover:bg-background/70 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1",
  "data-active:bg-background data-active:text-foreground data-active:shadow-sm dark:data-active:border-input dark:data-active:bg-input/50 dark:data-active:text-foreground"
)
