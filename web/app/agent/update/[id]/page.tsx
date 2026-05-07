import { notFound } from "next/navigation"
import { StepperWithForm } from "@/app/agent/new/wizard"
import { listAgentsAction } from "@/data/agent.actions"
import { listEnvironmentsAction } from "@/data/environment.actions"
import { agentWizardValues } from "@/data/utils"

export default async function UpdateAgent({ params }: PageProps<"/agent/update/[id]">) {
  const { id } = await params
  const [result, environments] = await Promise.all([
    listAgentsAction(true, { limit: 1, session_id: [id] }),
    listEnvironmentsAction({ limit: 50 }),
  ])

  if (result.error) {
    return (
      <div className="flex min-h-0 flex-1 p-4 sm:px-6 sm:pb-6">
        <div className="w-full rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.error.message}
        </div>
      </div>
    )
  }

  const agent = result.agents[0]
  if (!agent) {
    notFound()
  }

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
        initialValues={agentWizardValues(agent)}
        initialHasNextEnvironmentPage={environments.hasNextPage}
        initialNextEnvironmentPageToken={environments.nextPageToken}
        mode="update"
        sessionID={agent.session_id}
      />
    </div>
  )
}
