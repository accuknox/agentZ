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
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
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

  if (segments[0] === "agents" && segments[1]) {
    return [
      { href: "/", label: "Home" },
      { href: "/", label: "Agents" },
      { label: agentName(segments[1]) ?? segments[1] },
    ]
  }

  if (segments[0] === "runtime-telemetry") {
    if (segments[1]) {
      return [
        { href: "/", label: "Home" },
        { href: "/lens", label: "Lens" },
        { href: "/lens/runtime-telemetry", label: "Runtime Telemetry" },
        { label: titleize(segments[1]) },
      ]
    }
    return [
      { href: "/", label: "Home" },
      { href: "/lens", label: "Lens" },
      { label: "Runtime Telemetry" },
    ]
  }

  if (segments[0] === "agent" && segments[1] === "new") {
    return [{ href: "/", label: "Home" }, { href: "/", label: "Agents" }, { label: "New" }]
  }

  if (segments[0] === "agent" && segments[1] === "update" && segments[2]) {
    return [
      { href: "/", label: "Home" },
      { href: "/", label: "Agents" },
      { href: `/agents/${segments[2]}`, label: agentName(segments[2]) ?? segments[2] },
      { label: "Update" },
    ]
  }

  return [
    { href: "/", label: "Home" },
    ...segments.map((segment, index) => {
      const href = `/${segments.slice(0, index + 1).join("/")}`
      return { href, label: titleize(segment) }
    }),
  ]
}

function titleize(value: string) {
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}
