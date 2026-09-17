import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import * as z from "zod"
import Workflow from "@/components/blocks/workflow/workflow"
import { Skeleton } from "@/components/ui/skeleton"
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { WorkflowsFilters } from "./workflows-filters"
import { searchParamStringSchema } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Workflow Graphs",
}

const workflowsSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
})

export default function WorkflowsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/graphs">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceWorkflows {...props} />
    </Suspense>
  )
}

async function WorkspaceWorkflows({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/graphs">) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready" || workspace.workspace.type === "coding") {
    notFound()
  }
  const parsed = workflowsSearchParamsSchema.parse(search)
  const selection = resolvePageSelection(workspace, "workflows/graphs", parsed)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <AdministrationPageHeader title="Workflows" />
      <Suspense
        fallback={
          <>
            <FiltersSkeleton />
            <CanvasSkeleton />
          </>
        }
      >
        <WorkflowContent selection={selection} />
      </Suspense>
    </main>
  )
}

async function WorkflowContent({ selection }: { selection: Promise<ResolvedPageSelection> }) {
  const { selected, requested, agents, workflows, workflow, error } = await selection
  if (error) return <ErrorPanel message={error.message} />
  return (
    <>
      <RememberPageSelection selected={selected} requested={requested} />
      <WorkflowsFilters
        agents={agents}
        workflows={workflows}
        selectedAgentName={selected.agent_name}
        selectedWorkflowName={selected.workflow_name}
      />
      {!selected.agent_name ? (
        <EmptyState message="No agents available" />
      ) : !workflow ? (
        <EmptyState message={`No workflows available for ${selected.agent_name}`} />
      ) : (
        <Workflow key={`${selected.agent_name}:${selected.workflow_name}`} workflow={workflow} />
      )}
    </>
  )
}

function FiltersSkeleton() {
  return (
    <div className="bg-background border-b px-4 py-2 sm:px-6">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52" />
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52" />
        </div>
      </div>
    </div>
  )
}

function CanvasSkeleton() {
  return (
    <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-t">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[14px_14px] opacity-35" />
        <div className="from-background/22 absolute inset-x-0 top-0 h-32 bg-linear-to-b to-transparent" />
      </div>
      <div className="bg-card/88 border-border/70 absolute top-4 left-4 z-10 w-[calc(100vw-2rem)] max-w-sm rounded-lg border p-1 shadow-lg shadow-black/5 backdrop-blur-md sm:w-sm">
        <div className="flex items-start gap-2 rounded-md px-3 py-2.5">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="mt-0.5 size-4 rounded-sm" />
        </div>
      </div>
      <div className="bg-card absolute bottom-4 left-4 z-10 flex flex-col gap-px overflow-hidden rounded-md border p-1">
        <Skeleton className="size-6.5 rounded-sm" />
        <Skeleton className="size-6.5 rounded-sm" />
        <Skeleton className="size-6.5 rounded-sm" />
      </div>
      <div className="absolute top-[53%] right-10 left-9 -translate-y-1/2">
        <div className="flex min-w-max items-center gap-12">
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton isLast />
        </div>
      </div>
    </div>
  )
}

function WorkflowNodeSkeleton({ isLast = false }: { isLast?: boolean }) {
  return (
    <div className="relative shrink-0">
      {isLast ? null : (
        <div className="bg-sidebar-ring/45 absolute top-1/2 left-full ml-2.5 h-px w-9 -translate-y-1/2" />
      )}
      <div className="bg-background/94 border-border/70 dark:bg-accent/82 w-[20rem] rounded-xl border p-4 shadow-[0_16px_40px_-30px_rgb(15_23_42/0.45)]">
        <div className="flex items-center justify-between gap-5">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-4 w-7" />
            </div>
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-4 w-7" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert className="px-6" variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
