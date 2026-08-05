import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function RolePage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId } = await params
  redirect(`/orgs/${orgSlug}/roles/${roleId}/permissions` as Route)
}
