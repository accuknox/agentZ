import type { Route } from "next"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { formatTimestampWithAge } from "@/lib/format"
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
    { href: `${root}/active` as Route, label: `Active (${data.active.length})` },
    { href: `${root}/invited` as Route, label: `Invited (${data.invited.length})` },
    { href: `${root}/disabled` as Route, label: `Disabled (${data.disabled.length})` },
  ] satisfies RouteTab[]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Manage active, invited, and disabled Organisation Memberships. Disabled users keep
            account access but lose product authorization immediately.
          </p>
        </div>
        <InviteMemberDialog orgSlug={orgSlug} roles={data.roles} teams={data.teams} />
      </div>
      <RouteTabs label="User states" tabs={tabs} />
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
  if (members.length === 0) {
    return (
      <AdministrationState
        description={
          disabled
            ? "No Organisation Memberships are disabled."
            : "Invite a User or accept Social Admission to create Memberships."
        }
        kind="empty"
        title={disabled ? "No disabled Memberships" : "No active Users"}
      />
    )
  }

  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label={disabled ? "Disabled Users" : "Active Users"}>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Assignments</TableHead>
              <TableHead className="text-right">Owned Agents</TableHead>
              <TableHead className="text-right">API Keys</TableHead>
              <TableHead>Last Activity</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="max-w-72">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium" title={member.name}>
                        {member.name}
                      </span>
                      {member.superadmin ? <Badge variant="secondary">Superadmin</Badge> : null}
                      <Badge variant={disabled ? "destructive" : "outline"}>
                        {disabled ? "Disabled" : "Active"}
                      </Badge>
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
                    <time dateTime={member.lastActivity}>
                      {formatTimestampWithAge(member.lastActivity)}
                    </time>
                  ) : (
                    <span className="text-muted-foreground">No session activity</span>
                  )}
                </TableCell>
                <TableCell>
                  <time dateTime={member.createdAt}>
                    {formatTimestampWithAge(member.createdAt)}
                  </time>
                </TableCell>
                <TableCell className="text-right">
                  <MembershipStateButton
                    disabled={disabled}
                    memberId={member.id}
                    orgSlug={orgSlug}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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
  if (invitations.length === 0) {
    return (
      <AdministrationState
        description="Pending Invitations appear here until accepted, replaced, cancelled, or expired."
        kind="empty"
        title="No pending Invitations"
      />
    )
  }

  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label="Pending Invitations">
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Initial Access</TableHead>
              <TableHead>Inviter</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invitation) => (
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
                  <time dateTime={invitation.expiresAt}>
                    {formatTimestampWithAge(invitation.expiresAt)}
                  </time>
                  {invitation.expired ? <Badge variant="destructive">Expired</Badge> : null}
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
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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
    <div className="flex max-w-lg flex-wrap gap-1">
      {items.slice(0, 4).map((item) => (
        <Badge key={`${item.kind}:${item.label}`} variant="outline">
          {item.kind}: {item.label}
        </Badge>
      ))}
      {items.length > 4 ? <Badge variant="secondary">+{items.length - 4}</Badge> : null}
    </div>
  )
}
