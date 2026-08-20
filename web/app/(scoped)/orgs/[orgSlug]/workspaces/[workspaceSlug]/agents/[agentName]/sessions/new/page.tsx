import { redirect } from "next/navigation"

export default async function LegacyNewSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentName: string; orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ draft?: string }>
}) {
  const [{ agentName, orgSlug, workspaceSlug }, query] = await Promise.all([params, searchParams])
  const next = new URLSearchParams({ agent: agentName })
  if (query.draft) next.set("draft", query.draft)
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/sessions/new?${next}`)
}
