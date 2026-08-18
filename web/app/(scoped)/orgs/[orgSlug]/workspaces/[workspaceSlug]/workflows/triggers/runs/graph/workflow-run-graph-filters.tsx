"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { BotIcon, GitBranchIcon, WorkflowIcon } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import type { Agent, WorkflowRunSummary, WorkflowSummary } from "@/lib/gateway/client"
import {
  workflowRunGraphFiltersFormSchema,
  type WorkflowRunGraphFiltersFormInput,
  type WorkflowRunGraphFiltersFormValues,
} from "@/data/workflow.schema"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type WorkflowRunGraphFiltersProps = {
  action: (formData: FormData) => void | Promise<void>
  agents: Agent[]
  selectedAgentName?: string
  selectedRunName?: string
  selectedWorkflowName?: string
  workflowRuns: WorkflowRunSummary[]
  workflows: WorkflowSummary[]
}

export function WorkflowRunGraphFilters({
  action,
  agents,
  selectedAgentName,
  selectedRunName,
  selectedWorkflowName,
  workflowRuns,
  workflows,
}: WorkflowRunGraphFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<
    WorkflowRunGraphFiltersFormInput,
    unknown,
    WorkflowRunGraphFiltersFormValues
  >({
    resolver: zodResolver(workflowRunGraphFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      workflow_name: selectedWorkflowName ?? "",
      run_name: selectedRunName ?? "",
    },
  })
  const { reset } = form

  React.useEffect(() => {
    reset({
      agent_name: selectedAgentName ?? "",
      workflow_name: selectedWorkflowName ?? "",
      run_name: selectedRunName ?? "",
    })
  }, [reset, selectedAgentName, selectedRunName, selectedWorkflowName])

  React.useEffect(() => {
    if (pending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [pending, progress])

  function submitSelection(values: WorkflowRunGraphFiltersFormValues) {
    const formData = new FormData()
    formData.set("agent_name", values.agent_name)
    if (values.workflow_name) {
      formData.set("workflow_name", values.workflow_name)
    }
    if (values.run_name) {
      formData.set("run_name", values.run_name)
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
                  workflow_name: "",
                  run_name: "",
                } satisfies WorkflowRunGraphFiltersFormValues
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
          name="workflow_name"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextWorkflowName) => {
                const nextValues = {
                  agent_name: form.getValues("agent_name"),
                  workflow_name: nextWorkflowName,
                  run_name: "",
                } satisfies WorkflowRunGraphFiltersFormValues
                form.reset(nextValues)
                submitSelection(nextValues)
              }}
              disabled={workflows.length === 0 || pending}
            >
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.workflow_name} value={workflow.workflow_name}>
                      <WorkflowIcon className="inline-block" />
                      {workflow.workflow_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
        <Controller
          name="run_name"
          control={form.control}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(nextRunName) => {
                const nextValues = {
                  agent_name: form.getValues("agent_name"),
                  workflow_name: form.getValues("workflow_name") ?? "",
                  run_name: nextRunName,
                } satisfies WorkflowRunGraphFiltersFormValues
                form.setValue("run_name", nextRunName, {
                  shouldDirty: false,
                  shouldTouch: false,
                })
                submitSelection(nextValues)
              }}
              disabled={workflowRuns.length === 0 || pending}
            >
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-80 sm:min-w-64">
                <SelectValue placeholder="Workflow run" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {workflowRuns.map((run) => (
                    <SelectItem key={run.name} value={run.name}>
                      <GitBranchIcon className="inline-block" />
                      {run.name}
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
