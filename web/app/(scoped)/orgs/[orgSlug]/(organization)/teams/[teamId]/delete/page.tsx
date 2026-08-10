import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { deleteTeamAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationState, ImpactReviewFrame } from "@/components/administration"
import { DestructiveConfirmation } from "@/components/destructive-confirmation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getDestructiveImpact } from "@/data/operations"

export default async function DeleteTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { orgSlug, teamId } = await params
  const { error } = await searchParams
  const impact = await getDestructiveImpact(orgSlug, {
    operation: "team_delete",
    targetId: teamId,
    targetType: "team",
  })
  if (impact === undefined) return <AdministrationState kind="forbidden" />
  if (impact === null) notFound()
  const root = `/orgs/${orgSlug}/teams/${teamId}`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Team was not deleted</AlertTitle>
          <AlertDescription>
            {error === "stale-preview"
              ? "The impact changed after this page loaded. Review the refreshed impact before confirming again."
              : "The Team no longer satisfies the deletion requirements."}
          </AlertDescription>
        </Alert>
      ) : null}
      <ImpactReviewFrame
        description="Review every access loss and transfer eligible Agent ownership before deleting this Team. Organisation Memberships are preserved."
        items={impact.items}
        title={`Delete ${impact.targetLabel}`}
      />
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,24rem)] sm:items-end sm:justify-between">
        <Button asChild variant="outline">
          <Link href={root as Route}>Cancel</Link>
        </Button>
        <DestructiveConfirmation
          action={deleteTeamAction.bind(null, orgSlug, teamId)}
          confirmation={impact.confirmation}
          fingerprint={impact.fingerprint}
          submitLabel="Delete Team"
        />
      </div>
    </div>
  )
}
