import dynamic from "next/dynamic"
import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getEffectiveAccessDetail } from "@/data/access"
import { getMemberAdministration, type MemberAdministration } from "@/data/members"
import { formatAge } from "@/lib/format"
import { ResultBadge } from "../../event-trail/event-trail-event"

const AccessDetailView = dynamic(() =>
  import("../../access/[memberId]/access-graph").then((module) => module.AccessDetailView)
)

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string; orgSlug: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { memberId, orgSlug } = await params
  const { tab } = await searchParams
  const data = await getMemberAdministration(orgSlug, memberId)
  if (data === undefined) return <AdministrationState kind="forbidden" />
  if (data === null) notFound()
  const activeTab = ["access", "agents", "keys", "activity"].includes(tab ?? "") ? tab : "summary"
  const root = `/orgs/${orgSlug}/users/${memberId}`
  const tabs = [
    { href: root as Route, label: "Summary" },
    { href: `${root}?tab=access` as Route, label: "Access" },
    { href: `${root}?tab=agents` as Route, label: `Owned Agents (${data.agents.length})` },
    { href: `${root}?tab=keys` as Route, label: `API Keys (${data.apiKeys.length})` },
    { href: `${root}?tab=activity` as Route, label: "Activity" },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1
                className="truncate text-2xl font-semibold tracking-normal"
                title={data.member.name}
              >
                {data.member.name}
              </h1>
              <Badge variant={data.member.disabledAt ? "destructivePlain" : "successPlain"}>
                {data.member.disabledAt ? "Disabled" : "Active"}
              </Badge>
              {data.member.superadmin ? <Badge variant="plain">Superadmin</Badge> : null}
            </div>
            <p className="text-muted-foreground mt-1 truncate text-sm" title={data.member.email}>
              {data.member.email}
            </p>
          </div>
        </div>
        <RouteTabs label="User details" tabs={tabs} />
      </header>
      {activeTab === "access" ? (
        <UserAccess memberId={memberId} orgSlug={orgSlug} />
      ) : activeTab === "agents" ? (
        <OwnedAgents data={data} orgSlug={orgSlug} />
      ) : activeTab === "keys" ? (
        <APIKeys data={data} />
      ) : activeTab === "activity" ? (
        <Activity data={data} />
      ) : (
        <Summary data={data} orgSlug={orgSlug} />
      )}
    </div>
  )
}

function Summary({ data, orgSlug }: { data: MemberAdministration; orgSlug: string }) {
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="px-4 text-lg font-medium md:px-6">Membership</h2>
      <div className="w-full min-w-0 border-b">
        <Table aria-label={`${data.member.name} membership summary`}>
          <TableBody>
            <TableRow>
              <TableHead scope="row">Roles</TableHead>
              <TableCell>{data.member.roles.join(", ") || "None"}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Teams</TableHead>
              <TableCell>{data.member.teams.join(", ") || "None"}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Joined</TableHead>
              <TableCell>
                <time dateTime={data.member.createdAt}>{formatAge(data.member.createdAt)}</time>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Last activity</TableHead>
              <TableCell>
                {data.member.lastActivity ? (
                  <time dateTime={data.member.lastActivity}>
                    {formatAge(data.member.lastActivity)}
                  </time>
                ) : (
                  "None"
                )}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      {data.self ? null : (
        <div className="space-y-3 px-4 pt-3 md:px-6">
          <h2 className="text-lg font-medium">Membership actions</h2>
          <div className="flex flex-wrap gap-2">
            {data.member.disabledAt ? null : (
              <Button asChild variant="outline">
                <Link
                  href={
                    `/orgs/${orgSlug}/users/${data.member.id}/remove?operation=membership_disable` as Route
                  }
                >
                  Disable Membership
                </Link>
              </Button>
            )}
            <Button asChild variant="destructive">
              <Link
                href={
                  `/orgs/${orgSlug}/users/${data.member.id}/remove?operation=membership_remove` as Route
                }
              >
                Remove Membership
              </Link>
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

async function UserAccess({ memberId, orgSlug }: { memberId: string; orgSlug: string }) {
  const detail = await getEffectiveAccessDetail(orgSlug, memberId)
  if (!detail)
    return <AdministrationState kind={detail === undefined ? "forbidden" : "not-found"} />
  return <AccessDetailView detail={detail} />
}

function OwnedAgents({ data, orgSlug }: { data: MemberAdministration; orgSlug: string }) {
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label={`${data.member.name} owned Agents`}>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Workspace</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Ownership</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.agents.length ? (
            data.agents.map((agent) => (
              <TableRow key={`${agent.workspaceSlug}:${agent.name}`}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell>{agent.workspace}</TableCell>
                <TableCell>
                  <time dateTime={agent.updatedAt}>{formatAge(agent.updatedAt)}</time>
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={
                        `/orgs/${orgSlug}/workspaces/${agent.workspaceSlug}/agents/${encodeURIComponent(agent.name)}/ownership` as Route
                      }
                    >
                      Transfer
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                No owned agents
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function APIKeys({ data }: { data: MemberAdministration }) {
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label={`${data.member.name} API Keys`}>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Workspace</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.apiKeys.length ? (
            data.apiKeys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>{key.workspace}</TableCell>
                <TableCell>
                  <Badge variant={key.revokedAt ? "destructive" : "success"}>
                    {key.revokedAt ? "Revoked" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <time dateTime={key.createdAt}>{formatAge(key.createdAt)}</time>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                No API keys
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function Activity({ data }: { data: MemberAdministration }) {
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label={`${data.member.name} activity`}>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.activity.length ? (
            data.activity.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <time dateTime={event.createdAt}>{formatAge(event.createdAt)}</time>
                </TableCell>
                <TableCell>{event.actor}</TableCell>
                <TableCell className="font-mono text-sm">{event.action}</TableCell>
                <TableCell>
                  <ResultBadge result={event.result} />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                No activity
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
