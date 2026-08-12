"use client"

import * as React from "react"
import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { FolderTree } from "lucide-react"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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
  ["orgs", "Organisations"],
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
  ["event-trail", "Event Trail"],
  ["general", "General"],
  ["workspaces", "Workspaces"],
  ["workflows", "Workflows"],
])

const pageRoutes = new Set([
  "/",
  "/orgs/[orgSlug]",
  "/orgs/[orgSlug]/event-trail",
  "/orgs/[orgSlug]/general",
  "/orgs/[orgSlug]/mcps",
  "/orgs/[orgSlug]/skills",
  "/orgs/[orgSlug]/workspaces",
  "/orgs/[orgSlug]/workspaces/new",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents/[agentName]",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents/[agentName]/sessions/[sessionId]",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents/[agentName]/sessions/new",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/secrets",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/graphs",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs/graph",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/mcps",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/mcp",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/file",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/network",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/traces",
  "/orgs/[orgSlug]/workspaces/[workspaceSlug]/skills",
  "/settings/account",
  "/settings/preferences",
  "/settings/sessions",
])

export function PageBreadcrumb({
  labels: resolvedLabels,
}: {
  labels?: Readonly<Record<number, string>>
}): React.JSX.Element {
  const pathname = usePathname()
  const segments = pathname.split("/").filter(Boolean)
  const pathKey = pathname
  const agent = segments[4] === "agents" ? segments[5] : undefined
  const { dirtyAgent, openAgent, toggleAgent } = useFileWorkspace()
  const filesOpen = agent === openAgent
  const filesDirty = agent === dirtyAgent
  const [closingAgent, setClosingAgent] = React.useState<string>()
  const home = { href: "/" as Route, label: "Home" }
  const crumbs: Crumb[] = [home]

  for (const [index, segment] of segments.entries()) {
    const pathSegments = segments.slice(0, index + 1)
    const href = `/${pathSegments.join("/")}` as Route
    const label = resolvedLabels?.[index] ?? labels.get(segment) ?? segment

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
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Breadcrumb ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden">
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
      {agent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={filesOpen ? "Close files" : "Open files"}
              aria-pressed={filesOpen}
              className="hidden shrink-0 lg:inline-flex"
              onClick={() => {
                if (filesOpen && filesDirty) {
                  setClosingAgent(agent)
                  return
                }

                toggleAgent(agent)
              }}
              size="icon-sm"
              variant={filesOpen ? "secondary" : "ghost"}
            >
              <FolderTree />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{filesOpen ? "Close files" : "Open files"}</TooltipContent>
        </Tooltip>
      ) : null}
      <Dialog
        open={closingAgent !== undefined}
        onOpenChange={(open) => !open && setClosingAgent(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close files?</DialogTitle>
            <DialogDescription>Your unsaved file changes will be discarded.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setClosingAgent(undefined)} variant="outline">
              Cancel
            </Button>
            <Button
              data-dialog-submit
              onClick={() => {
                if (closingAgent) toggleAgent(closingAgent)
                setClosingAgent(undefined)
              }}
              variant="destructive"
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
  if (segments[0] === "orgs" && segments[1]) {
    const pattern = [...segments]
    pattern[1] = "[orgSlug]"

    if (pattern[2] === "workspaces" && pattern[3] && pattern[3] !== "new") {
      pattern[3] = "[workspaceSlug]"
    }
    if (pattern[4] === "agents" && pattern[5]) {
      pattern[5] = "[agentName]"
    }
    if (pattern[6] === "sessions" && pattern[7] && pattern[7] !== "new") {
      pattern[7] = "[sessionId]"
    }

    return `/${pattern.join("/")}`
  }

  return `/${segments.join("/")}`
}
