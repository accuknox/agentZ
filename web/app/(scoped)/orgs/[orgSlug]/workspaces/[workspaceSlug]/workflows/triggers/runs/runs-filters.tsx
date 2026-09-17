"use client"

import { BotIcon, CalendarSync, Webhook } from "lucide-react"
import type { Agent, WorkflowSchedule, WorkflowWebhookTrigger } from "@/lib/gateway/client"
import { useSelectResource } from "@/components/page-selection"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function RunsFilters({
  agents,
  selectedAgentName,
  selectedType,
  schedules,
  selectedScheduleName,
  selectedWorkflowName,
  selectedWebhookAPIKeyID,
  webhookTriggers,
}: {
  agents: Agent[]
  selectedAgentName?: string
  selectedType: string
  schedules: WorkflowSchedule[]
  selectedScheduleName?: string
  selectedWorkflowName?: string
  selectedWebhookAPIKeyID?: string
  webhookTriggers: (WorkflowWebhookTrigger & { label: string })[]
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
        {selectedType === "webhook" ? (
          <Select
            value={
              selectedWorkflowName && selectedWebhookAPIKeyID
                ? JSON.stringify([selectedWorkflowName, selectedWebhookAPIKeyID])
                : ""
            }
            onValueChange={(value) => {
              const trigger = webhookTriggers.find(
                (trigger) => JSON.stringify([trigger.workflow_name, trigger.api_key_id]) === value
              )
              if (trigger)
                select({
                  agent_name: selectedAgentName,
                  type: "webhook",
                  workflow_name: trigger.workflow_name,
                  webhook_api_key_id: trigger.api_key_id,
                })
            }}
            disabled={webhookTriggers.length === 0 || pending}
          >
            <SelectTrigger
              aria-label="Webhook trigger"
              className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52"
            >
              <SelectValue placeholder="Webhook trigger" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {webhookTriggers.map((trigger) => (
                  <SelectItem
                    key={JSON.stringify([trigger.workflow_name, trigger.api_key_id])}
                    value={JSON.stringify([trigger.workflow_name, trigger.api_key_id])}
                  >
                    <Webhook />
                    {trigger.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={selectedScheduleName ?? ""}
            onValueChange={(schedule_name) =>
              select({ agent_name: selectedAgentName, type: "schedule", schedule_name })
            }
            disabled={schedules.length === 0 || pending}
          >
            <SelectTrigger
              aria-label="Schedule"
              className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52"
            >
              <SelectValue placeholder="Schedule" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {schedules.map((schedule) => (
                  <SelectItem key={schedule.name} value={schedule.name}>
                    <CalendarSync />
                    {schedule.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )
}
