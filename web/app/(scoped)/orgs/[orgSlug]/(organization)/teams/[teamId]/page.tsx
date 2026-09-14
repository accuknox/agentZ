import { AdministrationLoadingState } from "@/components/administration"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getDestructiveImpact } from "@/data/operations"
import { getTeamEditorData } from "@/data/teams"
import { TeamDelete } from "../team-delete"
import { TeamForm } from "../team-form"

export const metadata = { title: "Summary" }

export default function TeamSummaryPage(props: PageProps<"/orgs/[orgSlug]/teams/[teamId]">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <TeamSummaryContent {...props} />
    </Suspense>
  )
}

async function TeamSummaryContent({ params }: PageProps<"/orgs/[orgSlug]/teams/[teamId]">) {
  const { orgSlug, teamId } = await params
  const [data, impact] = await Promise.all([
    getTeamEditorData(orgSlug, teamId),
    getDestructiveImpact(orgSlug, {
      operation: "team_delete",
      targetId: teamId,
      targetType: "team",
    }),
  ])
  if (!data?.team) notFound()
  return (
    <div className="flex flex-col gap-6">
      <TeamForm data={data} embedded orgSlug={orgSlug} />
      {impact ? (
        <TeamDelete
          confirmation={impact.confirmation}
          fingerprint={impact.fingerprint}
          orgSlug={orgSlug}
          teamId={teamId}
          teamName={impact.targetLabel}
        />
      ) : null}
    </div>
  )
}
