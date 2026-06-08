"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useProgress } from "@bprogress/next"
import { Controller, useForm } from "react-hook-form"
import { BotIcon } from "lucide-react"
import type { Agent } from "@/lib/gateway/client"
import { workflowFiltersFormSchema, type WorkflowFiltersFormValues } from "@/data/workflow.schema"
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
  action: (formData: FormData) => void | Promise<void>
}

export function SchedulesFilters({ agents, selectedAgentName, action }: SchedulesFiltersProps) {
  const [pending, startTransition] = React.useTransition()
  const progress = useProgress()
  const form = useForm<WorkflowFiltersFormValues>({
    resolver: zodResolver(workflowFiltersFormSchema),
    defaultValues: {
      agent_name: selectedAgentName ?? "",
      workflow_name: "",
    },
  })

  React.useEffect(() => {
    if (pending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [pending, progress])

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
                form.setValue("agent_name", nextAgentName, {
                  shouldDirty: false,
                  shouldTouch: false,
                })

                const formData = new FormData()
                formData.set("agent_name", nextAgentName)

                startTransition(() => {
                  void action(formData)
                })
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
      </div>
    </form>
  )
}
