import dynamic from "next/dynamic"
import type { Metadata } from "next"
import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { removeMembershipAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationState } from "@/components/administration"
import { AssignmentForm } from "@/components/assignment-form"
import { DestructiveConfirmationDialog } from "@/components/destructive-confirmation-dialog"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  EmptyValue,
  TableHead,
  TableHeader,
  RelativeDateTime,
  TableRow,
} from "@/components/ui/table"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getEffectiveAccessDetail } from "@/data/access"
import { getMemberAdministration, type MemberAdministration } from "@/data/members"
import { getDestructiveImpact } from "@/data/operations"
import { ResultBadge } from "../../event-trail/event-trail-event"

const AccessDetailView = dynamic(() =>
  import("../../access/[memberId]/access-graph").then((module) => module.AccessDetailView)
)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ memberId: string; orgSlug: string }>
}): Promise<Metadata> {
  const { memberId, orgSlug } = await params
  const data = await getMemberAdministration(orgSlug, memberId)
  return {
    title: {
      absolute: data ? `${data.member.name} - User | AgentZ` : "User | AgentZ",
    },
  }
}

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
    { href: `${root}?tab=access` as Route, label: "Roles and access" },
    { href: `${root}?tab=agents` as Route, label: `Owned Agents (${data.agents.length})` },
    { href: `${root}?tab=keys` as Route, label: `API keys (${data.apiKeys.length})` },
    { href: `${root}?tab=activity` as Route, label: "Activity" },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start gap-2">
          <SidebarTrigger className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 items-center gap-3">
            <Avatar>
              <AvatarImage alt="" src={data.member.image ?? undefined} />
              <AvatarFallback>{data.member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
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
        </div>
        <RouteTabs label="User details" tabs={tabs} />
      </header>
      {activeTab === "access" ? (
        <UserAccess data={data} orgSlug={orgSlug} />
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

async function Summary({ data, orgSlug }: { data: MemberAdministration; orgSlug: string }) {
  const [disableImpact, removeImpact] = data.self
    ? [null, null]
    : await Promise.all([
        data.member.disabledAt
          ? null
          : getDestructiveImpact(orgSlug, {
              operation: "membership_disable",
              targetId: data.member.id,
              targetType: "organization_membership",
            }),
        getDestructiveImpact(orgSlug, {
          operation: "membership_remove",
          targetId: data.member.id,
          targetType: "organization_membership",
        }),
      ])

  return (
    <section className="min-w-0 space-y-3">
      <h2 className="px-4 text-lg font-medium md:px-6">Membership</h2>
      <div className="w-full min-w-0 border-b">
        <Table aria-label={`${data.member.name} membership summary`}>
          <TableBody>
            <TableRow>
              <TableHead scope="row">Roles</TableHead>
              <TableCell>
                <AssignmentList values={data.member.roles} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Teams</TableHead>
              <TableCell>
                <AssignmentList values={data.member.teams} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Joined</TableHead>
              <TableCell>
                <RelativeDateTime value={data.member.createdAt} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row">Last activity</TableHead>
              <TableCell>
                {data.member.lastActivity ? (
                  <RelativeDateTime value={data.member.lastActivity} />
                ) : (
                  <EmptyValue />
                )}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      {disableImpact || removeImpact ? (
        <section className="flex max-w-3xl flex-col gap-4 px-4 pt-3 pb-6 sm:flex-row sm:items-center sm:justify-between md:px-6">
          <div>
            <h2 className="font-medium">Membership actions</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Revoke access temporarily or remove this Membership permanently.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {disableImpact ? (
              <DestructiveConfirmationDialog
                action={removeMembershipAction.bind(
                  null,
                  orgSlug,
                  data.member.id,
                  "membership_disable"
                )}
                confirmation={disableImpact.confirmation}
                fingerprint={disableImpact.fingerprint}
                kind="disable"
                submitLabel="Disable Membership"
                successMessage="User disabled"
                title={`Disable ${disableImpact.targetLabel}?`}
              />
            ) : null}
            {removeImpact ? (
              <DestructiveConfirmationDialog
                action={removeMembershipAction.bind(
                  null,
                  orgSlug,
                  data.member.id,
                  "membership_remove"
                )}
                confirmation={removeImpact.confirmation}
                fingerprint={removeImpact.fingerprint}
                submitLabel="Remove Membership"
                successMessage="User removed"
                title={`Remove ${removeImpact.targetLabel}?`}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  )
}

function AssignmentList({ values }: { values: string[] }) {
  if (!values.length) return <EmptyValue />

  return (
    <span>
      {values.slice(0, 3).join(", ")}
      {values.length > 3 ? (
        <span className="text-muted-foreground"> · +{values.length - 3}</span>
      ) : null}
    </span>
  )
}

async function UserAccess({ data, orgSlug }: { data: MemberAdministration; orgSlug: string }) {
  const detail = await getEffectiveAccessDetail(orgSlug, data.member.id)
  if (!detail)
    return <AdministrationState kind={detail === undefined ? "forbidden" : "not-found"} />
  return (
    <div className="flex min-w-0 flex-col gap-8 pb-6">
      {data.member.disabledAt ? null : (
        <AssignmentForm
          kind="member"
          memberId={data.member.id}
          name={data.member.name}
          orgSlug={orgSlug}
          roleIds={data.member.roleIds}
          roles={data.roles}
          teamIds={data.member.teamIds}
          teams={data.teams}
        />
      )}
      <AccessDetailView detail={detail} />
    </div>
  )
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
                  <RelativeDateTime value={agent.updatedAt} />
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
                <span className="text-muted-foreground">_</span>
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
      <Table aria-label={`${data.member.name} API keys`}>
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
                  <RelativeDateTime value={key.createdAt} />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                <span className="text-muted-foreground">_</span>
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
                  <RelativeDateTime value={event.createdAt} />
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar size="sm">
                      <AvatarImage alt="" src={data.member.image ?? undefined} />
                      <AvatarFallback>{event.actor.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate">{event.actor}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">{event.action}</TableCell>
                <TableCell>
                  <ResultBadge result={event.result} />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                <span className="text-muted-foreground">_</span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
