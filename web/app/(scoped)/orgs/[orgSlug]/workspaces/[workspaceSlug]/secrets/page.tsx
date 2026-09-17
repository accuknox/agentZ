import { Suspense } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import * as z from "zod"
import {
  AdministrationLoadingState,
  AdministrationPageHeader,
  AdministrationState,
} from "@/components/administration"
import { resolvePageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import {
  deleteSecretFormAction,
  putSecretFormAction,
  startOAuthSecretFormAction,
} from "@/data/secret.actions"
import { listSecretsCachedQuery } from "@/data/secret.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { SecretsFilters } from "./secrets-filters"
import { NewSecretButton } from "./new-secret-button"
import { SecretTable } from "./secret-table"
import { searchParamStringSchema } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Secrets",
}

const secretsSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
  agent_name: searchParamStringSchema,
  sort_by: searchParamStringSchema.pipe(z.enum(["key", "created_at"]).default("key")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("asc")),
})

export default function SecretsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/secrets">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceSecrets {...props} />
    </Suspense>
  )
}

async function WorkspaceSecrets({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/secrets">) {
  const [{ orgSlug, workspaceSlug }, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind !== "ready") {
    notFound()
  }
  const parsed = secretsSearchParamsSchema.parse(search)
  const state = await resolvePageSelection(workspace, "secrets", parsed)
  if (state.error) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <AdministrationPageHeader title="Secrets" />
        <AdministrationState
          description={state.error.code === "forbidden" ? undefined : state.error.message}
          kind={state.error.code === "forbidden" ? "forbidden" : "failed"}
          title={state.error.code === "forbidden" ? undefined : "Unable to load Agents"}
        />
      </main>
    )
  }
  const readableAgents = state.agents
  const firstReadableAgent = readableAgents[0]
  if (!firstReadableAgent) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <RememberPageSelection selected={state.selected} requested={state.requested} />
        <AdministrationPageHeader title="Secrets" />
        <AdministrationState kind="forbidden" />
      </main>
    )
  }
  const selectedAgent =
    readableAgents.find((agent) => agent.name === state.selected.agent_name) ?? firstReadableAgent
  const writableAgent =
    readableAgents.find(
      (agent) => agent.name === state.selected.agent_name && agent.capabilities.write_secrets
    ) ?? readableAgents.find((agent) => agent.capabilities.write_secrets)
  const result = await listSecretsCachedQuery(selectedAgent.name, workspace.workspace.id, {
    limit: 50,
    page_token:
      state.selected.agent_name === state.requested.agent_name ? parsed.page_token : undefined,
    sort_by: parsed.sort_by,
    sort_order: parsed.sort_order,
  })
  if (result.error) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <AdministrationPageHeader title="Secrets" />
        <AdministrationState
          description={result.error.code === "forbidden" ? undefined : result.error.message}
          kind={result.error.code === "forbidden" ? "forbidden" : "failed"}
          title={result.error.code === "forbidden" ? undefined : "Unable to load secrets"}
        />
      </main>
    )
  }
  const actionScope = {
    basePath: `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}`,
    workspaceId: workspace.workspace.id,
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <AdministrationPageHeader
        actions={
          writableAgent ? (
            <NewSecretButton
              key={writableAgent.name}
              agentName={writableAgent.name}
              putSecretAction={putSecretFormAction.bind(null, actionScope)}
              startOAuthAction={startOAuthSecretFormAction.bind(null, actionScope)}
            />
          ) : undefined
        }
        title="Secrets"
      />
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <SecretsFilters agents={readableAgents} selectedAgentName={selectedAgent.name} />
      <SecretTable
        agentName={selectedAgent.name}
        canCreate={writableAgent !== undefined}
        secrets={result.items}
        hasNextPage={result.hasNextPage}
        nextPageToken={result.nextPageToken}
        deleteSecretAction={deleteSecretFormAction.bind(null, actionScope)}
        canDelete={selectedAgent.capabilities.delete_secrets}
        workspaceId={workspace.workspace.id}
        sortBy={parsed.sort_by}
        sortOrder={parsed.sort_order}
      />
    </main>
  )
}
