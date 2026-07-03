"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { Controller, useForm } from "react-hook-form"
import { BotIcon, CalendarSync, Webhook } from "lucide-react"
import type { Agent } from "@/lib/gateway/client"
import {
  workflowTriggerFiltersFormSchema,
  type WorkflowTriggerFiltersFormValues,
} from "@/data/workflow.schema"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type TriggersFiltersProps = {
  action: (formData: FormData) => void | Promise<void>
  agents: Agent[]
  selectedAgentName?: string
  selectedType: WorkflowTriggerFiltersFormValues["type"]
}

export function TriggersFilters({
  action,
  agents,
  selectedAgentName,
  selectedType,
}: TriggersFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<WorkflowTriggerFiltersFormValues>({
    resolver: zodResolver(workflowTriggerFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      type: selectedType,
    },
  })

  React.useEffect(() => {
    if (pending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [pending, progress])

  function submitSelection(values: WorkflowTriggerFiltersFormValues) {
    const formData = new FormData()
    formData.set("agent_name", values.agent_name)
    formData.set("type", values.type)

    startTransition(() => {
      void action(formData)
    })
  }

  return (
    <form className="bg-background flex min-h-14 flex-col gap-3 border-b px-6 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
                } satisfies WorkflowTriggerFiltersFormValues
                form.reset(nextValues)
                submitSelection(nextValues)
              }}
              disabled={agents.length === 0 || pending}
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
                } satisfies WorkflowTriggerFiltersFormValues
                form.reset(nextValues)
                submitSelection(nextValues)
              }}
              disabled={pending}
            >
              <SelectTrigger className="h-8 w-full min-w-40 rounded-md sm:w-44">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="schedule">
                    <CalendarSync className="inline-block" />
                    Schedule
                  </SelectItem>
                  <SelectItem value="webhook">
                    <Webhook className="inline-block" />
                    Webhook
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
      </div>
    </form>
  )
}
