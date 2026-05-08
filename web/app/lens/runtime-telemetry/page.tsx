import { redirect } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"

export default async function RuntimeTelemetryPage() {
  const result = await listAgentsCachedQuery(true)
  const agents = result.agents ?? []
  const firstAgent = agents[0]

  if (!firstAgent) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-0 p-0">
        <p className="text-muted-foreground">No agents available</p>
      </main>
    )
  }

  redirect(`/lens/runtime-telemetry/process?session_id=${firstAgent.session_id}`)
}
