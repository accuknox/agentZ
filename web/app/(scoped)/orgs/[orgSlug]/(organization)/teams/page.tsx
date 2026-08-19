import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { listTeams } from "@/data/teams"
import { TeamTable } from "./team-table"

export const metadata = { title: "Teams" }

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug }, { page_token }] = await Promise.all([params, searchParams])
  const data = await listTeams(orgSlug, page_token)
  if (!data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <AdministrationPageHeader title="Teams" />
        <AdministrationState kind="forbidden" />
      </div>
    )
  }
  const root = `/orgs/${orgSlug}/teams`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <Button asChild>
            <Link href={`${root}/new` as Route}>
              <Plus data-icon="inline-start" />
              Create team
            </Link>
          </Button>
        }
        title="Teams"
      />
      <TeamTable nextPageToken={data.nextPageToken} orgSlug={orgSlug} teams={data.teams} />
    </div>
  )
}
