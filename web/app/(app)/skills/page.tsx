import type { Metadata } from "next"
import * as z from "zod"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { SkillsClient } from "./skills-client"

export const metadata: Metadata = {
  title: "Skills",
}

const skillsSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
})

type SkillsSearchParams = {
  agent_name?: SearchParamStringInput
}

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<SkillsSearchParams>
}) {
  const [agents, params] = await Promise.all([
    listAgentsCachedQuery({ limit: 200 }),
    skillsSearchParamsSchema.parse(await searchParams),
  ])

  if (agents.error) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <div className="px-4 pt-4 md:px-6 md:pt-6">
          <h1 className="text-2xl font-semibold tracking-normal">Skills</h1>
        </div>
        <div className="border-destructive/30 bg-destructive/5 text-destructive mx-4 rounded-lg border p-4 text-sm md:mx-6">
          {agents.error.message}
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <SkillsClient agents={agents.agents} initialAgentName={params.agent_name} />
    </main>
  )
}
