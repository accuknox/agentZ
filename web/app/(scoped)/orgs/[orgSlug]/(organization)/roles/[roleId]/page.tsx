import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function RolePage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId: encodedRoleId } = await params
  const roleId = decodeURIComponent(encodedRoleId)
  redirect(`/orgs/${orgSlug}/roles/${roleId}/permissions` as Route)
}
