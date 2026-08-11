"use client"

import type { Route } from "next"
import Link from "next/link"
import { startTransition, useActionState, useMemo, useState } from "react"
import { CircleAlert, ShieldCheck } from "lucide-react"
import {
  organizationRoleFormAction,
  type RoleFormState,
  workspaceRoleFormAction,
} from "@/app/(scoped)/orgs/actions"
import {
  ImpactReviewFrame,
  PermissionMatrixFrame,
  ScopeBadge,
  type PermissionMatrixRow,
} from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type {
  RoleAction,
  RoleDependency,
  RoleEditorData,
  RoleGrantInput,
  RoleResource,
  WorkspaceRoleEditorData,
} from "@/data/roles"
import { cn } from "@/lib/utils"

const actionColumns = [
  { id: "read", label: "Read" },
  { id: "create", label: "Create" },
  { id: "modify", label: "Modify" },
  { id: "delete", label: "Delete" },
] as const

function key(grant: RoleGrantInput) {
  return `${grant.workspaceId ?? "organisation"}\u001f${grant.resource}\u001f${grant.action}`
}

function sameGrant(left: RoleGrantInput, right: RoleGrantInput) {
  return (
    left.workspaceId === right.workspaceId &&
    left.resource === right.resource &&
    left.action === right.action
  )
}

function expand(
  direct: RoleGrantInput[],
  dependencies: { organisation: RoleDependency[]; workspace: RoleDependency[] }
) {
  const selected = new Map(direct.map((grant) => [key(grant), grant]))
  const locked = new Set<string>()
  const pending = [...direct]

  for (const grant of pending) {
    const rules = grant.workspaceId ? dependencies.workspace : dependencies.organisation
    const rule = rules.find(
      (candidate) => candidate.resource === grant.resource && candidate.action === grant.action
    )
    for (const requirement of rule?.requires ?? []) {
      const required = { ...requirement, workspaceId: grant.workspaceId }
      const requiredKey = key(required)
      locked.add(requiredKey)
      if (!selected.has(requiredKey)) {
        selected.set(requiredKey, required)
        pending.push(required)
      }
    }
  }

  return { locked, selected: new Set(selected.keys()) }
}

