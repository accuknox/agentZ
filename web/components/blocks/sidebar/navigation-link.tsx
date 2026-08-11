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
}: {
  children: ReactNode
  exact?: boolean
  href: Route
  label: string
  match?: string
}) {
  const pathname = usePathname()
  const prefix = match ?? href
  const active = exact
    ? pathname === href
    : pathname === prefix || pathname.startsWith(`${prefix}/`)

  return (
    <SidebarMenuButton asChild isActive={active} tooltip={label}>
      <Link aria-current={active ? "page" : undefined} href={href}>
        {children}
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  )
}
