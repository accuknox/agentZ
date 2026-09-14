import { Suspense } from "react"
import { getTeamEditorData } from "@/data/teams"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { TeamForm } from "../team-form"

export const metadata = { title: "New team" }

export default function NewTeamPage(props: PageProps<"/orgs/[orgSlug]/teams/new">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <NewTeamContent {...props} />
    </Suspense>
  )
}

async function NewTeamContent({ params }: PageProps<"/orgs/[orgSlug]/teams/new">) {
  const { orgSlug } = await params
  const data = await getTeamEditorData(orgSlug)
  if (!data) return <AdministrationState kind="forbidden" />
  return <TeamForm data={data} orgSlug={orgSlug} />
}
