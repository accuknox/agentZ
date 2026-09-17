"use client"

import { BotIcon, CalendarSync, Webhook } from "lucide-react"
import type { Agent } from "@/lib/gateway/client"
import { useSelectResource } from "@/components/page-selection"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function TriggersFilters({
  agents,
  selectedAgentName,
  selectedType,
}: {
  agents: Agent[]
  selectedAgentName?: string
  selectedType: string
}) {
  const { pending, select } = useSelectResource()

  return (
    <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        <Select
          value={selectedAgentName ?? ""}
          onValueChange={(agent_name) => select({ agent_name })}
          disabled={agents.length === 0 || pending}
        >
          <SelectTrigger
            aria-label="Agent"
            className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52"
          >
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  <BotIcon />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={selectedType}
          onValueChange={(type) => select({ agent_name: selectedAgentName, type })}
          disabled={agents.length === 0 || pending}
        >
          <SelectTrigger
            aria-label="Type"
            className="h-8 w-full min-w-0 rounded-md sm:w-44 sm:min-w-52"
          >
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="schedule">
                <CalendarSync />
                Schedule
              </SelectItem>
              <SelectItem value="webhook">
                <Webhook />
                Webhook
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
