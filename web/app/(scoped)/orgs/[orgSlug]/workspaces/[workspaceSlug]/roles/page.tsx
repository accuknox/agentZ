import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import {
  AdministrationPageHeader,
  AdministrationState,
  ScopeBadge,
} from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RoutedTableRow } from "@/components/routed-table-row"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listWorkspaceRoles } from "@/data/roles"
import { formatAge } from "@/lib/format"

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
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <Button asChild>
            <Link href={`${root}/new` as Route}>
              <Plus />
              Create role
            </Link>
          </Button>
        }
        title="Roles"
      />
      <div className="w-full min-w-0 border-b">
        <Table
          aria-label={`${result.workspace.name} Roles`}
          className="w-full min-w-4xl table-fixed"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-56">Name</TableHead>
              <TableHead className="w-28">Scope</TableHead>
              <TableHead className="w-24">Type</TableHead>
              <TableHead className="w-20 text-right">Users</TableHead>
              <TableHead className="w-20 text-right">Teams</TableHead>
              <TableHead className="w-28 text-right">Permissions</TableHead>
              <TableHead>Dependencies</TableHead>
              <TableHead className="w-32">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.roles.length ? (
              result.roles.map((role) => (
                <RoutedTableRow
                  aria-label={`Open ${role.name}`}
                  href={`${root}/${role.id}/permissions` as Route}
                  key={role.id}
                >
                  <TableCell>
                    <span className="font-medium">{role.name}</span>
                  </TableCell>
                  <TableCell>
                    <ScopeBadge scope="Workspace" />
                  </TableCell>
                  <TableCell>
                    <Badge variant="plain">{role.immutable ? "System" : "Custom"}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{role.users}</TableCell>
                  <TableCell className="text-right tabular-nums">{role.teams}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {role.systemRole === "workspace_admin" ? "All" : role.permissionCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={role.dependencyState === "Needs repair" ? "warningPlain" : "plain"}
                    >
                      {role.dependencyState}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <time dateTime={role.updatedAt}>{formatAge(role.updatedAt)}</time>
                  </TableCell>
                </RoutedTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={8}>
                  No roles
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
