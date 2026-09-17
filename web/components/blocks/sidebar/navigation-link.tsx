"use client"

import type { Route } from "next"
import { SelectionLink } from "@/components/page-selection"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar"

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
