import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationState, StatusBadge } from "@/components/administration"
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
        description="Create a Workspace to organise access and infrastructure inside this Organisation."
        kind="empty"
        title="No Workspaces yet"
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {result.directory.can_create ? (
        <div className="flex justify-end">
          <Button asChild>
            <Link href={`${root}/workspaces/new` as Route}>
              <Plus />
              Create Workspace
            </Link>
          </Button>
        </div>
      ) : null}
      <Card>
        <CardContent className="px-0">
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
        </CardContent>
      </Card>
    </div>
  )
}
