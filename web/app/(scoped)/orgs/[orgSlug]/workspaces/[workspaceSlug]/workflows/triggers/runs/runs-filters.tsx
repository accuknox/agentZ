"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { Controller, useForm } from "react-hook-form"
import { BotIcon, CalendarSync, Webhook, Workflow } from "lucide-react"
import type { Agent, WorkflowSchedule } from "@/lib/gateway/client"
import {
  workflowRunFiltersFormSchema,
  type WorkflowRunFiltersFormInput,
  type WorkflowRunFiltersFormValues,
} from "@/data/workflow.schema"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type WebhookTriggerOption = {
  apiKeyId: string
  label: string
  workflowName: string
}

type RunsFiltersProps = {
  agents: Agent[]
  selectedAgentName?: string
  selectedType: "schedule" | "webhook"
  schedules: WorkflowSchedule[]
  selectedScheduleName?: string
  selectedWorkflowName?: string
  selectedWebhookAPIKeyID?: string
  webhookTriggers: WebhookTriggerOption[]
  action: (formData: FormData) => void | Promise<void>
}

export function RunsFilters({
  agents,
  selectedAgentName,
  selectedType,
  schedules,
  selectedScheduleName,
  selectedWorkflowName,
  selectedWebhookAPIKeyID,
  webhookTriggers,
  action,
}: RunsFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<WorkflowRunFiltersFormInput, unknown, WorkflowRunFiltersFormValues>({
    resolver: zodResolver(workflowRunFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      type: selectedType,
      workflow_name: selectedWorkflowName ?? "",
      schedule_name: selectedScheduleName ?? "",
      webhook_api_key_id: selectedWebhookAPIKeyID ?? "",
    },
  })

  React.useEffect(() => {
    if (pending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [pending, progress])

  function submitSelection(values: WorkflowRunFiltersFormValues) {
    const formData = new FormData()
    formData.set("agent_name", values.agent_name)
    formData.set("type", values.type)
    if (values.workflow_name) {
      formData.set("workflow_name", values.workflow_name)
    }
    if (values.schedule_name) {
      formData.set("schedule_name", values.schedule_name)
    }
    if (values.webhook_api_key_id) {
      formData.set("webhook_api_key_id", values.webhook_api_key_id)
    }

    startTransition(() => {
      void action(formData)
    })
  }

  return (
    <form className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        <Controller
          name="agent_name"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextAgentName) => {
                const nextValues = {
                  agent_name: nextAgentName,
                  type: form.getValues("type"),
                  workflow_name: "",
                  schedule_name: "",
                  webhook_api_key_id: "",
                } satisfies WorkflowRunFiltersFormValues
                form.reset(nextValues)
                submitSelection(nextValues)
              }}
              disabled={agents.length === 0 || pending}
            >
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52">
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
          )}
        />
        <Controller
          name="type"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextType) => {
                if (nextType !== "schedule" && nextType !== "webhook") {
                  return
                }

                const nextValues = {
                  agent_name: form.getValues("agent_name"),
                  type: nextType,
                  workflow_name: "",
                  schedule_name: "",
                  webhook_api_key_id: "",
                } satisfies WorkflowRunFiltersFormValues
                form.reset(nextValues)
                submitSelection(nextValues)
              }}
              disabled={pending}
            >
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-44 sm:min-w-40">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="schedule">
                    <CalendarSync /> Schedule
                  </SelectItem>
                  <SelectItem value="webhook">
                    <Webhook /> Webhook
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
        {selectedType === "schedule" ? (
          <Controller
            name="schedule_name"
            control={form.control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(nextScheduleName) => {
                  const schedule =
                    schedules.find(
                      (currentSchedule) => currentSchedule.name === nextScheduleName
                    ) ?? null
                  const nextValues = {
                    agent_name: form.getValues("agent_name"),
                    type: "schedule",
                    workflow_name: schedule?.workflow_name ?? "",
                    schedule_name: nextScheduleName,
                    webhook_api_key_id: "",
                  } satisfies WorkflowRunFiltersFormValues
                  form.reset(nextValues)
                  submitSelection(nextValues)
                }}
                disabled={schedules.length === 0 || pending}
              >
                <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52">
                  <SelectValue placeholder="Schedule" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {schedules.map((schedule) => (
                      <SelectItem key={schedule.name} value={schedule.name}>
                        <Workflow className="inline-block" />
                        {schedule.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          />
        ) : (
          <Select
            value={
              selectedWorkflowName && selectedWebhookAPIKeyID
                ? `${selectedWorkflowName}:${selectedWebhookAPIKeyID}`
                : ""
            }
            onValueChange={(nextValue) => {
              const trigger =
                webhookTriggers.find(
                  (currentTrigger) =>
                    `${currentTrigger.workflowName}:${currentTrigger.apiKeyId}` === nextValue
                ) ?? null
              const nextValues = {
                agent_name: form.getValues("agent_name"),
                type: "webhook",
                workflow_name: trigger?.workflowName ?? "",
                schedule_name: "",
                webhook_api_key_id: trigger?.apiKeyId ?? "",
              } satisfies WorkflowRunFiltersFormValues
              form.reset(nextValues)
              submitSelection(nextValues)
            }}
            disabled={webhookTriggers.length === 0 || pending}
          >
            <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-[26rem] sm:min-w-72">
              <SelectValue placeholder="Webhook trigger" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {webhookTriggers.map((trigger) => (
                  <SelectItem
                    key={`${trigger.workflowName}:${trigger.apiKeyId}`}
                    value={`${trigger.workflowName}:${trigger.apiKeyId}`}
                  >
                    <Webhook className="inline-block" />
                    {trigger.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
    </form>
  )
}
