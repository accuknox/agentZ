"use client"

import { use } from "react"
import { Fragment } from "react"
import Link from "next/link"
import { useSelectedLayoutSegments } from "next/navigation"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import type { ListAgentActionResponse } from "@/data/types"

type Crumb = {
  href?: string
  label: string
}

export function PageBreadcrumb({ agents }: { agents: Promise<ListAgentActionResponse> }) {
  const segments = useSelectedLayoutSegments().filter((segment) => !segment.startsWith("("))
  const result = use(agents)
  const list = result.agents ?? []
  const crumbs = crumbsForSegments(segments, (id) => {
    return list.find((agent) => agent.name === id)?.name
  })

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1

          return (
            <Fragment key={`${crumb.href ?? crumb.label}-${index}`}>
              <BreadcrumbItem>
                {current || !crumb.href ? (
                  <BreadcrumbPage className={current ? "text-foreground" : undefined}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!current ? <BreadcrumbSeparator /> : null}
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function crumbsForSegments(
  segments: string[],
  agentName: (id: string) => string | undefined
): Crumb[] {
  if (segments.length === 0) {
    return [{ label: "Home" }]
  }

  if (segments[0] === "agents" && segments[1] && segments[2] && segments[3]) {
    return [
      { href: "/", label: "Home" },
      { label: "Agents" },
      { label: agentName(segments[1]) ?? segments[1] },
      { label: titleize(segments[2]) },
      { label: titleize(segments[3]) },
    ]
  }

  if (segments[0] === "agents" && segments[1]) {
    return [
      { href: "/", label: "Home" },
      { label: "Agents" },
      { label: agentName(segments[1]) ?? segments[1] },
    ]
  }

  if (segments[0] === "lens" && segments[1] === "runtime-telemetry") {
    if (segments[1]) {
      return [
        { href: "/", label: "Home" },
        { label: "Lens" },
        { href: "/lens/runtime-telemetry", label: "Runtime Telemetry" },
        ...(segments[2] ? [{ label: titleize(segments[2]) }] : []),
      ]
    }
    return [{ href: "/", label: "Home" }, { label: "Lens" }, { label: "Runtime Telemetry" }]
  }

  if (segments[0] === "lens" && segments[1] === "traces") {
    return [{ href: "/", label: "Home" }, { label: "Lens" }, { label: "Traces" }]
  }

  if (segments[0] === "lens" && segments[1] === "mcp") {
    return [{ href: "/", label: "Home" }, { label: "Lens" }, { label: "MCP" }]
  }

  return genericCrumbs(segments)
}

function genericCrumbs(segments: string[]): Crumb[] {
  const crumbs: Crumb[] = [{ href: "/", label: "Home" }]
  const hrefs = new Set([
    "/",
    "/environments",
    "/environments/new",
    "/lens/mcp",
    "/lens/runtime-telemetry",
    "/lens/traces",
    "/secrets",
  ])
  const labelOverrides = new Map([["mcps", "MCPs"]])

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const href = `/${segments.slice(0, i + 1).join("/")}`

    crumbs.push({
      href: hrefs.has(href) ? href : undefined,
      label: labelOverrides.get(segment) ?? titleize(segment),
    })
  }

  return crumbs
}

function titleize(value: string) {
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}
