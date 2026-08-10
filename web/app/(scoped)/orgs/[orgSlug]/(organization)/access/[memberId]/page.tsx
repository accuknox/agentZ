import dynamic from "next/dynamic"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { getEffectiveAccessDetail } from "@/data/access"

const AccessDetailView = dynamic(() =>
  import("./access-graph").then((module) => module.AccessDetailView)
)

export default async function AccessDetailPage({
  params,
}: {
  params: Promise<{ memberId: string; orgSlug: string }>
}) {
  const { memberId, orgSlug } = await params
  const detail = await getEffectiveAccessDetail(orgSlug, memberId)
  if (detail === undefined) {
    return <AdministrationState kind="forbidden" />
  }
  if (detail === null) {
    notFound()
  }

  return <AccessDetailView detail={detail} />
}
