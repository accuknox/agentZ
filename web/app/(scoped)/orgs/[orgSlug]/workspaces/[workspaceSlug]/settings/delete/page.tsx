import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { deleteWorkspaceAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationState, ImpactReviewFrame } from "@/components/administration"
import { DestructiveConfirmation } from "@/components/destructive-confirmation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getDestructiveImpact } from "@/data/operations"
import { getWorkspaceScope } from "@/data/workspaces"

export default async function DeleteWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const { error } = await searchParams
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
  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="px-4 pt-4 md:px-6 md:pt-6">
        <h1 className="text-2xl font-semibold tracking-normal">Delete {impact.targetLabel}</h1>
      </header>
      {error ? (
        <Alert className="mx-4 md:mx-6" variant="destructive">
          <AlertTitle>Workspace was not deleted</AlertTitle>
          <AlertDescription>
            {error === "stale-preview"
              ? "The impact changed after this page loaded. Review the refreshed impact before confirming again."
              : "The Workspace no longer satisfies the deletion requirements."}
          </AlertDescription>
        </Alert>
      ) : null}
      <ImpactReviewFrame
        description="Access is revoked transactionally. Kubernetes, OpenBao, persistent Agent data, workflow state, telemetry, and scoped credentials are then reconciled durably."
        items={impact.items}
        title="Deletion impact"
      />
      <div className="grid gap-3 px-4 pb-6 sm:grid-cols-[auto_minmax(0,24rem)] sm:items-end sm:justify-between md:px-6">
        <Button asChild variant="outline">
          <Link href={root as Route}>Cancel</Link>
        </Button>
        <DestructiveConfirmation
          action={deleteWorkspaceAction.bind(null, orgSlug, workspaceSlug, scope.workspace.id)}
          confirmation={impact.confirmation}
          fingerprint={impact.fingerprint}
          submitLabel="Delete Workspace"
        />
      </div>
    </div>
  )
}
