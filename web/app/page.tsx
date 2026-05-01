import Link from "next/link"
import { Plus } from "lucide-react"
import { listAgentsAction } from "@/data/agent.actions"
import { Button } from "@/components/ui/button"
import { AgentTable } from "@/app/agent-table"

export default function Home() {
  return (
    <main className="flex flex-1 flex-col gap-6 p-4 pt-0 md:p-6 md:pt-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Agents</h1>
        </div>
        <Button asChild>
          <Link href="/agent/new">
            <Plus />
            New agent
          </Link>
        </Button>
      </div>
      <Agents />
    </main>
  )
}

async function Agents() {
  const result = await listAgentsAction(true)

  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {result.error.message}
      </div>
    )
  }

  return <AgentTable agents={result.agents} />
}
