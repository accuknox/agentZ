"use client"

import type { Route } from "next"
import Link from "next/link"
import { Fragment, startTransition, useActionState, useMemo, useState } from "react"
import {
  Building2,
  CircleAlert,
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  X,
} from "lucide-react"
import {
  organizationRoleFormAction,
  type RoleFormState,
  workspaceRoleFormAction,
} from "@/app/(scoped)/orgs/actions"
import { AdministrationPageHeader, ImpactReviewFrame } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import type {
  RoleAction,
  RoleDependency,
  RoleEditorData,
  RoleGrantInput,
  RoleResource,
  WorkspaceRoleEditorData,
} from "@/data/roles"

const resourceDescriptions: Partial<Record<RoleResource, string>> = {
  inference_pool: "Use and manage the inference pools available in this workspace.",
  inference_provider: "View and manage configured inference providers.",
  mcp_connection: "View and manage connections to MCP servers.",
  observability: "View runtime telemetry and observability data in Lens.",
  sandbox: "View and manage isolated environments used by agents.",
  skill: "View and manage the immutable skills available to agents.",
}

const capabilityDescriptions: Partial<Record<RoleAction, string>> = {
  author: "Create and edit agents in this workspace.",
  delete_shared_secret: "Delete secrets shared with agents.",
  read_shared_secret: "Read secrets shared with agents.",
  share_authored: "Share agents created by the role holder.",
  share_non_authored: "Share agents created by other workspace members.",
  use_shared: "Run agents shared by other workspace members.",
  write_shared_secret: "Create and update secrets shared with agents.",
}

