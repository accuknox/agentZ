"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { SidebarMenuButton } from "@/components/ui/sidebar"

export function SidebarNavigationLink({
  children,
  exact = false,
  href,
  label,
  match,
  maxMatchDepth,
}: {
  children: ReactNode
  exact?: boolean
  href: Route
  label: string
  match?: string
  maxMatchDepth?: number
}) {
  const pathname = usePathname()
  const prefix = match ?? href
  const matchDepth = pathname.slice(prefix.length).split("/").filter(Boolean).length
  const active = exact
    ? pathname === href
    : (pathname === prefix || pathname.startsWith(`${prefix}/`)) &&
      (maxMatchDepth === undefined || matchDepth <= maxMatchDepth)

  return (
    <SidebarMenuButton asChild isActive={active} tooltip={label}>
      <Link aria-current={active ? "page" : undefined} href={href}>
        {children}
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  )
}
