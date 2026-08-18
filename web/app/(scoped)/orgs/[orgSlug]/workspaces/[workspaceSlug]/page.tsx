import { redirect } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { resolveWorkspaceDestination } from "@/data/workspaces"

export const metadata = { title: "Overview" }

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const destination = await resolveWorkspaceDestination(orgSlug, workspaceSlug)
  if (destination) {
    redirect(destination)
  }

  return <AdministrationState kind="forbidden" />
}
