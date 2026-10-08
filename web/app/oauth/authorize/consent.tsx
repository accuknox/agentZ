"use client"

import { useEffect, useState, useTransition } from "react"
import Image from "next/image"
import { createAuthClient } from "better-auth/react"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import {
  AppWindow,
  ArrowRight,
  Check,
  ChevronDown,
  Cpu,
  Layers3,
  Plug,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { UserIdentity } from "@/components/ui/avatar"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from "@/components/ui/select"
import type { DelegationCatalog } from "@/lib/gateway/client"
import { approveConsentAction, delegationWorkspaceAction } from "./actions"
import { AuthorizationState } from "./authorization-state"

// Only the current continuation may navigate. Automatic redirects would also
// send discarded effect responses to the callback.
const authClient = createAuthClient({
  disableDefaultFetchPlugins: true,
  plugins: [oauthProviderClient()],
})

const identityScopes = [
  { value: "openid", label: "Sign you in with your AgentZ identity" },
  { value: "profile", label: "Read your name and profile image" },
  { value: "email", label: "Read your email address" },
  { value: "offline_access", label: "Keep access when you are away, until you disconnect" },
]

const mcpKinds = ["tools", "prompts", "resources"] as const

type ConsentProps = {
  oauthQuery: string
  client: { name: string; owner: string | null; callback: string }
  user: { name: string; email: string; image?: string | null }
  scopes: string[]
  organizations: { id: string; name: string }[]
  workspaces: { id: string; name: string; organizationId: string }[]
}

export function Consent({
  oauthQuery,
  client,
  user,
  scopes,
  organizations,
  workspaces,
}: ConsentProps) {
  const inference = scopes.includes("inference:use")
  const mcp = scopes.includes("mcp:use")
  const resourceAccess = inference || mcp
  const [organizationId, setOrganizationId] = useState("")
  const [workspaceId, setWorkspaceId] = useState("")
  const [catalogs, setCatalogs] = useState<Record<string, DelegationCatalog>>({})
  const [selection, setSelection] = useState<DelegationCatalog>({ models: [], mcp: [] })
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  const [loadError, setLoadError] = useState<string>()
  const [loading, startLoading] = useTransition()
  const selectedMcp = selection.mcp.reduce(
    (counts, connection) => ({
      tools: counts.tools + connection.tools.length,
      prompts: counts.prompts + connection.prompts.length,
      resources: counts.resources + connection.resources.length,
    }),
    { tools: 0, prompts: 0, resources: 0 }
  )
  const selectedSummary = [
    [selection.models.length, "model"],
    [selectedMcp.tools, "MCP tool"],
    [selectedMcp.prompts, "MCP prompt"],
    [selectedMcp.resources, "MCP resource"],
  ] as const
  const visibleCatalogs = Object.entries(catalogs).filter(
    ([id]) =>
      id === workspaceId ||
      selection.models.some((model) => model.workspace_id === id) ||
      selection.mcp.some((connection) => connection.workspace_id === id)
  )

  function loadWorkspace(id: string) {
    setWorkspaceId(id)
    setLoadError(undefined)
    setError(undefined)
    if (catalogs[id]) return
    startLoading(async () => {
      try {
        const catalog = await delegationWorkspaceAction(oauthQuery, organizationId, id)
        setCatalogs((current) => ({ ...current, [id]: catalog }))
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "Could not load resources from this workspace."
        )
      }
    })
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-center gap-6 text-center">
        <div className="flex items-center gap-5">
          <Image
            src="/agentz-logo.svg"
            alt="AgentZ"
            width={46}
            height={40}
            className="h-10 w-auto"
          />
          <div aria-hidden="true" className="flex gap-2">
            <span className="size-1.5 rounded-full bg-border" />
            <span className="size-1.5 rounded-full bg-border" />
            <span className="size-1.5 rounded-full bg-border" />
          </div>
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/5 text-primary">
            <AppWindow aria-hidden="true" className="size-5" />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Authorize <span className="wrap-anywhere text-primary">{client.name}</span>
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            {client.owner ? `An app from the ${client.owner} organization` : "This app"} wants
            access to your AgentZ account.
          </p>
        </div>
      </header>
      <div className="rounded-xl border-2 border-dashed border-border/70 bg-card/40 p-5 text-sm">
        <UserIdentity name={user.name} email={user.email} image={user.image} size="default" />
      </div>
      {identityScopes.some((scope) => scopes.includes(scope.value)) ? (
        <section aria-labelledby="account-access-heading" className="flex flex-col gap-4">
          <h2 id="account-access-heading" className="text-sm font-semibold wrap-anywhere">
            {client.name} is requesting access to:
          </h2>
          <div className="min-w-0">
            <details className="group" open>
              <summary className="flex cursor-pointer list-none items-center gap-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <Check aria-hidden="true" className="size-5 shrink-0 text-success" />
                Your account information
                <ChevronDown
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-muted-foreground group-open:rotate-180"
                />
              </summary>
              <ul className="mt-3 flex list-disc flex-col gap-2 pl-8 text-sm leading-relaxed text-muted-foreground">
                {identityScopes
                  .filter((scope) => scopes.includes(scope.value))
                  .map((scope) => (
                    <li key={scope.value}>{scope.label}</li>
                  ))}
              </ul>
            </details>
          </div>
        </section>
      ) : null}
      {resourceAccess ? (
        <section aria-labelledby="resource-access-heading" className="flex flex-col gap-5">
          <h2
            id="resource-access-heading"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <Layers3 aria-hidden="true" className="size-4 text-primary" />
            Choose resource access
          </h2>
          {organizations.length === 0 ? (
            <Alert>
              <AlertDescription>
                No organization currently allows delegation for your account. Ask an organization
                administrator to enable it.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <FieldGroup className="sm:grid sm:grid-cols-2 sm:items-end">
                <Field>
                  <FieldLabel htmlFor="consent-organization">Organization</FieldLabel>
                  <Select
                    value={organizationId}
                    disabled={pending || loading}
                    onValueChange={(value) => {
                      setOrganizationId(value)
                      setWorkspaceId("")
                      setCatalogs({})
                      setSelection({ models: [], mcp: [] })
                      setError(undefined)
                      setLoadError(undefined)
                    }}
                  >
                    <SelectTrigger id="consent-organization" className="w-full">
                      <SelectValue placeholder="Select an organization" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {organizations.map((organization) => (
                          <SelectItem key={organization.id} value={organization.id}>
                            {organization.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="consent-workspace">Workspace</FieldLabel>
                  <Select
                    value={workspaceId}
                    disabled={pending || loading || !organizationId}
                    onValueChange={loadWorkspace}
                  >
                    <SelectTrigger id="consent-workspace" className="w-full">
                      <SelectValue placeholder="Select a workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {workspaces
                          .filter((workspace) => workspace.organizationId === organizationId)
                          .map((workspace) => (
                            <SelectItem key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {organizationId &&
                  !workspaces.some((workspace) => workspace.organizationId === organizationId) ? (
                    <FieldDescription>
                      No workspaces are available in this organization.
                    </FieldDescription>
                  ) : null}
                </Field>
              </FieldGroup>
              {loading ? (
                <div role="status" className="flex flex-col gap-4">
                  <span className="sr-only">Loading workspace resources…</span>
                  {[inference ? "Models" : null, mcp ? "MCP connections" : null]
                    .filter((label) => label !== null)
                    .map((label) => (
                      <div key={label} aria-hidden="true" className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ))}
                </div>
              ) : null}
              {loadError ? (
                <Alert variant="destructive">
                  <AlertDescription>{loadError}</AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || loading}
                    onClick={() => loadWorkspace(workspaceId)}
                  >
                    Try again
                  </Button>
                </Alert>
              ) : null}
              {visibleCatalogs.map(([id, catalog]) => {
                const modelIds = new Set(catalog.models.map((model) => model.id))
                const connections = catalog.mcp.filter((connection) =>
                  mcpKinds.some((kind) => connection[kind].length)
                )
                return (
                  <FieldSet key={id}>
                    {visibleCatalogs.length > 1 || id !== workspaceId ? (
                      <FieldLegend variant="label">
                        Workspace: {workspaces.find((workspace) => workspace.id === id)?.name}
                      </FieldLegend>
                    ) : null}
                    {inference ? (
                      <Field data-disabled={!catalog.models.length || undefined}>
                        <FieldLabel htmlFor={`models-${id}`}>Models</FieldLabel>
                        <MultiSelectDropdown
                          id={`models-${id}`}
                          disabled={pending || loading || !catalog.models.length}
                          className={
                            !catalog.models.length
                              ? "border-2 border-dashed border-border/70"
                              : undefined
                          }
                          placeholder={
                            catalog.models.length ? "Select models" : "No models available"
                          }
                          searchPlaceholder="Search models or providers…"
                          emptyMessage="No matching models."
                          options={catalog.models.map((model) => ({
                            value: model.id,
                            label: model.model_display_name || model.model,
                            description: `${model.model} · Provider ID: ${model.provider}`,
                            badge: model.provider_display_name || model.provider,
                            icon: Cpu,
                          }))}
                          value={selection.models
                            .filter((model) => modelIds.has(model.id))
                            .map((model) => model.id)}
                          onValueChangeAction={(ids) =>
                            setSelection((current) => ({
                              ...current,
                              models: [
                                ...current.models.filter((model) => !modelIds.has(model.id)),
                                ...catalog.models.filter((model) => ids.includes(model.id)),
                              ],
                            }))
                          }
                        />
                      </Field>
                    ) : null}
                    {mcp && !connections.length ? (
                      <Field data-disabled>
                        <FieldLabel htmlFor={`mcp-empty-${id}`}>MCP connections</FieldLabel>
                        <Select disabled>
                          <SelectTrigger
                            id={`mcp-empty-${id}`}
                            className="w-full border-2 border-dashed border-border/70"
                          >
                            <SelectValue placeholder="No MCP connections available" />
                          </SelectTrigger>
                        </Select>
                      </Field>
                    ) : null}
                    {mcp
                      ? connections.map((connection) => (
                          <Field key={connection.id}>
                            <FieldLabel htmlFor={`mcp-${connection.id}`}>
                              <Plug aria-hidden="true" className="size-4 text-muted-foreground" />
                              MCP: {connection.connection}
                            </FieldLabel>
                            <FieldDescription>ID: {connection.id}</FieldDescription>
                            <MultiSelectDropdown
                              id={`mcp-${connection.id}`}
                              disabled={pending || loading}
                              placeholder="Select tools, prompts, and resources"
                              searchPlaceholder="Search tools, prompts, and resources…"
                              emptyMessage="No matching tools, prompts, or resources."
                              options={mcpKinds.flatMap((capability) =>
                                connection[capability].map((name) => ({
                                  value: JSON.stringify([capability, name]),
                                  label: name,
                                  group: capability,
                                  badge: capability,
                                  icon: Plug,
                                }))
                              )}
                              value={mcpKinds.flatMap((capability) =>
                                (
                                  selection.mcp.find((item) => item.id === connection.id)?.[
                                    capability
                                  ] ?? []
                                ).map((name) => JSON.stringify([capability, name]))
                              )}
                              onValueChangeAction={(values) =>
                                setSelection((current) => {
                                  const updated = {
                                    ...connection,
                                    tools: connection.tools.filter((name) =>
                                      values.includes(JSON.stringify(["tools", name]))
                                    ),
                                    prompts: connection.prompts.filter((name) =>
                                      values.includes(JSON.stringify(["prompts", name]))
                                    ),
                                    resources: connection.resources.filter((name) =>
                                      values.includes(JSON.stringify(["resources", name]))
                                    ),
                                  }
                                  const remaining = current.mcp.filter(
                                    (item) => item.id !== connection.id
                                  )
                                  if (mcpKinds.some((kind) => updated[kind].length))
                                    remaining.push(updated)
                                  return { ...current, mcp: remaining }
                                })
                              }
                            />
                          </Field>
                        ))
                      : null}
                  </FieldSet>
                )
              })}
            </>
          )}
          {selectedSummary.some(([count]) => count > 0) ? (
            <p role="status" className="text-sm text-muted-foreground">
              {selectedSummary
                .filter(([count]) => count > 0)
                .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`)
                .join(", ")}{" "}
              selected
            </p>
          ) : null}
        </section>
      ) : null}
      <div className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          You can disconnect this application at any time in{" "}
          <span className="inline-flex items-center gap-1 align-middle">
            Settings <ArrowRight aria-hidden="true" className="size-3" />
            <span className="sr-only">then</span> Connected applications.
          </span>
        </p>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <Button
          variant="outline"
          size="lg"
          disabled={pending || loading}
          onClick={() =>
            startTransition(async () => {
              try {
                const result = await authClient.oauth2.consent({
                  oauth_query: oauthQuery,
                  accept: false,
                })
                if (result.error) {
                  setError(
                    result.error.message || "Authorization could not be declined. Try again."
                  )
                  return
                }
                window.location.assign(result.data.url)
              } catch {
                setError("This request expired. Return to the application and start again.")
              }
            })
          }
        >
          Cancel
        </Button>
        <Button
          size="lg"
          disabled={pending || loading}
          onClick={() =>
            startTransition(async () => {
              setError(undefined)
              try {
                const result = await approveConsentAction(
                  oauthQuery,
                  resourceAccess ? organizationId || null : null,
                  selection
                )
                if ("error" in result) {
                  setError(result.error)
                  return
                }
                const continued = await authClient.oauth2.continue({
                  oauth_query: oauthQuery,
                  postLogin: true,
                })
                if (continued.error) {
                  setError(
                    continued.error.message ||
                      "Authorization could not continue. Start again from the application."
                  )
                  return
                }
                window.location.assign(continued.data.url)
              } catch {
                setError("Authorization could not continue. Check your connection and try again.")
              }
            })
          }
        >
          {pending ? "Connecting…" : "Authorize"}
        </Button>
      </div>
      <p className="text-center text-sm leading-relaxed text-muted-foreground">
        You will be redirected to
        <strong className="block font-bold wrap-anywhere text-foreground">
          {client.callback || "your application"}
        </strong>
      </p>
    </div>
  )
}

export function ResumeAuthorization({
  oauthQuery,
  consent = false,
}: {
  oauthQuery: string
  consent?: boolean
}) {
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    const continuation = consent
      ? authClient.oauth2.consent({ oauth_query: oauthQuery, accept: true })
      : authClient.oauth2.continue({ oauth_query: oauthQuery, selected: true })
    void continuation
      .then((result) => {
        if (!active) return
        if (result.error) {
          setError(
            result.error.message ||
              "This request expired. Return to the application and start again."
          )
          return
        }
        window.location.replace(result.data.url)
      })
      .catch(() => {
        if (active)
          setError("Authorization could not continue. Return to the application and try again.")
      })
    return () => {
      active = false
    }
  }, [oauthQuery, consent])
  return (
    <AuthorizationState
      title={error ? "We couldn't connect this app" : "Connecting to your app"}
      description={error ?? "Finishing authorization. You'll be redirected shortly."}
      pending={!error}
    />
  )
}
