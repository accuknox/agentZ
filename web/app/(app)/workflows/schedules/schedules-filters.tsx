"use client"

import * as React from "react"
import { BotIcon } from "lucide-react"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"
import type { Agent } from "@/lib/gateway/client"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type SchedulesFiltersProps = {
  agents: Agent[]
  selectedAgentName?: string
}

export function SchedulesFilters({ agents, selectedAgentName }: SchedulesFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  function updateAgentName(agentName: string) {
    const params = new URLSearchParams(searchParams)
    params.delete("page_token")
    params.delete("token_stack")
    params.set("agent_name", agentName)

    startTransition(() => {
      const query = params.toString()
      router.replace(query === "" ? pathname : `${pathname}?${query}`)
    })
  }

  return (
    <div
      data-pending={pending}
      className="bg-background flex min-h-14 flex-col gap-3 border-b px-6 py-2 data-[pending=true]:opacity-70 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={selectedAgentName}
          onValueChange={updateAgentName}
          disabled={agents.length === 0}
        >
          <SelectTrigger className="h-8 w-full min-w-52 rounded-md sm:w-64">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  <BotIcon className="inline-block" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
