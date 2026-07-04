"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { Controller, useForm } from "react-hook-form"
import { BotIcon, Workflow } from "lucide-react"
import type { Agent, WorkflowSummary } from "@/lib/gateway/client"
import {
  workflowFiltersFormSchema,
  type WorkflowFiltersFormInput,
  type WorkflowFiltersFormValues,
} from "@/data/workflow.schema"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type WorkflowsFiltersProps = {
  agents: Agent[]
  selectedAgentName?: string
  workflows: WorkflowSummary[]
  selectedWorkflowName?: string
  action: (formData: FormData) => void | Promise<void>
}

export function WorkflowsFilters({
  agents,
  selectedAgentName,
  workflows,
  selectedWorkflowName,
  action,
}: WorkflowsFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<WorkflowFiltersFormInput, unknown, WorkflowFiltersFormValues>({
    resolver: zodResolver(workflowFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      workflow_name: selectedWorkflowName ?? "",
    },
  })

  React.useEffect(() => {
    if (pending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [pending, progress])

  function submitSelection(values: WorkflowFiltersFormValues) {
    const formData = new FormData()
    formData.set("agent_name", values.agent_name)
    if (values.workflow_name) {
      formData.set("workflow_name", values.workflow_name)
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
                  workflow_name: "",
                } satisfies WorkflowFiltersFormValues
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
          name="workflow_name"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextWorkflowName) => {
                const nextValues = {
                  agent_name: form.getValues("agent_name"),
                  workflow_name: nextWorkflowName,
                } satisfies WorkflowFiltersFormValues
                form.setValue("workflow_name", nextWorkflowName, {
                  shouldDirty: false,
                  shouldTouch: false,
                })
                submitSelection(nextValues)
              }}
              disabled={workflows.length === 0 || pending}
            >
              <SelectTrigger className="h-8 w-full min-w-52 rounded-md sm:w-72">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.workflow_name} value={workflow.workflow_name}>
                      <Workflow className="inline-block" />
                      {workflow.workflow_name}
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
