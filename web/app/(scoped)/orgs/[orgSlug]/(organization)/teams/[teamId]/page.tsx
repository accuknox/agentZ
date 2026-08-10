import { notFound } from "next/navigation"
import { getTeamEditorData } from "@/data/teams"
import { TeamDelete } from "../team-delete"
import { TeamForm } from "../team-form"

export default async function TeamSummaryPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const data = await getTeamEditorData(orgSlug, teamId)
  if (!data?.team) notFound()
  return (
    <div className="flex flex-col gap-6">
      <TeamForm data={data} orgSlug={orgSlug} />
      <TeamDelete orgSlug={orgSlug} teamId={teamId} />
    </div>
  )
}