function accessLabel(action: RoleAction) {
  if (action === "read") {
    return "Read-only"
  }
  if (action === "create") {
    return "Read and create"
  }
  if (action === "modify") {
    return "Read, create, and modify"
  }
  if (action === "delete") {
    return "Full access"
  }
  return action.replaceAll("_", " ")
}

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
  const pending = [...direct]

  for (const grant of pending) {
    const rules = grant.workspaceId ? dependencies.workspace : dependencies.organisation
    const rule = rules.find(
      (candidate) => candidate.resource === grant.resource && candidate.action === grant.action
    )
    for (const requirement of rule?.requires ?? []) {
      const required = { ...requirement, workspaceId: grant.workspaceId }
      const requiredKey = key(required)
      if (!selected.has(requiredKey)) {
        selected.set(requiredKey, required)
        pending.push(required)
      }
    }
  }

  return new Set(selected.keys())
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
  const [dismissedPreview, setDismissedPreview] = useState<RoleFormState["preview"]>()
  const selected = useMemo(
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
  const impactOpen = Boolean(
    role && previewValid && state.preview && state.preview !== dismissedPreview
  )
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
  const agentCapabilities = workspaceId ? data.catalog.agentCapabilities : []
  const resourceSelected = (resource: RoleResource) =>
    availableResources
      .find((candidate) => candidate.resource === resource)
      ?.actions.some((actionName) =>
        selected.has(key({ workspaceId, resource, action: actionName }))
      ) ?? false
  const capabilitySelected = (actionName: RoleAction) =>
    selected.has(key({ workspaceId, resource: "agent", action: actionName }))
  const selectedResources = availableResources.filter((resource) =>
    resourceSelected(resource.resource)
  )
  const selectedCapabilities = agentCapabilities.filter((capability) =>
    capabilitySelected(capability.action)
  )
  const selectedCount = selectedResources.length + selectedCapabilities.length

  const hasDirect = (resource: RoleResource, actionName?: RoleAction) =>
    direct.some(
      (grant) =>
        grant.workspaceId === workspaceId &&
        grant.resource === resource &&
        (!actionName || grant.action === actionName)
    )
  const setResourceAccess = (resource: RoleResource, actionName: RoleAction) => {
    setDirect((current) => [
      ...current.filter(
        (grant) => grant.workspaceId !== workspaceId || grant.resource !== resource
      ),
      { workspaceId, resource, action: actionName },
    ])
  }
  const togglePermission = (
    resource: RoleResource,
    actionName: RoleAction | undefined,
    enabled: boolean
  ) => {
    setDirect((current) => {
      if (enabled) {
        if (!actionName) {
          return current
        }
        const grant = { workspaceId, resource, action: actionName }
        return current.some((value) => sameGrant(value, grant)) ? current : [...current, grant]
      }
      return current.filter(
        (grant) =>
          grant.workspaceId !== workspaceId ||
          grant.resource !== resource ||
          (resource === "agent" && grant.action !== actionName)
      )
    })
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-6"
      id="role-form"
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

      {!role ? (
        <AdministrationPageHeader
          title={`Create ${workspace ? "workspace" : "organization"} role`}
        />
      ) : null}
      <div className="flex w-full flex-col gap-6 px-4 md:px-6">
        <FieldGroup className={workspace ? "max-w-2xl" : "md:grid md:grid-cols-2"}>
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
          {!workspace ? (
            <Field>
              <FieldLabel htmlFor="permission-scope">Permission scope</FieldLabel>
              <Select onValueChange={setActiveScope} value={activeScope}>
                <SelectTrigger className="w-full" id="permission-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {scopes.map((scope) => (
                      <SelectItem key={scope.id} value={scope.id}>
                        <Building2 />
                        {scope.label} · {scope.detail}
                        {dirtyScopes.has(scope.id) ? " · Unsaved changes" : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </FieldGroup>
        {!workspace && role?.systemRole === "superadmin" ? (
          <Alert className="-mx-4 w-[calc(100%+2rem)] max-w-none rounded-none border-x-0 md:-mx-6 md:w-[calc(100%+3rem)]">
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>Full Organisation authorization bypass</AlertTitle>
            <AlertDescription>
              Superadmin includes every current and future Organisation and Workspace capability.
            </AlertDescription>
          </Alert>
        ) : null}
        {workspace && role?.systemRole === "workspace_admin" ? (
          <Alert className="-mx-4 w-[calc(100%+2rem)] max-w-none rounded-none border-x-0 md:-mx-6 md:w-[calc(100%+3rem)]">
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

        <Card className="gap-0 py-0">
          <CardHeader className="bg-muted/20 border-b py-3">
            <CardTitle>
              <h2 className="flex items-center gap-2">
                Permissions
                <Badge variant="secondary">{selectedCount}</Badge>
              </h2>
            </CardTitle>
            {!immutable ? (
              <CardAction>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline">
                      <Plus data-icon="inline-start" />
                      Add permissions
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 p-0 sm:w-96">
                    <Command>
                      <CommandInput placeholder="Search permissions..." />
                      <CommandList>
                        <CommandEmpty>No permissions found.</CommandEmpty>
                        <CommandGroup heading="Resources">
                          {availableResources.map((resource) => {
                            const active = resourceSelected(resource.resource)
                            const editable = hasDirect(resource.resource)
                            return (
                              <CommandItem
                                data-checked={active}
                                disabled={active && !editable}
                                key={resource.resource}
                                keywords={[resourceDescriptions[resource.resource] ?? ""]}
                                onSelect={() =>
                                  togglePermission(resource.resource, resource.actions[0], !active)
                                }
                                value={resource.label}
                              >
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span>{resource.label}</span>
                                  <span className="text-muted-foreground truncate text-xs">
                                    {resourceDescriptions[resource.resource]}
                                  </span>
                                </span>
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                        {agentCapabilities.length ? (
                          <CommandGroup heading="Agent capabilities">
                            {agentCapabilities.map((capability) => {
                              const active = capabilitySelected(capability.action)
                              const editable = hasDirect("agent", capability.action)
                              return (
                                <CommandItem
                                  data-checked={active}
                                  disabled={active && !editable}
                                  key={capability.action}
                                  keywords={[capabilityDescriptions[capability.action] ?? ""]}
                                  onSelect={() =>
                                    togglePermission("agent", capability.action, !active)
                                  }
                                  value={capability.label}
                                >
                                  <span className="flex min-w-0 flex-col gap-0.5">
                                    <span>{capability.label}</span>
                                    <span className="text-muted-foreground truncate text-xs">
                                      {capabilityDescriptions[capability.action]}
                                    </span>
                                  </span>
                                </CommandItem>
                              )
                            })}
                          </CommandGroup>
                        ) : null}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col px-0">
            {selectedCount === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
                <p className="font-medium">No permissions selected</p>
                <p className="text-muted-foreground max-w-md text-sm">
                  Add the smallest set of permissions this role needs. Required dependencies are
                  included automatically.
                </p>
              </div>
            ) : null}
            {selectedResources.map((resource, index) => {
              const currentAction = resource.actions.findLast((actionName) =>
                selected.has(key({ workspaceId, resource: resource.resource, action: actionName }))
              )
              const required = !hasDirect(resource.resource)
              return (
                <Fragment key={resource.resource}>
                  {index ? <Separator /> : null}
                  <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{resource.label}</p>
                        {required ? (
                          <Badge variant="outline">
                            <LockKeyhole data-icon="inline-start" />
                            Required
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-sm">
                        {resourceDescriptions[resource.resource]}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        disabled={immutable}
                        onValueChange={(value) => {
                          const actionName = resource.actions.find(
                            (candidate) => candidate === value
                          )
                          if (actionName) {
                            setResourceAccess(resource.resource, actionName)
                          }
                        }}
                        value={currentAction}
                      >
                        <SelectTrigger
                          aria-label={`${resource.label} access`}
                          className="w-52 max-w-[calc(100vw-6.5rem)]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {resource.actions.map((actionName) => (
                              <SelectItem key={actionName} value={actionName}>
                                <KeyRound />
                                {accessLabel(actionName)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {!immutable ? (
                        <Button
                          aria-label={`Remove ${resource.label}`}
                          disabled={!hasDirect(resource.resource)}
                          onClick={() =>
                            togglePermission(resource.resource, resource.actions[0], false)
                          }
                          size="icon"
                          title={
                            hasDirect(resource.resource)
                              ? `Remove ${resource.label}`
                              : "Required by another permission"
                          }
                          type="button"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </Fragment>
              )
            })}
            {selectedCapabilities.map((capability, index) => {
              const required = !hasDirect("agent", capability.action)
              return (
                <Fragment key={capability.action}>
                  {selectedResources.length || index ? <Separator /> : null}
                  <div className="flex items-center gap-4 px-4 py-4">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{capability.label}</p>
                        {required ? (
                          <Badge variant="outline">
                            <LockKeyhole data-icon="inline-start" />
                            Required
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-sm">
                        {capabilityDescriptions[capability.action]}
                      </p>
                    </div>
                    <Badge variant="secondary">Granted</Badge>
                    {!immutable ? (
                      <Button
                        aria-label={`Remove ${capability.label}`}
                        disabled={!hasDirect("agent", capability.action)}
                        onClick={() => togglePermission("agent", capability.action, false)}
                        size="icon"
                        title={
                          hasDirect("agent", capability.action)
                            ? `Remove ${capability.label}`
                            : "Required by another permission"
                        }
                        type="button"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    ) : null}
                  </div>
                </Fragment>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {role && previewValid && state.preview ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setDismissedPreview(state.preview)
            }
          }}
          open={impactOpen}
        >
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Confirm role update</DialogTitle>
              <DialogDescription>
                Review the access impact before updating {role.name}.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[min(60dvh,36rem)] overflow-y-auto py-2">
              <ImpactReviewFrame
                description={
                  state.preview.reduction
                    ? "Review every removed capability before saving. Other direct Roles may preserve effective access."
                    : "This change does not remove a currently stored capability."
                }
                items={state.preview.items}
                title="Access impact"
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button disabled={pending} type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                data-dialog-submit
                disabled={pending}
                form="role-form"
                name="intent"
                type="submit"
                value="save"
              >
                {pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Confirm update
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <footer className="bg-background/95 sticky bottom-0 z-20 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 backdrop-blur md:px-6">
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
          <Button
            disabled={pending || changed === 0}
            name="intent"
            type="submit"
            value={role ? "preview" : "save"}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            {role ? "Update" : "Create"}
          </Button>
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
  return selected
}
