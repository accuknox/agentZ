import type { Metadata } from "next"
import { notFound } from "next/navigation"
import * as z from "zod"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { listAgentsCachedQuery } from "@/data/agent.queries"
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
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Secrets",
}

const secretsSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
  agent_name: searchParamStringSchema,
  sort_by: searchParamStringSchema.pipe(z.enum(["key", "created_at"]).default("key")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("asc")),
})

type SearchParams = {
  page_token?: SearchParamStringInput
  agent_name?: SearchParamStringInput
  sort_by?: SearchParamStringInput
  sort_order?: SearchParamStringInput
}

export default async function SecretsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const [{ orgSlug, workspaceSlug }, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind !== "ready") {
    notFound()
  }
  const agents = await listAgentsCachedQuery(undefined, workspace.workspace.id)
  if (agents.error) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <AdministrationPageHeader title="Secrets" />
        <AdministrationState
          description={agents.error.code === "forbidden" ? undefined : agents.error.message}
          kind={agents.error.code === "forbidden" ? "forbidden" : "failed"}
          title={agents.error.code === "forbidden" ? undefined : "Unable to load Agents"}
        />
      </main>
    )
  }
  const readableAgents = agents.agents.filter((agent) => agent.capabilities.read_secrets)
  const firstReadableAgent = readableAgents[0]
  if (!firstReadableAgent) {
    return (
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
        <AdministrationPageHeader title="Secrets" />
        <AdministrationState kind="forbidden" />
      </main>
    )
  }
  const parsed = secretsSearchParamsSchema.parse(search)
  const selectedAgent =
    readableAgents.find((agent) => agent.name === parsed.agent_name) ?? firstReadableAgent
  const writableAgent =
    readableAgents.find(
      (agent) => agent.name === parsed.agent_name && agent.capabilities.write_secrets
    ) ?? readableAgents.find((agent) => agent.capabilities.write_secrets)
  const result = await listSecretsCachedQuery(selectedAgent.name, workspace.workspace.id, {
    limit: 50,
    page_token: parsed.page_token,
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
