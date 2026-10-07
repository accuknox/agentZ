"use client"

import { useEffect, useState, useTransition } from "react"
import { createAuthClient } from "better-auth/react"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { ArrowRight, Check, Layers3, LockKeyhole, ShieldCheck, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import type { DelegationCatalog, DelegationMcp } from "@/lib/gateway/client"
import { approveConsentAction, delegationWorkspaceAction } from "./actions"

// Only the current continuation may navigate. Automatic redirects would also
// send discarded effect responses to the callback.
const authClient = createAuthClient({
  disableDefaultFetchPlugins: true,
  plugins: [oauthProviderClient()],
})

const identityScopes = [
  { value: "openid", label: "Sign you in with your AgentZ identity" },
  { value: "profile", label: "Read your name and profile image" },
  { value: "email", label: "Read your email address and verification status" },
  { value: "offline_access", label: "Keep access when you are away, until you disconnect" },
]

type ConsentProps = {
  oauthQuery: string
  client: { name: string; owner: string | null; callback: string }
  user: { name: string; email: string }
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
  const selectedCount =
    selection.models.length +
    selection.mcp.reduce(
      (count, connection) =>
        count + connection.tools.length + connection.prompts.length + connection.resources.length,
      0
    )

  function selectMCP(
    connection: DelegationMcp,
    capability: "tools" | "prompts" | "resources",
    name: string,
    checked: boolean
  ) {
    setSelection((current) => {
      const selected = current.mcp.find((item) => item.id === connection.id) ?? {
        ...connection,
        tools: [],
        prompts: [],
        resources: [],
      }
      const updated = {
        ...selected,
        [capability]: checked
          ? [...selected[capability], name]
          : selected[capability].filter((value) => value !== name),
      }
      const remaining = current.mcp.filter((item) => item.id !== connection.id)
      if (updated.tools.length || updated.prompts.length || updated.resources.length)
        remaining.push(updated)
      return { ...current, mcp: remaining }
    })
  }

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/5 text-primary">
          <LockKeyhole aria-hidden="true" className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect to {client.name}</h1>
        <p className="text-sm text-muted-foreground">
          {client.owner ? `${client.owner}'s application` : "This application"} wants to connect to
          your AgentZ account.
        </p>
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">{user.name}</span>
          <span className="ml-2 break-all text-muted-foreground">{user.email}</span>
        </div>
      </header>
      <section aria-label="Requested account access" className="space-y-3">
        <h2 className="text-sm font-semibold">Account access</h2>
        {identityScopes
          .filter((scope) => scopes.includes(scope.value))
          .map((scope) => (
            <div key={scope.value} className="flex items-start gap-2 text-sm">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{scope.label}</span>
            </div>
          ))}
      </section>
      {resourceAccess ? (
        <section className="space-y-4 rounded-xl border p-4 sm:p-5">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 font-semibold">
              <Layers3 aria-hidden="true" className="size-4" />
              Choose resource access
            </h2>
            <p className="text-sm text-muted-foreground">
              Only the capabilities you select below will be available to {client.name}. Usage is
              charged to the resource owner.
            </p>
          </div>
          {organizations.length === 0 ? (
            <Alert>
              <AlertDescription>
                No organization currently allows delegation for your account. Ask an organization
                administrator to enable it.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="consent-organization">Organization</Label>
                <Select
                  value={organizationId}
                  disabled={pending}
                  onValueChange={(value) => {
                    setOrganizationId(value)
                    setWorkspaceId("")
                    setCatalogs({})
                    setSelection({ models: [], mcp: [] })
                    setError(undefined)
                  }}
                >
                  <SelectTrigger id="consent-organization" className="w-full">
                    <SelectValue placeholder="Select an organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((organization) => (
                      <SelectItem key={organization.id} value={organization.id}>
                        {organization.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {organizationId ? (
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor="consent-workspace">Workspace</Label>
                    <Select value={workspaceId} disabled={pending} onValueChange={setWorkspaceId}>
                      <SelectTrigger id="consent-workspace" className="w-full">
                        <SelectValue placeholder="Select a workspace" />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces
                          .filter((workspace) => workspace.organizationId === organizationId)
                          .map((workspace) => (
                            <SelectItem key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    disabled={pending || !workspaceId}
                    onClick={() =>
                      startTransition(async () => {
                        setError(undefined)
                        try {
                          const catalog = await delegationWorkspaceAction(
                            oauthQuery,
                            organizationId,
                            workspaceId
                          )
                          setCatalogs((current) => ({ ...current, [workspaceId]: catalog }))
                        } catch (error) {
                          setError(
                            error instanceof Error
                              ? error.message
                              : "Capabilities could not be loaded."
                          )
                        }
                      })
                    }
                  >
                    Browse
                  </Button>
                </div>
              ) : null}
              {Object.entries(catalogs).map(([id, catalog]) => (
                <div key={id} className="space-y-4 border-t pt-4">
                  <h3 className="text-sm font-semibold">
                    {workspaces.find((workspace) => workspace.id === id)?.name}
                  </h3>
                  {(!inference || !catalog.models.length) && (!mcp || !catalog.mcp.length) ? (
                    <p className="text-sm text-muted-foreground">
                      No capabilities are available for delegation in this workspace. You need both
                      Use and Delegate permissions.
                    </p>
                  ) : null}
                  {inference && catalog.models.length ? (
                    <fieldset className="space-y-2">
                      <legend className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                        Models
                      </legend>
                      {catalog.models.map((model) => (
                        <label
                          key={model.id}
                          className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                        >
                          <Checkbox
                            className="mt-0.5"
                            disabled={pending}
                            checked={selection.models.some((selected) => selected.id === model.id)}
                            onCheckedChange={(checked) =>
                              setSelection((current) => ({
                                ...current,
                                models:
                                  checked === true
                                    ? [...current.models, model]
                                    : current.models.filter((selected) => selected.id !== model.id),
                              }))
                            }
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium break-all">
                              {model.model}
                            </span>
                            <span className="text-xs text-muted-foreground">{model.provider}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  {mcp
                    ? catalog.mcp.map((connection) => (
                        <details key={connection.id} className="rounded-md border" open>
                          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                            {connection.connection}{" "}
                            <span className="font-normal text-muted-foreground">MCP</span>
                          </summary>
                          <div className="space-y-4 border-t p-3">
                            {(["tools", "prompts", "resources"] as const).map((capability) =>
                              connection[capability].length ? (
                                <fieldset key={capability} className="space-y-2">
                                  <legend className="mb-2 text-xs text-muted-foreground capitalize">
                                    {capability}
                                  </legend>
                                  {connection[capability].map((name) => (
                                    <label
                                      key={name}
                                      className="flex cursor-pointer items-start gap-3 text-sm"
                                    >
                                      <Checkbox
                                        className="mt-0.5"
                                        disabled={pending}
                                        checked={
                                          selection.mcp
                                            .find((selected) => selected.id === connection.id)
                                            ?.[capability].includes(name) ?? false
                                        }
                                        onCheckedChange={(checked) =>
                                          selectMCP(connection, capability, name, checked === true)
                                        }
                                      />
                                      <span className="min-w-0 break-all">{name}</span>
                                    </label>
                                  ))}
                                </fieldset>
                              ) : null
                            )}
                          </div>
                        </details>
                      ))
                    : null}
                </div>
              ))}
            </>
          )}
          {selectedCount > 0 ? (
            <div className="space-y-2 rounded-lg bg-muted/30 p-3">
              <p className="text-sm font-medium">
                {selectedCount} selected {selectedCount === 1 ? "capability" : "capabilities"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {selection.models.map((model) => (
                  <Badge key={model.id} variant="outline">
                    {model.model}
                  </Badge>
                ))}
                {selection.mcp.map((connection) => (
                  <Badge key={connection.id} variant="outline">
                    {connection.connection} ·{" "}
                    {connection.tools.length +
                      connection.prompts.length +
                      connection.resources.length}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>You can disconnect this application at any time in Settings → Connected applications.</p>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-t pt-5">
        <Button
          variant="outline"
          disabled={pending}
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
          <Unplug aria-hidden="true" />
          Deny
        </Button>
        <Button
          disabled={
            pending ||
            (resourceAccess &&
              (!organizationId ||
                (inference && !selection.models.length) ||
                (mcp && !selection.mcp.length)))
          }
          onClick={() =>
            startTransition(async () => {
              setError(undefined)
              try {
                const result = await approveConsentAction(
                  oauthQuery,
                  resourceAccess ? organizationId : null,
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
          {pending ? "Connecting…" : "Allow access"}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <p className="text-center text-xs break-all text-muted-foreground">
        You’ll return to {client.callback || "your application"}.
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
    <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
      {error ?? "Continuing authorization…"}
    </p>
  )
}
