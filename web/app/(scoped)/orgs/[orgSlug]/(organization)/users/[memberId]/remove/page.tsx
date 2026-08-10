import Link from "next/link"
import type { Route } from "next"
import { notFound } from "next/navigation"
import { removeMembershipAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationState, ImpactReviewFrame } from "@/components/administration"
import { DestructiveConfirmation } from "@/components/destructive-confirmation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getDestructiveImpact } from "@/data/operations"

export default async function RemoveMembershipPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string; orgSlug: string }>
  searchParams: Promise<{ error?: string; operation?: string }>
}) {
  const { memberId, orgSlug } = await params
  const search = await searchParams
  const operation =
    search.operation === "membership_remove" ? "membership_remove" : "membership_disable"
  const impact = await getDestructiveImpact(orgSlug, {
    operation,
    targetId: memberId,
    targetType: "organization_membership",
  })
  if (impact === undefined) return <AdministrationState kind="forbidden" />
  if (impact === null) notFound()
  const root = `/orgs/${orgSlug}/users/${memberId}`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {search.error ? (
        <Alert variant="destructive">
          <AlertTitle>Membership was not changed</AlertTitle>
          <AlertDescription>
            {search.error === "stale-preview"
              ? "The impact changed after this page loaded. Review the refreshed impact before confirming again."
              : search.error === "final-superadmin"
                ? "The final active Superadmin cannot be disabled or removed."
                : search.error === "final-team-member"
                  ? "Repair the affected Team membership before continuing."
                  : search.error === "self-removal"
                    ? "Administrators cannot remove their own Membership."
                    : "The Membership no longer satisfies the requested operation."}
          </AlertDescription>
        </Alert>
      ) : null}
      <ImpactReviewFrame
        description={`Review the complete authorization and cleanup impact before ${operation === "membership_remove" ? "removing" : "disabling"} this Membership.`}
        items={impact.items}
        title={`${operation === "membership_remove" ? "Remove" : "Disable"} ${impact.targetLabel}`}
      />
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,24rem)] sm:items-end sm:justify-between">
        <Button asChild variant="outline">
          <Link href={root as Route}>Cancel</Link>
        </Button>
        <DestructiveConfirmation
          action={removeMembershipAction.bind(null, orgSlug, memberId, operation)}
          confirmation={impact.confirmation}
          fingerprint={impact.fingerprint}
          submitLabel={
            operation === "membership_remove" ? "Remove Membership" : "Disable Membership"
          }
        />
      </div>
    </div>
  )
}
