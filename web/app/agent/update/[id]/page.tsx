import { notFound } from "next/navigation"
import { StepperWithForm } from "@/app/agent/new/wizard"
import { listAgentsAction } from "@/data/agent.actions"
import { agentWizardValues } from "@/data/utils"

export default async function UpdateAgent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await listAgentsAction(true, { limit: 1, session_id: [id] })

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

  return (
    <div className="flex min-h-0 flex-1 p-4 sm:px-6 sm:pb-6">
      <StepperWithForm
        initialValues={agentWizardValues(agent)}
        mode="update"
        sessionID={agent.session_id}
      />
    </div>
  )
}
