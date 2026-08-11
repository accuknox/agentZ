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
import { formatTimestampWithAge } from "@/lib/format"

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
  if (result.directory.workspaces.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <AdministrationPageHeader title="Workspaces" />
        <AdministrationState
          actions={
            result.directory.can_create ? (
              <Button asChild>
                <Link href={`${root}/workspaces/new` as Route}>
                  <Plus />
                  Create Workspace
                </Link>
              </Button>
            ) : undefined
          }
          kind="empty"
          title="No Workspaces yet"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AdministrationPageHeader
        actions={
          result.directory.can_create ? (
            <Button asChild>
              <Link href={`${root}/workspaces/new` as Route}>
                <Plus />
                Create Workspace
              </Link>
            </Button>
          ) : undefined
        }
        title="Workspaces"
      />
      <div className="border-y">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Administrators</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.directory.workspaces.map((workspace) => (
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
                  <time dateTime={workspace.updated_at}>
                    {formatTimestampWithAge(workspace.updated_at)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
