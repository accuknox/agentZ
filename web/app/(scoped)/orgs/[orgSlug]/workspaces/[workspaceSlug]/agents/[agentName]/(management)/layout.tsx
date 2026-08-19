import type { Route } from "next"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Activity, MessageCircle, MoreHorizontal } from "lucide-react"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
}): Promise<Metadata> {
  const { agentName } = await params
  return {
    title: {
      default: agentName,
      template: `${agentName} - %s | AgentZ`,
    },
  }
}

export default async function WorkspaceAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
}) {
  const { orgSlug, workspaceSlug, agentName } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    notFound()
  }

  const detail = await getWorkspaceAgentDetail(scope.workspace.id, agentName)
  if (!detail) {
    notFound()
  }

  const workspacePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  const root = `${workspacePath}/agents/${encodeURIComponent(agentName)}` as Route
  const tabs: RouteTab[] = [{ href: root, label: "Summary" }]
  if (detail.agent.capabilities.manage_ownership) {
    tabs.push({ href: `${root}/ownership` as Route, label: "Ownership" })
  }
  if (detail.agent.capabilities.share) {
    tabs.push({ href: `${root}/sharing` as Route, label: "Sharing" })
  }
  const canViewTraces = scope.workspace.capabilities.observability.read

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <h1 className="truncate text-2xl font-semibold tracking-normal" title={detail.agent.name}>
            {detail.agent.name}
          </h1>
          {detail.agent.capabilities.use || canViewTraces ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="Agent actions" size="icon" variant="outline">
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {detail.agent.capabilities.use ? (
                  <DropdownMenuItem asChild>
                    <Link href={`${root}/sessions/new` as Route}>
                      <MessageCircle aria-hidden="true" />
                      New chat
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canViewTraces ? (
                  <DropdownMenuItem asChild>
                    <Link
                      href={
                        `${workspacePath}/lens/traces?agent_name=${encodeURIComponent(agentName)}` as Route
                      }
                    >
                      <Activity aria-hidden="true" />
                      View traces
                    </Link>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <RouteTabs label="Agent settings" tabs={tabs} />
      </header>
      {children}
    </div>
  )
}
