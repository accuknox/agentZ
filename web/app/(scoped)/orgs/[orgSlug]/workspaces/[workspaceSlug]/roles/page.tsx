import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationState, ScopeBadge } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listWorkspaceRoles } from "@/data/roles"
import { formatTimestampWithAge } from "@/lib/format"

export const unstable_instant = false

export default async function WorkspaceRolesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const result = await listWorkspaceRoles(orgSlug, workspaceSlug)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }

  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Workspace Roles</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Delegate access inside {result.workspace.name} without granting Organisation control.
          </p>
        </div>
        <Button asChild>
          <Link href={`${root}/new` as Route}>
            <Plus />
            Create Role
          </Link>
        </Button>
      </div>
      <Card>
        <CardContent className="overflow-x-auto px-0">
          <Table aria-label={`${result.workspace.name} Roles`} className="min-w-4xl">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Teams</TableHead>
                <TableHead className="text-right">Permissions</TableHead>
                <TableHead>Dependencies</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell>
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`${root}/${role.id}/permissions` as Route}
                    >
                      {role.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ScopeBadge scope="Workspace" />
                  </TableCell>
                  <TableCell>
                    <Badge variant={role.immutable ? "secondary" : "outline"}>
                      {role.immutable ? "System" : "Custom"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{role.users}</TableCell>
                  <TableCell className="text-right tabular-nums">{role.teams}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {role.systemRole === "workspace_admin" ? "All" : role.permissionCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={role.dependencyState === "Needs repair" ? "warning" : "outline"}
                    >
                      {role.dependencyState}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <time dateTime={role.updatedAt}>{formatTimestampWithAge(role.updatedAt)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
