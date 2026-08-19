import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { getWorkspacePage } from "@/data/workspaces"
import { WorkspaceTable } from "./workspace-table"

export const unstable_instant = false

export const metadata = { title: "Workspaces" }

export default async function WorkspacesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug }, { page_token }] = await Promise.all([params, searchParams])
  const result = await getWorkspacePage(orgSlug, page_token)
  if (result.scope.kind !== "ready" || !result.directory) {
    return null
  }

  const root = `/orgs/${result.scope.organization.slug}`
  if (!result.directory.can_enter_organization) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <AdministrationPageHeader title="Workspaces" />
        <AdministrationState kind="forbidden" />
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
                <Plus data-icon="inline-start" />
                Create workspace
              </Link>
            </Button>
          ) : undefined
        }
        title="Workspaces"
      />
      <WorkspaceTable
        canCreate={result.directory.can_create}
        hasNextPage={Boolean(result.directory.next_page_token)}
        nextPageToken={result.directory.next_page_token}
        orgSlug={result.scope.organization.slug}
        workspaces={result.directory.workspaces}
      />
    </div>
  )
}
