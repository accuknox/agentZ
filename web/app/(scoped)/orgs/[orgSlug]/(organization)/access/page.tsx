import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function AccessPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  redirect(`/orgs/${orgSlug}/users` as Route)
}
