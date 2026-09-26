"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
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
  const { pending, select } = useSelectResource()
  const pathname = usePathname()
  const root = pathname.slice(0, pathname.indexOf("/workflows/"))
  const query = { agent_name: selectedAgentName, workflow_name: selectedWorkflowName }

  return (
    <>
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
      </div>
      <nav
        aria-label="Workflow sections"
        className="bg-background flex gap-6 border-b px-4 sm:px-6"
      >
        {[
          { label: "Graph", path: "graphs" },
          { label: "Runs", path: "runs" },
          { label: "Evaluations", path: "evaluations" },
        ].map((tab) => (
          <Link
            key={tab.path}
            href={{ pathname: `${root}/workflows/${tab.path}`, query }}
            aria-current={pathname.endsWith(tab.path) ? "page" : undefined}
            className={`border-b-2 py-3 text-sm transition-colors ${pathname.endsWith(tab.path) ? "border-primary text-foreground font-semibold" : "text-muted-foreground hover:text-foreground border-transparent"}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  )
}
