import dynamic from "next/dynamic"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { AssignmentForm } from "@/components/assignment-form"
import { getTeamEffectiveAccessDetail } from "@/data/access"
import { getTeamEditorData } from "@/data/teams"

const TeamAccessView = dynamic(() =>
  import("./team-access").then((module) => module.TeamAccessView)
)

export const metadata = { title: "Roles & access" }

export default async function TeamRolesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const [detail, editor] = await Promise.all([
    getTeamEffectiveAccessDetail(orgSlug, teamId),
    getTeamEditorData(orgSlug, teamId),
  ])
  if (detail === undefined || editor === undefined) {
    return <AdministrationState kind="forbidden" />
  }
  if (detail === null || !editor.team) notFound()
  return (
    <div className="flex min-w-0 flex-col gap-8 pb-6">
      <AssignmentForm
        kind="team"
        name={editor.team.name}
        orgSlug={orgSlug}
        roleIds={editor.team.roleIds}
        roles={editor.roles}
        teamId={teamId}
        updatedAt={editor.team.updatedAt}
      />
      <TeamAccessView detail={detail} />
    </div>
  )
}
