"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BotIcon, WorkflowIcon } from "lucide-react"
import type { Agent, WorkflowSummary } from "@/lib/gateway/client"
import { useSelectResource } from "@/components/page-selection"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function WorkflowsFilters({
  agents,
  selectedAgentName,
  workflows,
  selectedWorkflowName,
}: {
  agents: Agent[]
  selectedAgentName?: string
  workflows: WorkflowSummary[]
  selectedWorkflowName?: string
}) {
  const pathname = usePathname()
  const { orgSlug, workspaceSlug } = useParams<{ orgSlug: string; workspaceSlug: string }>()
  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/workflows` as const
  const params = new URLSearchParams()
  if (selectedAgentName) params.set("agent_name", selectedAgentName)
  if (selectedWorkflowName) params.set("workflow_name", selectedWorkflowName)
  const { pending, select } = useSelectResource()

  return (
    <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
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
          value={selectedWorkflowName ?? ""}
          onValueChange={(workflow_name) =>
            select({ agent_name: selectedAgentName, workflow_name })
          }
          disabled={workflows.length === 0 || pending}
        >
          <SelectTrigger
            aria-label="Workflow"
            className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52"
          >
            <SelectValue placeholder="Workflow" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {workflows.map((workflow) => (
                <SelectItem key={workflow.workflow_name} value={workflow.workflow_name}>
                  <WorkflowIcon />
                  {workflow.workflow_name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Tabs
        value={pathname.endsWith("/evaluations") ? "evaluations" : "graphs"}
        className="shrink-0"
      >
        <TabsList aria-label="Workflow views">
          <TabsTrigger value="graphs" asChild>
            <Link href={`${root}/graphs?${params}`}>Graph</Link>
          </TabsTrigger>
          <TabsTrigger value="evaluations" asChild>
            <Link href={`${root}/evaluations?${params}`}>
              Evaluations <Badge variant="secondary">Preview</Badge>
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}
