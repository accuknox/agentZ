import dynamic from "next/dynamic"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { getTeamEffectiveAccessDetail } from "@/data/access"

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
  const detail = await getTeamEffectiveAccessDetail(orgSlug, teamId)
  if (detail === undefined) return <AdministrationState kind="forbidden" />
  if (detail === null) notFound()
  return <TeamAccessView detail={detail} />
}
