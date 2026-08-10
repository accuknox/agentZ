import dynamic from "next/dynamic"
import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { formatTimestampWithAge } from "@/lib/format"

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
      <header className="flex min-w-0 flex-col gap-4 border-b pb-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-xl font-semibold" title={data.member.name}>
                {data.member.name}
              </h2>
              <Badge variant={data.member.disabledAt ? "destructive" : "success"}>
                {data.member.disabledAt ? "Disabled" : "Active"}
              </Badge>
              {data.member.superadmin ? <Badge variant="secondary">Superadmin</Badge> : null}
            </div>
            <p className="text-muted-foreground mt-1 truncate text-sm" title={data.member.email}>
              {data.member.email}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/orgs/${orgSlug}/users` as Route}>All Users</Link>
          </Button>
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Membership</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                  <time dateTime={data.member.createdAt}>
                    {formatTimestampWithAge(data.member.createdAt)}
                  </time>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">Last activity</TableHead>
                <TableCell>
                  {data.member.lastActivity ? (
                    <time dateTime={data.member.lastActivity}>
                      {formatTimestampWithAge(data.member.lastActivity)}
                    </time>
                  ) : (
                    "None"
                  )}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Membership actions</h3>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {data.self ? (
            <p className="text-muted-foreground text-sm">Current administrator membership</p>
          ) : data.member.disabledAt ? null : (
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
          {!data.self ? (
            <Button asChild variant="destructive">
              <Link
                href={
                  `/orgs/${orgSlug}/users/${data.member.id}/remove?operation=membership_remove` as Route
                }
              >
                Remove Membership
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

async function UserAccess({ memberId, orgSlug }: { memberId: string; orgSlug: string }) {
  const detail = await getEffectiveAccessDetail(orgSlug, memberId)
  if (!detail)
    return <AdministrationState kind={detail === undefined ? "forbidden" : "not-found"} />
  return <AccessDetailView detail={detail} />
}

function OwnedAgents({ data, orgSlug }: { data: MemberAdministration; orgSlug: string }) {
  if (!data.agents.length) return <AdministrationState kind="empty" title="No owned Agents" />
  return (
    <Card>
      <CardContent className="px-0">
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
            {data.agents.map((agent) => (
              <TableRow key={`${agent.workspaceSlug}:${agent.name}`}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell>{agent.workspace}</TableCell>
                <TableCell>
                  <time dateTime={agent.updatedAt}>{formatTimestampWithAge(agent.updatedAt)}</time>
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
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function APIKeys({ data }: { data: MemberAdministration }) {
  if (!data.apiKeys.length) return <AdministrationState kind="empty" title="No API Keys" />
  return (
    <Card>
      <CardContent className="px-0">
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
            {data.apiKeys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>{key.workspace}</TableCell>
                <TableCell>
                  <Badge variant={key.revokedAt ? "destructive" : "success"}>
                    {key.revokedAt ? "Revoked" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <time dateTime={key.createdAt}>{formatTimestampWithAge(key.createdAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Activity({ data }: { data: MemberAdministration }) {
  if (!data.activity.length)
    return <AdministrationState kind="empty" title="No Membership activity" />
  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label={`${data.member.name} Membership activity`}>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.activity.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <time dateTime={event.createdAt}>{formatTimestampWithAge(event.createdAt)}</time>
                </TableCell>
                <TableCell>{event.actor}</TableCell>
                <TableCell className="font-mono text-sm">{event.action}</TableCell>
                <TableCell>
                  <Badge variant={event.result === "succeeded" ? "success" : "destructive"}>
                    {event.result}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
