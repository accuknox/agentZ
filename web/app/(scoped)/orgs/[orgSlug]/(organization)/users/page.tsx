import type { Route } from "next"
import Link from "next/link"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getMemberDirectory, type ActiveMember, type InvitationRow } from "@/data/members"
import { formatAge } from "@/lib/format"
import { CancelInvitationButton, InviteMemberDialog, MembershipStateButton } from "./member-actions"

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { orgSlug } = await params
  const { tab } = await searchParams
  const data = await getMemberDirectory(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  const activeTab = tab === "invited" || tab === "disabled" ? tab : "active"
  const root = `/orgs/${orgSlug}/users`
  const tabs = [
    { href: `${root}/status/active` as Route, label: `Active (${data.active.length})` },
    { href: `${root}/status/invited` as Route, label: `Invited (${data.invited.length})` },
    { href: `${root}/status/disabled` as Route, label: `Disabled (${data.disabled.length})` },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={<InviteMemberDialog orgSlug={orgSlug} roles={data.roles} teams={data.teams} />}
        title="Users"
      />
      <div className="px-4 md:px-6">
        <RouteTabs label="User states" tabs={tabs} />
      </div>
      {activeTab === "invited" ? (
        <InvitationsTable
          invitations={data.invited}
          orgSlug={orgSlug}
          roles={data.roles}
          teams={data.teams}
        />
      ) : (
        <MembersTable
          disabled={activeTab === "disabled"}
          members={activeTab === "disabled" ? data.disabled : data.active}
          orgSlug={orgSlug}
        />
      )}
    </div>
  )
}

function MembersTable({
  disabled,
  members,
  orgSlug,
}: {
  disabled: boolean
  members: ActiveMember[]
  orgSlug: string
}) {
  return (
    <div className="w-full min-w-0 border-b">
      <Table
        aria-label={disabled ? "Disabled Users" : "Active Users"}
        className="w-full table-fixed"
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-64">User</TableHead>
            <TableHead>Assignments</TableHead>
            <TableHead className="w-28 text-right">Agents</TableHead>
            <TableHead className="w-24 text-right">API keys</TableHead>
            <TableHead className="w-32">Last active</TableHead>
            <TableHead className="w-32">Joined</TableHead>
            {disabled ? <TableHead className="w-28 text-right">Action</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length ? (
            members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="max-w-72">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        className="truncate font-medium underline-offset-4 hover:underline"
                        href={`/orgs/${orgSlug}/users/${member.id}` as Route}
                        title={member.name}
                      >
                        {member.name}
                      </Link>
                    </div>
                    <div className="text-muted-foreground truncate text-xs" title={member.email}>
                      {member.email}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <AssignmentSummary roles={member.roles} teams={member.teams} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{member.ownedAgents}</TableCell>
                <TableCell className="text-right tabular-nums">{member.apiKeys}</TableCell>
                <TableCell>
                  {member.lastActivity ? (
                    <time dateTime={member.lastActivity}>{formatAge(member.lastActivity)}</time>
                  ) : (
                    <span className="text-muted-foreground">No session activity</span>
                  )}
                </TableCell>
                <TableCell>
                  <time dateTime={member.createdAt}>{formatAge(member.createdAt)}</time>
                </TableCell>
                {disabled ? (
                  <TableCell className="text-right">
                    <MembershipStateButton disabled memberId={member.id} orgSlug={orgSlug} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={disabled ? 7 : 6}>
                {disabled ? "No disabled users" : "No active users"}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function InvitationsTable({
  invitations,
  orgSlug,
  roles,
  teams,
}: {
  invitations: InvitationRow[]
  orgSlug: string
  roles: { id: string; name: string }[]
  teams: { id: string; name: string }[]
}) {
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label="Pending Invitations" className="w-full min-w-3xl table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-64">Email</TableHead>
            <TableHead>Initial Access</TableHead>
            <TableHead className="w-56">Inviter</TableHead>
            <TableHead className="w-32">Expiry</TableHead>
            <TableHead className="w-40 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.length ? (
            invitations.map((invitation) => (
              <TableRow key={invitation.id}>
                <TableCell className="max-w-72">
                  <span className="truncate font-medium" title={invitation.email}>
                    {invitation.email}
                  </span>
                </TableCell>
                <TableCell>
                  <AssignmentSummary roles={invitation.roles} teams={invitation.teams} />
                </TableCell>
                <TableCell className="max-w-56 truncate" title={invitation.inviter}>
                  {invitation.inviter}
                </TableCell>
                <TableCell>
                  <time dateTime={invitation.expiresAt}>{formatAge(invitation.expiresAt)}</time>
                  {invitation.expired ? <Badge variant="destructivePlain">Expired</Badge> : null}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <CopyButton content={invitation.link} />
                    <Button asChild size="sm" variant="ghost">
                      <a href={invitation.link}>Open</a>
                    </Button>
                    <InviteMemberDialog
                      invitation={invitation}
                      orgSlug={orgSlug}
                      roles={roles}
                      teams={teams}
                    />
                    <CancelInvitationButton invitationId={invitation.id} orgSlug={orgSlug} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={5}>
                No pending invitations
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function AssignmentSummary({ roles, teams }: { roles: string[]; teams: string[] }) {
  const items = [
    ...roles.map((role) => ({ kind: "Role", label: role })),
    ...teams.map((team) => ({ kind: "Team", label: team })),
  ]
  if (items.length === 0) {
    return <span className="text-muted-foreground">No product access</span>
  }

  return (
    <span className="text-sm">
      {items
        .slice(0, 4)
        .map((item) => `${item.kind}: ${item.label}`)
        .join(" · ")}
      {items.length > 4 ? (
        <span className="text-muted-foreground"> · +{items.length - 4} more</span>
      ) : null}
    </span>
  )
}
