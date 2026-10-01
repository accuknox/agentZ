"use client"

import type { Route } from "next"
import { SelectionLink } from "@/components/page-selection"
import { usePathname } from "next/navigation"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRightIcon, type LucideIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"

export function SidebarNavigationLink<T extends string>({
  children,
  exact = false,
  href,
  label,
  match,
  maxMatchDepth,
}: {
  children: ReactNode
  exact?: boolean
  href: Route<T>
  label: string
  match?: string
  maxMatchDepth?: number
}) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const prefix = match ?? href
  const matchDepth = pathname.slice(prefix.length).split("/").filter(Boolean).length
  const active = exact
    ? pathname === href
    : (pathname === prefix || pathname.startsWith(`${prefix}/`)) &&
      (maxMatchDepth === undefined || matchDepth <= maxMatchDepth)

  return (
    <SidebarMenuButton asChild isActive={active} tooltip={label}>
      <SelectionLink
        aria-current={active ? "page" : undefined}
        href={href}
        onNavigate={() => setOpenMobile(false)}
      >
        {children}
        <span>{label}</span>
      </SelectionLink>
    </SidebarMenuButton>
  )
}

/** Keep the same destinations and tour target in both sidebar presentations. */
export function SidebarNavigationGroup<T extends string>({
  label,
  icon: Icon,
  items,
  defaultOpen,
  tour,
  tourDescription,
}: {
  label: string
  icon: LucideIcon
  items: readonly { href: Route<T>; label: string; icon: LucideIcon; active: boolean }[]
  defaultOpen: boolean
  tour: string
  tourDescription?: string
}) {
  const pathname = usePathname()
  const { isMobile, state, setOpenMobile } = useSidebar()
  const [expanded, setExpanded] = useState(defaultOpen)
  const collapsed = state === "collapsed" && !isMobile
  const trigger = (
    <SidebarMenuButton aria-label={label} isActive={items.some((item) => item.active)}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      {!collapsed && (
        <ChevronRightIcon
          aria-hidden="true"
          className="ml-auto transition-transform duration-200 group-data-[state=open]/navigation:rotate-90 motion-reduce:transition-none"
        />
      )}
    </SidebarMenuButton>
  )

  function renderLinks(onNavigate?: () => void) {
    return items.map(({ href, label, icon: Icon, active }) => (
      <SidebarMenuSubItem key={href}>
        <SidebarMenuSubButton asChild isActive={active}>
          <SelectionLink
            aria-current={active ? "page" : undefined}
            href={href}
            onNavigate={() => {
              onNavigate?.()
              setOpenMobile(false)
            }}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </SelectionLink>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    ))
  }

  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded} className="group/navigation">
      <SidebarMenuItem>
        {/* Driver replaces its target's ARIA attributes. Preserve the trigger's. */}
        <div data-tour={tour} data-tour-description={tourDescription}>
          {collapsed ? (
            <NavigationFlyout key={pathname} label={label} trigger={trigger}>
              {renderLinks}
            </NavigationFlyout>
          ) : (
            <CollapsibleTrigger asChild>{trigger}</CollapsibleTrigger>
          )}
        </div>
        {!collapsed && (
          <CollapsibleContent>
            <SidebarMenuSub>{renderLinks()}</SidebarMenuSub>
          </CollapsibleContent>
        )}
      </SidebarMenuItem>
    </Collapsible>
  )
}

function NavigationFlyout({
  label,
  trigger,
  children,
}: {
  label: string
  trigger: ReactNode
  children: (onNavigate: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const content = useRef<HTMLDivElement>(null)
  const hover = useRef(false)

  // Route and sidebar mode changes unmount the flyout, including pending hover work.
  useEffect(() => () => clearTimeout(timer.current), [])

  function leave() {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!content.current?.contains(document.activeElement)) setOpen(false)
    }, 200)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimeout(timer.current)
        setOpen(next)
      }}
    >
      <PopoverTrigger
        asChild
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return
          clearTimeout(timer.current)
          if (open) return
          hover.current = true
          timer.current = setTimeout(() => setOpen(true), 150)
        }}
        onPointerLeave={leave}
        onPointerDown={() => {
          hover.current = false
        }}
        onKeyDown={() => {
          clearTimeout(timer.current)
          hover.current = false
        }}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        aria-label={label}
        side="right"
        align="start"
        className="max-h-(--radix-popover-content-available-height) w-64 max-w-(--radix-popover-content-available-width) gap-0 overflow-y-auto p-1 motion-reduce:animate-none!"
        onPointerEnter={() => clearTimeout(timer.current)}
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          // Radix skips links; keyboard activation should enter the navigation.
          event.preventDefault()
          if (!hover.current) content.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (hover.current) event.preventDefault()
        }}
        onEscapeKeyDown={() => {
          hover.current = false
        }}
      >
        <SidebarGroupLabel>{label}</SidebarGroupLabel>
        <SidebarMenu>{children(() => setOpen(false))}</SidebarMenu>
      </PopoverContent>
    </Popover>
  )
}
