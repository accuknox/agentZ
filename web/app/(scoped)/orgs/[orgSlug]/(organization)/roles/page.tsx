import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
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
import { listOrganizationRoles } from "@/data/roles"
import { formatAge } from "@/lib/format"

export const unstable_instant = false

export default async function RolesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const result = await listOrganizationRoles(orgSlug)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <Button asChild>
            <Link href={`/orgs/${orgSlug}/roles/new` as Route}>
              <Plus />
              Create role
            </Link>
          </Button>
        }
        title="Roles"
      />
      <div className="w-full min-w-0 border-b">
        <Table aria-label="Organisation Roles" className="w-full min-w-4xl table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-64">Name</TableHead>
              <TableHead className="w-28">Type</TableHead>
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
                  href={`/orgs/${orgSlug}/roles/${role.id}/permissions` as Route}
                  key={role.id}
                >
                  <TableCell>
                    <span className="font-medium">{role.name}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="plain">{role.immutable ? "System" : "Custom"}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{role.users}</TableCell>
                  <TableCell className="text-right tabular-nums">{role.teams}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {role.systemRole === "superadmin" ? "All" : role.permissionCount}
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
                <TableCell className="h-24 text-center" colSpan={7}>
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
