import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { listWorkspaceRoles } from "@/data/roles"
import { RoleTable } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-table"

export const unstable_instant = false

export default async function WorkspaceRolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug, workspaceSlug }, { page_token }] = await Promise.all([params, searchParams])
  const result = await listWorkspaceRoles(orgSlug, workspaceSlug, page_token)
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
      <RoleTable
        nextPageToken={result.nextPageToken}
        orgSlug={orgSlug}
        roles={result.roles}
        workspaceSlug={workspaceSlug}
      />
    </div>
  )
}
