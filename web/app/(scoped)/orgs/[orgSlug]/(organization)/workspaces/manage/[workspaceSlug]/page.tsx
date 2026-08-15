import { notFound } from "next/navigation"
import { deleteWorkspaceAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationState } from "@/components/administration"
import { DestructiveConfirmationDialog } from "@/components/destructive-confirmation-dialog"
import { getDestructiveImpact } from "@/data/operations"
import { getWorkspaceScope } from "@/data/workspaces"
import { WorkspaceGeneralForm } from "./workspace-general-form"

export const metadata = { title: "Summary" }

export default async function ManageWorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.scope.kind !== "ready" || !scope.scope.organization.superadmin) {
    return <AdministrationState kind="forbidden" />
  }
  if (scope.kind !== "ready") notFound()
  const impact = await getDestructiveImpact(orgSlug, {
    operation: "workspace_delete",
    targetId: scope.workspace.id,
    targetType: "workspace",
  })
  if (impact === undefined) return <AdministrationState kind="forbidden" />
  if (impact === null) notFound()

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h2 className="px-4 text-lg font-medium md:px-6">Workspace Details</h2>
        <WorkspaceGeneralForm
          name={scope.workspace.name}
          orgSlug={orgSlug}
          workspaceId={scope.workspace.id}
        />
      </section>
      <section className="flex max-w-3xl items-center justify-between gap-3 px-4 pb-6 md:px-6">
        <h2 className="text-lg font-medium">Destructive</h2>
        <DestructiveConfirmationDialog
          action={deleteWorkspaceAction.bind(null, orgSlug, scope.workspace.id)}
          confirmation={impact.confirmation}
          fingerprint={impact.fingerprint}
          submitLabel="Delete Workspace"
          title={`Delete ${impact.targetLabel}?`}
        />
      </section>
    </div>
  )
}
