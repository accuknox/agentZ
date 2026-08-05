import { getTeamEditorData } from "@/data/teams"
import { AdministrationState } from "@/components/administration"
import { TeamForm } from "../team-form"

export default async function NewTeamPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const data = await getTeamEditorData(orgSlug)
  if (!data) return <AdministrationState kind="forbidden" />
  return <TeamForm data={data} orgSlug={orgSlug} />
}
