"use client"

import { useTransition } from "react"
import { toast } from "sonner"
import { setWorkflowLockAction } from "@/data/workflow.actions"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentAvatar } from "@/components/interior/agent-presence"
import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { listWorkflowSummariesOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { useParams, usePathname, useSearchParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkflowIcon, FlaskConical } from "lucide-react"
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
  selectedAgentName: initialAgentName,
  workflows: initialWorkflows,
  selectedWorkflowName: initialWorkflowName,
  workspaceId,
}: {
  workspaceId: string
  agents: Agent[]
  selectedAgentName?: string
  workflows: WorkflowSummary[]
  selectedWorkflowName?: string
}) {
  const pathname = usePathname()
  const search = useSearchParams()
  const selectedAgentName = search.get("agent_name") ?? initialAgentName
  const workflowOptions = useQuery({
    ...listWorkflowSummariesOptions({
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      path: { agentName: selectedAgentName ?? "" },
    }),
    enabled: !!selectedAgentName,
    initialData: selectedAgentName === initialAgentName ? initialWorkflows : undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: "always",
  })
  const workflows = workflowOptions.data ?? []
  const selectedWorkflowName =
    search.get("workflow_name") ??
    (selectedAgentName === initialAgentName ? initialWorkflowName : workflows[0]?.workflow_name)
  const selectedWorkflow = workflows.find(
    (workflow) => workflow.workflow_name === selectedWorkflowName
  )
  const { orgSlug, workspaceSlug } = useParams<{ orgSlug: string; workspaceSlug: string }>()
  const root = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/workflows` as const
  const params = new URLSearchParams()
  if (selectedAgentName) params.set("agent_name", selectedAgentName)
  if (selectedWorkflowName) params.set("workflow_name", selectedWorkflowName)
  const { pending, select } = useSelectResource()

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background px-4 py-2 sm:px-6">
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
                  <AgentAvatar appearance={agent.appearance} />
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
          disabled={workflows.length === 0 || pending || workflowOptions.isFetching}
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
      <div className="ml-auto flex flex-wrap items-center gap-3">
        {selectedAgentName && selectedWorkflow ? (
          <WorkflowLockControl
            key={`${selectedAgentName}:${selectedWorkflowName}`}
            agentName={selectedAgentName}
            workflow={selectedWorkflow}
            workspaceId={workspaceId}
            disabled={
              pending ||
              workflowOptions.isFetching ||
              !agents.some((agent) => agent.name === selectedAgentName && agent.capabilities.use)
            }
          />
        ) : null}
        <Tabs
          value={pathname.endsWith("/evaluations") ? "evaluations" : "graphs"}
          className="shrink-0"
        >
          <TabsList aria-label="Workflow views">
            <TabsTrigger value="graphs" asChild>
              <Link href={`${root}/graphs?${params}`}>Graph</Link>
            </TabsTrigger>
            <TabsTrigger value="evaluations" asChild>
              <Link href={`${root}/evaluations?${params}`}>Evaluations</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {pathname.endsWith("/evaluations") ? (
          <Badge variant="plain">
            <FlaskConical data-icon="inline-start" />
            Preview
          </Badge>
        ) : null}
      </div>
    </div>
  )
}

function WorkflowLockControl({
  agentName,
  workflow,
  workspaceId,
  disabled,
}: {
  agentName: string
  workflow: WorkflowSummary
  workspaceId: string
  disabled: boolean
}) {
  const [pending, startTransition] = useTransition()
  const queryClient = useQueryClient()
  const { lock, workflow_name: workflowName } = workflow
  const state = lock.locked ? "Locked" : "Unlocked"
  const actor = lock.actor
  const actorName = actor?.name ?? actor?.email ?? actor?.id
  const action = lock.locked ? "Unlock" : "Lock"
  const options = listWorkflowSummariesOptions({
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { agentName },
  })

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-r border-border/70 pr-3"
      aria-busy={pending}
    >
      {actor ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`${state} by ${actorName}`}
            >
              <Avatar size="sm" aria-hidden="true">
                <AvatarImage src={actor.image ?? undefined} alt="" />
                <AvatarFallback>
                  {actorName
                    ?.split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase())
                    .join("")}
                </AvatarFallback>
              </Avatar>
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex flex-col gap-0.5">
            <span>
              {state} by {actorName}
            </span>
            {actor.email ? <span className="opacity-75">{actor.email}</span> : null}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-md text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
            aria-pressed={lock.locked}
            disabled={disabled || pending}
            aria-label={`${action} workflow ${workflowName}`}
            onClick={() => {
              startTransition(async () => {
                try {
                  const result = await setWorkflowLockAction(
                    workspaceId,
                    { agentName, workflowName },
                    {
                      locked: !lock.locked,
                      expected_version: lock.version,
                    }
                  )
                  if (result.error) {
                    toast.error(result.error.message)
                    await queryClient.invalidateQueries({ queryKey: options.queryKey })
                    return
                  }
                  queryClient.setQueryData(options.queryKey, (workflows) =>
                    workflows?.map((workflow) =>
                      workflow.workflow_name === workflowName
                        ? { ...workflow, lock: result.lock }
                        : workflow
                    )
                  )
                } catch {
                  toast.error("Could not change workflow lock. Refresh and try again.")
                }
              })
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4.5"
            >
              <path
                d="M8 10V6a4 4 0 0 1 8 0v4"
                className={cn(
                  "origin-[16px_10px] transition-transform duration-200 ease-out motion-reduce:transition-none",
                  !lock.locked && "rotate-25"
                )}
              />
              <rect x="5" y="10" width="14" height="11" rx="3" />
              <path d="M12 14v3" />
            </svg>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{pending ? "Saving workflow lock…" : `${action} workflow`}</TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {state}
      </span>
    </div>
  )
}
