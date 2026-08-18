import { deleteTeamAction } from "@/app/(scoped)/orgs/actions"
import { DestructiveConfirmationDialog } from "@/components/destructive-confirmation-dialog"

export function TeamDelete({
  confirmation,
  fingerprint,
  orgSlug,
  teamId,
  teamName,
}: {
  confirmation: string
  fingerprint: string
  orgSlug: string
  teamId: string
  teamName: string
}) {
  return (
    <section className="flex max-w-3xl flex-row items-center justify-between gap-3 px-4 pb-6 md:px-6">
      <h2 className="text-lg font-medium">Destructive</h2>
      <DestructiveConfirmationDialog
        action={deleteTeamAction.bind(null, orgSlug, teamId)}
        confirmation={confirmation}
        fingerprint={fingerprint}
        submitLabel="Delete Team"
        successMessage="Team deleted"
        title={`Delete ${teamName}?`}
      />
    </section>
  )
}