export function RoleEditor({ data }: { data: RoleEditorData | WorkspaceRoleEditorData }) {
  const role = data.role
  const workspace = "workspace" in data ? data.workspace : undefined
  const immutable = Boolean(role?.immutable)
  const baseline = useMemo(
    () =>
      role?.grants
        .filter((grant) => !grant.locked)
        .map(({ workspaceId, resource, action }) => ({ workspaceId, resource, action })) ?? [],
    [role?.grants]
  )
  const [name, setName] = useState(role?.name ?? "")
  const [direct, setDirect] = useState(baseline)
  const [activeScope, setActiveScope] = useState(workspace?.id ?? "organisation")
  const { locked, selected } = useMemo(
    () =>
      immutable
        ? builtinSelection(data, activeScope)
        : expand(direct, {
            organisation: data.catalog.organisationDependencies,
            workspace: data.catalog.workspaceDependencies,
          }),
    [activeScope, data, direct, immutable]
  )
  const directGrants = [...direct].sort((left, right) => key(left).localeCompare(key(right)))
  const updatedAt = role?.updatedAt
  const previewInput = JSON.stringify({ name, grants: directGrants, updatedAt })
  const action = workspace
    ? workspaceRoleFormAction.bind(null, data.organization.slug, workspace.slug, role?.id)
    : organizationRoleFormAction.bind(null, data.organization.slug, role?.id)
  const [state, formAction, pending] = useActionState<RoleFormState, FormData>(action, {})
  const previewValid = state.preview?.input === previewInput
  const scopes = workspace
    ? [{ id: workspace.id, label: workspace.name, detail: "Workspace" }]
    : [
        { id: "organisation", label: data.organization.name, detail: "Organisation" },
        ...data.workspaces.map((item) => ({
          id: item.id,
          label: item.name,
          detail: "Workspace",
        })),
      ]
  const dirtyScopes = new Set(
    scopes
      .filter((scope) => {
        const scopeId = scope.id === "organisation" ? null : scope.id
        const current = new Set(direct.filter((grant) => grant.workspaceId === scopeId).map(key))
        const original = new Set(baseline.filter((grant) => grant.workspaceId === scopeId).map(key))
        return current.size !== original.size || [...current].some((value) => !original.has(value))
      })
      .map((scope) => scope.id)
  )
  if (name !== (role?.name ?? "")) {
    dirtyScopes.add(workspace?.id ?? "organisation")
  }
  const changed =
    direct.filter((grant) => !baseline.some((value) => sameGrant(value, grant))).length +
    baseline.filter((grant) => !direct.some((value) => sameGrant(value, grant))).length +
    (name !== (role?.name ?? "") ? 1 : 0)
  const workspaceId = activeScope === "organisation" ? null : activeScope
  const availableResources = data.catalog.resources.filter((resource) =>
    workspaceId ? resource.workspace : resource.organisation
  )

  const checkbox = (resource: RoleResource, actionName: RoleAction, label: string) => {
    const grant = { workspaceId, resource, action: actionName }
    const grantKey = key(grant)
    const required = locked.has(grantKey)
    return (
      <span
        className="inline-flex items-center justify-center"
        title={required ? "Required by another selected capability" : undefined}
      >
        <Checkbox
          aria-label={`${label}: ${actionName.replaceAll("_", " ")}`}
          checked={selected.has(grantKey)}
          disabled={immutable || required}
          onCheckedChange={(checked) => {
            setDirect((current) => {
              const next = [...current]
              if (checked) {
                if (!next.some((value) => sameGrant(value, grant))) {
                  next.push(grant)
                }
                return next
              }
              return next.filter((value) => !sameGrant(value, grant))
            })
          }}
        />
      </span>
    )
  }
  const rows: PermissionMatrixRow[] = availableResources.map((resource) => ({
    id: resource.resource,
    label: resource.label,
    values: Object.fromEntries(
      actionColumns.map(({ id }) => [
        id,
        resource.actions.includes(id) ? (
          checkbox(resource.resource, id, resource.label)
        ) : (
          <span aria-label="Not available">—</span>
        ),
      ])
    ),
  }))
  const agentRows: PermissionMatrixRow[] = data.catalog.agentCapabilities.map((capability) => ({
    id: capability.action,
    label: capability.label,
    values: { granted: checkbox("agent", capability.action, capability.label) },
  }))

  return (
    <form
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        const submitter = (event.nativeEvent as SubmitEvent).submitter
        startTransition(() => formAction(new FormData(event.currentTarget, submitter)))
      }}
    >
      <input name="grants" type="hidden" value={JSON.stringify(directGrants)} />
      {updatedAt ? <input name="updated_at" type="hidden" value={updatedAt} /> : null}
      <input
        name="preview_fingerprint"
        type="hidden"
        value={previewValid ? state.preview?.fingerprint : ""}
      />

      <Card>
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ScopeBadge scope={workspace ? "Workspace" : "Organisation"} />
            <Badge variant={immutable ? "secondary" : "outline"}>
              {immutable ? "System" : "Custom"}
            </Badge>
            {immutable ? <Badge variant="outline">Immutable</Badge> : null}
          </div>
          <CardTitle>
            <h2>{role ? role.name : `Create ${workspace ? "Workspace" : "Organisation"} Role`}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Field data-invalid={Boolean(state.errors?.name)}>
            <FieldLabel htmlFor="role-name" required>
              Role name
            </FieldLabel>
            <Input
              aria-invalid={Boolean(state.errors?.name)}
              disabled={immutable}
              id="role-name"
              maxLength={80}
              name="name"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
            <FieldError>{state.errors?.name?.[0]}</FieldError>
          </Field>
        </CardContent>
      </Card>

      {!workspace && role?.systemRole === "superadmin" ? (
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>Full Organisation authorization bypass</AlertTitle>
          <AlertDescription>
            Superadmin includes every current and future Organisation and Workspace capability.
          </AlertDescription>
        </Alert>
      ) : null}
      {workspace && role?.systemRole === "workspace_admin" ? (
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>Full Workspace authorization</AlertTitle>
          <AlertDescription>
            Workspace Admin includes every current and future capability in {workspace.name}. Its
            permissions are immutable; only a Superadmin can change assignments.
          </AlertDescription>
        </Alert>
      ) : null}
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Role not saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className={cn("grid min-w-0 gap-5", !workspace && "lg:grid-cols-[15rem_minmax(0,1fr)]")}>
        {!workspace ? (
          <aside aria-label="Permission scopes" className="hidden lg:block">
            <div className="sticky top-4 overflow-hidden rounded-lg border">
              {scopes.map((scope) => (
                <button
                  className={cn(
                    "hover:bg-muted/60 focus-visible:ring-ring flex w-full items-start gap-2 border-b px-3 py-3 text-left text-sm outline-none last:border-b-0 focus-visible:ring-2",
                    activeScope === scope.id && "bg-muted"
                  )}
                  key={scope.id}
                  onClick={() => setActiveScope(scope.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{scope.label}</span>
                    <span className="text-muted-foreground text-xs">{scope.detail}</span>
                  </span>
                  {dirtyScopes.has(scope.id) ? (
                    <Badge aria-label="Unsaved changes" variant="pending">
                      Dirty
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
          </aside>
        ) : null}

        <div className="flex min-w-0 flex-col gap-5">
          {!workspace ? (
            <div className="lg:hidden">
              <Select onValueChange={setActiveScope} value={activeScope}>
                <SelectTrigger className="w-full" aria-label="Permission scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((scope) => (
                    <SelectItem key={scope.id} value={scope.id}>
                      {scope.label} · {scope.detail}
                      {dirtyScopes.has(scope.id) ? " · Dirty" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <PermissionMatrixFrame
            caption={`Resource actions granted in ${scopes.find((scope) => scope.id === activeScope)?.label}.`}
            columns={actionColumns}
            rows={rows}
          />
          {workspaceId ? (
            <PermissionMatrixFrame
              caption="Agent capabilities are independent of ordinary resource actions."
              columns={[{ id: "granted", label: "Granted" }]}
              rows={agentRows}
              title="Agent capabilities"
            />
          ) : null}
        </div>
      </div>

      {previewValid && state.preview ? (
        <ImpactReviewFrame
          description={
            state.preview.reduction
              ? "Review every removed capability before saving. Other direct Roles may preserve effective access."
              : "This change does not remove a currently stored capability."
          }
          items={state.preview.items}
          title="Access impact"
        />
      ) : null}

      <footer className="bg-background/95 sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <span className="text-muted-foreground mr-auto text-sm tabular-nums">
          {immutable ? "Read-only built-in Role" : `${changed} unsaved changes`}
        </span>
        <Button asChild variant="outline">
          <Link
            href={
              (workspace
                ? `/orgs/${data.organization.slug}/workspaces/${workspace.slug}/roles`
                : `/orgs/${data.organization.slug}/roles`) as Route
            }
          >
            {immutable ? "Back" : "Cancel"}
          </Link>
        </Button>
        {!immutable ? (
          <>
            <Button
              disabled={pending}
              name="intent"
              type="submit"
              value="preview"
              variant="outline"
            >
              {pending ? <Spinner /> : null}
              Review impact
            </Button>
            <Button disabled={pending || changed === 0} name="intent" type="submit" value="save">
              {pending ? <Spinner /> : null}
              Save Role
            </Button>
          </>
        ) : null}
      </footer>
    </form>
  )
}

function builtinSelection(data: RoleEditorData, activeScope: string) {
  const workspaceId = activeScope === "organisation" ? null : activeScope
  const selected = new Set<string>()
  for (const resource of data.catalog.resources) {
    if (workspaceId ? !resource.workspace : !resource.organisation) {
      continue
    }
    for (const action of resource.actions) {
      selected.add(key({ workspaceId, resource: resource.resource, action }))
    }
  }
  if (workspaceId) {
    for (const { action } of data.catalog.agentCapabilities) {
      selected.add(key({ workspaceId, resource: "agent", action }))
    }
  }
  return { locked: new Set(selected), selected }
}
