import type { Route } from "next"
import { notFound } from "next/navigation"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getMemberDirectory, type MemberTab } from "@/data/members"
import { CreateInvitationDialog } from "../../member-actions"
import { UserDirectoryTable } from "../../user-directory-table"

export const metadata = { title: "Users" }

export default async function UserStatePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; state: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const [{ orgSlug, state }, { page_token }] = await Promise.all([params, searchParams])
  if (state !== "active" && state !== "invited" && state !== "disabled") {
    notFound()
  }

  const tab: MemberTab = state
  const data = await getMemberDirectory(orgSlug, { pageToken: page_token, tab })
  if (!data) return <AdministrationState kind="forbidden" />

  const root = `/orgs/${orgSlug}/users`
  const tabs = [
    { href: `${root}/status/active` as Route, label: "Active" },
    { href: `${root}/status/invited` as Route, label: "Invited" },
    { href: `${root}/status/disabled` as Route, label: "Disabled" },
  ] satisfies RouteTab[]
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={<CreateInvitationDialog orgSlug={orgSlug} roles={data.roles} teams={data.teams} />}
        title="Users"
      />
      <div className="px-4 md:px-6">
        <RouteTabs label="User states" tabs={tabs} />
      </div>
      <UserDirectoryTable data={data} orgSlug={orgSlug} tab={tab} />
    </div>
  )
}
