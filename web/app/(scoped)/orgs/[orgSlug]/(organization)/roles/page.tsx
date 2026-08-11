import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
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
    <div className="flex min-w-0 flex-col gap-4">
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
        <Table aria-label="Organisation Roles" className="min-w-4xl">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Teams</TableHead>
              <TableHead className="text-right">Permissions</TableHead>
              <TableHead>Dependencies</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.roles.length ? (
              result.roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell>
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`/orgs/${orgSlug}/roles/${role.id}/permissions` as Route}
                    >
                      {role.name}
                    </Link>
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
                </TableRow>
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
