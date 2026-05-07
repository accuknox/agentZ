import { listEnvironmentsAction } from "@/data/environment.actions"
import { StepperWithForm } from "./wizard"

export default async function NewAgent() {
  const environments = await listEnvironmentsAction({ limit: 50 })

  if (environments.error) {
    return (
      <div className="flex min-h-0 flex-1 p-4 sm:px-6 sm:pb-6">
        <div className="w-full rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {environments.error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 p-4 sm:px-6 sm:pb-6">
      <StepperWithForm
        environments={environments.environments}
        initialHasNextEnvironmentPage={environments.hasNextPage}
        initialNextEnvironmentPageToken={environments.nextPageToken}
      />
    </div>
  )
}
