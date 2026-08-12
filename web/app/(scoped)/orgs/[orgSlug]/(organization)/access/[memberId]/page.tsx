import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function AccessDetailPage({
  params,
}: {
  params: Promise<{ memberId: string; orgSlug: string }>
}) {
  const { memberId, orgSlug } = await params
  redirect(`/orgs/${orgSlug}/users/${memberId}?tab=access` as Route)
}
