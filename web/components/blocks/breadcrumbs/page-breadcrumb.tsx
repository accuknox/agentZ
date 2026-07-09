"use client"

import * as React from "react"
import type { Route } from "next"
import Link from "next/link"
import { useSelectedLayoutSegments } from "next/navigation"
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

type Crumb = {
  href?: Route
  label: string
}

const labels = new Map<string, string>([
  ["account", "Account"],
  ["agents", "Agents"],
  ["api-keys", "API Keys"],
  ["file", "File Telemetry"],
  ["graph", "Graph"],
  ["graphs", "Graphs"],
  ["lens", "Lens"],
  ["mcp", "MCP"],
  ["mcps", "MCP"],
  ["network", "Network Telemetry"],
  ["new", "New"],
  ["process", "Process Telemetry"],
  ["preferences", "Preferences"],
  ["runs", "Runs"],
  ["runtime-telemetry", "Runtime Telemetry"],
  ["sandboxes", "Sandboxes"],
  ["secrets", "Secrets"],
  ["session", "Session"],
  ["sessions", "Sessions"],
  ["settings", "Settings"],
  ["skills", "Skills"],
  ["traces", "Traces"],
  ["triggers", "Triggers"],
  ["update", "Update"],
  ["workflows", "Workflows"],
])

const pageRoutes = new Set([
  "/",
  "/agents/[name]/[sessionId]",
  "/agents/[name]/session/new",
  "/lens/mcp",
  "/lens/runtime-telemetry",
  "/lens/runtime-telemetry/file",
  "/lens/runtime-telemetry/network",
  "/lens/runtime-telemetry/process",
  "/lens/traces",
  "/mcps",
  "/sandboxes",
  "/sandboxes/new",
  "/sandboxes/update/[name]",
  "/secrets",
  "/skills",
  "/settings/account",
  "/settings/api-keys",
  "/settings/preferences",
  "/settings/sessions",
  "/workflows/graphs",
  "/workflows/triggers",
  "/workflows/triggers/runs",
  "/workflows/triggers/runs/graph",
])

export function PageBreadcrumb(): React.JSX.Element {
  const segments = useSelectedLayoutSegments().filter((segment) => !segment.startsWith("("))
  const pathKey = segments.join("/")
  const home = { href: "/" as Route, label: "Home" }
  const crumbs: Crumb[] = [home]

  for (const [index, segment] of segments.entries()) {
    const pathSegments = segments.slice(0, index + 1)
    const href = `/${pathSegments.join("/")}` as Route
    const label = labels.get(segment) ?? segment

    crumbs.push(pageRoutes.has(routePattern(pathSegments)) ? { href, label } : { label })
  }

  const containerRef = React.useRef<HTMLElement>(null)
  const fullListRef = React.useRef<HTMLOListElement>(null)
  const [collapsed, setCollapsed] = React.useState(false)
  const tailCrumbs = crumbs.slice(-2)

  React.useLayoutEffect(() => {
    const container = containerRef.current
    const fullList = fullListRef.current
    if (!container || !fullList) {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      setCollapsed(fullList.scrollWidth > container.clientWidth)
    })

    resizeObserver.observe(container)
    resizeObserver.observe(fullList)
    setCollapsed(fullList.scrollWidth > container.clientWidth)

    return () => {
      resizeObserver.disconnect()
    }
  }, [pathKey])

  return (
    <Breadcrumb ref={containerRef} className="relative min-w-0 overflow-hidden">
      <BreadcrumbList
        ref={fullListRef}
        className="invisible absolute flex-nowrap whitespace-nowrap"
      >
        <BreadcrumbCrumbs
          crumbs={crumbs}
          currentIndex={crumbs.length - 1}
          lastIndex={crumbs.length - 1}
        />
      </BreadcrumbList>
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden whitespace-nowrap">
        {collapsed && crumbs.length > 3 ? (
          <>
            <BreadcrumbCrumbs crumbs={[home]} currentIndex={crumbs.length - 1} lastIndex={0} />
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbCrumbs
              crumbs={tailCrumbs}
              currentIndex={tailCrumbs.length - 1}
              lastIndex={tailCrumbs.length - 1}
            />
          </>
        ) : (
          <BreadcrumbCrumbs
            crumbs={crumbs}
            currentIndex={crumbs.length - 1}
            lastIndex={crumbs.length - 1}
          />
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function BreadcrumbCrumbs({
  crumbs,
  currentIndex,
  lastIndex,
}: {
  crumbs: Crumb[]
  currentIndex: number
  lastIndex: number
}): React.JSX.Element {
  return (
    <>
      {crumbs.map((crumb, index) => {
        const current = index === currentIndex

        return (
          <React.Fragment key={`${crumb.href ?? crumb.label}-${index}`}>
            <BreadcrumbItem className="min-w-0 shrink">
              {current || !crumb.href ? (
                <BreadcrumbPage
                  className={current ? "text-foreground max-w-64 truncate" : "max-w-48 truncate"}
                >
                  {crumb.label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild className="max-w-48 truncate">
                  <Link href={crumb.href}>{crumb.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {index !== lastIndex ? <BreadcrumbSeparator /> : null}
          </React.Fragment>
        )
      })}
    </>
  )
}

function routePattern(segments: string[]): string {
  if (segments[0] === "agents" && segments[1] && segments[2] === "session") {
    if (segments[3] !== "new") {
      return `/${segments.join("/")}`
    }

    return "/agents/[name]/session/new"
  }

  if (segments[0] === "agents" && segments[1] && segments[2]) {
    return "/agents/[name]/[sessionId]"
  }

  if (segments[0] === "sandboxes" && segments[1] === "update" && segments[2]) {
    return "/sandboxes/update/[name]"
  }

  return `/${segments.join("/")}`
}
