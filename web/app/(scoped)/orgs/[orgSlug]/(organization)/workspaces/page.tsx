import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import {
  AdministrationPageHeader,
  AdministrationState,
  StatusBadge,
} from "@/components/administration"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getWorkspaceDirectory } from "@/data/workspaces"
import { formatAge } from "@/lib/format"

export const unstable_instant = false

export default async function WorkspacesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const result = await getWorkspaceDirectory(orgSlug)
  if (result.scope.kind !== "ready" || !result.directory) {
    return null
  }

  const root = `/orgs/${result.scope.organization.slug}`
  if (!result.directory.can_enter_organization) {
    return <AdministrationState kind="forbidden" />
  }
  return (
    <div className="flex flex-col gap-6">
      <AdministrationPageHeader
        actions={
          result.directory.can_create ? (
            <Button asChild>
              <Link href={`${root}/workspaces/new` as Route}>
                <Plus />
                Create workspace
              </Link>
            </Button>
          ) : undefined
        }
        title="Workspaces"
      />
      <div className="w-full min-w-0 border-b">
        <Table aria-label="Workspaces" className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-36">Status</TableHead>
              <TableHead className="w-36 text-right">Administrators</TableHead>
              <TableHead className="w-32">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.directory.workspaces.length ? (
              result.directory.workspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell>
                    <Link
                      className="font-medium hover:underline"
                      href={`${root}/workspaces/${workspace.slug}` as Route}
                    >
                      {workspace.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={workspace.state} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {workspace.workspace_admin_count}
                  </TableCell>
                  <TableCell>
                    <time dateTime={workspace.updated_at}>{formatAge(workspace.updated_at)}</time>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={4}>
                  No workspaces
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
