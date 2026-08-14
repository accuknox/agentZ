import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import { getMemberDirectory } from "@/data/members"
import { InvitationDialog } from "./member-actions"
import { UserDirectoryTable } from "./user-directory-table"

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string; tab?: string }>
}) {
  const [{ orgSlug }, { page_token, tab }] = await Promise.all([params, searchParams])
  const activeTab = tab === "invited" || tab === "disabled" ? tab : "active"
  const data = await getMemberDirectory(orgSlug, {
    pageToken: page_token,
    tab: activeTab,
  })
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
        actions={<InvitationDialog orgSlug={orgSlug} roles={data.roles} teams={data.teams} />}
        title="Users"
      />
      <div className="px-4 md:px-6">
        <RouteTabs label="User states" tabs={tabs} />
      </div>
      <UserDirectoryTable data={data} orgSlug={orgSlug} tab={activeTab} />
    </div>
  )
}
import type { Route } from "next"
