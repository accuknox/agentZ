"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { tabsListVariants } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export type RouteTab = {
  href: Route
  label: string
  disabled?: boolean
}

export function RouteTabs({ label, tabs }: { label: string; tabs: readonly RouteTab[] }) {
  const pathname = usePathname()
  const active = tabs.reduce<Route | undefined>((selected, tab) => {
    if (pathname !== tab.href && !pathname.startsWith(`${tab.href}/`)) {
      return selected
    }

    if (!selected || tab.href.length > selected.length) {
      return tab.href
    }

    return selected
  }, undefined)

  return (
    <nav aria-label={label} className="min-w-0 overflow-x-auto overscroll-x-contain">
      <div className="group/tabs flex gap-2 data-horizontal:flex-col" data-orientation="horizontal">
        <div className={cn(tabsListVariants({ variant: "line" }), "min-w-max")} data-variant="line">
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
                aria-current={active === tab.href ? "page" : undefined}
                className={routeTabClassName}
                data-active={active === tab.href ? "" : undefined}
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
  "text-foreground/60 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1",
  "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
  "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
  "after:bg-foreground after:absolute after:inset-x-0 after:-bottom-1.25 after:h-0.5 after:opacity-0 after:transition-opacity group-data-[variant=line]/tabs-list:data-active:after:opacity-100"
)
