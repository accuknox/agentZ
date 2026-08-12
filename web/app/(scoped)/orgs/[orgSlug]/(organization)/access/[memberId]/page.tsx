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

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <header className="px-4 pt-4 md:px-6 md:pt-6">
        <h1 className="text-2xl font-semibold tracking-normal">
          {detail.member.name || detail.member.email} access
        </h1>
      </header>
      <AccessDetailView detail={detail} />
    </main>
  )
}
