import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { listOrganizationRoles } from "@/data/roles"
import { RoleTable } from "./role-table"

export const unstable_instant = false

export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug }, { page_token }] = await Promise.all([params, searchParams])
  const result = await listOrganizationRoles(orgSlug, page_token)
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
      <RoleTable nextPageToken={result.nextPageToken} orgSlug={orgSlug} roles={result.roles} />
    </div>
  )
}
