"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { Controller, useForm } from "react-hook-form"
import { BotIcon, Workflow } from "lucide-react"
import type { Agent, WorkflowSchedule } from "@/lib/gateway/client"
import {
  workflowRunFiltersFormSchema,
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

type RunsFiltersProps = {
  agents: Agent[]
  selectedAgentName?: string
  schedules: WorkflowSchedule[]
  selectedScheduleName?: string
  action: (formData: FormData) => void | Promise<void>
}

export function RunsFilters({
  agents,
  selectedAgentName,
  schedules,
  selectedScheduleName,
  action,
}: RunsFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<WorkflowRunFiltersFormValues>({
    resolver: zodResolver(workflowRunFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      schedule_name: selectedScheduleName ?? "",
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
    if (values.schedule_name) {
      formData.set("schedule_name", values.schedule_name)
    }

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
                  schedule_name: "",
                } satisfies WorkflowRunFiltersFormValues
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
          name="schedule_name"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextScheduleName) => {
                const nextValues = {
                  agent_name: form.getValues("agent_name"),
                  schedule_name: nextScheduleName,
                } satisfies WorkflowRunFiltersFormValues
                form.setValue("schedule_name", nextScheduleName, {
                  shouldDirty: false,
                  shouldTouch: false,
                })
                submitSelection(nextValues)
              }}
              disabled={schedules.length === 0 || pending}
            >
              <SelectTrigger className="h-8 w-full min-w-52 rounded-md sm:w-72">
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
      </div>
    </form>
  )
}
