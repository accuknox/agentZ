"use client"

import type { Route } from "next"
import { useSearchParams } from "next/navigation"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"

export function TelemetryTabs({ basePath }: { basePath: string }) {
  const searchParams = useSearchParams()

  const href = (tab: "process" | "file" | "network"): Route => {
    const next = new URLSearchParams(searchParams.toString())
    const query = next.toString()
    const path = tab === "process" ? basePath : `${basePath}/${tab}`

    if (!query) {
      return path as Route
    }

    return `${path}?${query}` as Route
  }

  const tabs = [
    { href: href("process"), label: "Process" },
    { href: href("file"), label: "File" },
    { href: href("network"), label: "Network" },
  ] satisfies RouteTab[]

  return <RouteTabs label="Runtime telemetry" tabs={tabs} />
}
