import { redirect } from "next/navigation"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { resolveWorkspaceDestination } from "@/data/workspaces"

export const metadata = { title: "Overview" }

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const destination = await resolveWorkspaceDestination(orgSlug, workspaceSlug)
  if (destination && destination !== `/orgs/${orgSlug}/workspaces/${workspaceSlug}`) {
    redirect(destination)
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Overview" />
      <AdministrationState
        kind={destination ? "empty" : "forbidden"}
        title={destination ? "No agents available" : undefined}
        description={
          destination ? "Use the sidebar to open the workspace pages you can access." : undefined
        }
      />
    </div>
  )
}
