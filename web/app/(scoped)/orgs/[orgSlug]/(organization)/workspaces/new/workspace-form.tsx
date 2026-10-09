"use client"

import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { startTransition, useActionState, useState } from "react"
import { Box, CircleAlert, Code2, Layers, Plus, Wrench } from "lucide-react"
import { ProviderIcon } from "@/app/(app)/inference/providers/provider-shared"
import { renderMcpServerIcon } from "@/app/(app)/mcps/catalog"
import { createWorkspaceAction, type CreateWorkspaceFormState } from "@/app/(scoped)/orgs/actions"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import type {
  InferenceProvider,
  McpConnectionSummary,
  SelectedOrganizationResources,
  WorkspaceMemberCandidate,
} from "@/lib/gateway/client"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"
import { workspaceNameSchema } from "@/data/schema"
import { toast } from "sonner"

type WorkspaceCreationResources = {
  skills: SelectedOrganizationResources["skills"]
  sandboxes: SelectedOrganizationResources["sandboxes"]
  mcp_connections: Pick<McpConnectionSummary, "endpoint_url" | "name">[]
  inference_providers: Pick<InferenceProvider, "catalog_provider" | "display_name" | "id">[]
}

export function WorkspaceForm({
  candidates,
  orgSlug,
  resources,
}: {
  candidates: WorkspaceMemberCandidate[]
  orgSlug: string
  resources: WorkspaceCreationResources
}) {
  const router = useRouter()
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const form = useForm<z.infer<typeof zCreateWorkspaceRequest>>({
    resolver: zodResolver(
      zCreateWorkspaceRequest.extend({
        name: workspaceNameSchema.pipe(zCreateWorkspaceRequest.shape.name),
      })
    ),
    defaultValues: {
      name: "",
      type: "general",
      admin_member_ids: [],
      selected_organization_resources: {
        skills: [],
        sandboxes: [],
        mcp_connections: [],
        inference_providers: [],
      },
    },
  })
  const [name, workspaceType, admins, inherited] = useWatch({
    control: form.control,
    name: ["name", "type", "admin_member_ids", "selected_organization_resources"],
  })
  const [state, formAction, pending] = useActionState<CreateWorkspaceFormState, FormData>(
    async (state, formData) => {
      const result = await createWorkspaceAction(orgSlug, state, formData)
      if (result.href) {
        toast.success("Workspace created")
        router.push(result.href)
      }
      return result
    },
    {}
  )

  const adminOptions = candidates.map((candidate) => ({
    image: candidate.image,
    initials: (candidate.name || candidate.email).slice(0, 1).toUpperCase(),
    label: candidate.name ? `${candidate.name} (${candidate.email})` : candidate.email,
    value: candidate.member_id,
  }))
  const resourceOptions = {
    skills: resources.skills.map((name) => ({ icon: Wrench, label: name, value: name })),
    sandboxes: resources.sandboxes.map((name) => ({ icon: Box, label: name, value: name })),
    mcp_connections: resources.mcp_connections.map(({ endpoint_url, name }) => ({
      iconElement: renderMcpServerIcon(endpoint_url, {
        "aria-hidden": "true",
        className: "size-4 shrink-0",
      }),
      label: name,
      value: name,
    })),
    inference_providers: resources.inference_providers.map(
      ({ catalog_provider, display_name, id }) => ({
        iconElement: <ProviderIcon className="size-4 shrink-0" provider={catalog_provider} />,
        label: `${display_name} (${id})`,
        value: id,
      })
    ),
  } satisfies Record<keyof SelectedOrganizationResources, MultiSelectDropdownOption[]>
  const errors = state.errors

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Create Workspace" />
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => {
          if (!confirmationOpen) {
            setConfirmationOpen(true)
            return
          }
          const formData = new FormData()
          formData.set("name", values.name)
          formData.set("type", values.type ?? "general")
          for (const id of values.admin_member_ids) formData.append("admin_member_ids", id)
          for (const { field, key } of inheritanceCategories)
            for (const name of values.selected_organization_resources[key])
              formData.append(field, name)
          startTransition(() => formAction(formData))
        })}
        className="flex max-w-2xl flex-col gap-6 px-4 pb-6 md:px-6"
        id="workspace-form"
      >
        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Workspace could not be created</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <Controller
            name="type"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="workspace-type">Workspace type</FieldLabel>
                <Select
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={pending}
                >
                  <SelectTrigger
                    ref={field.ref}
                    onBlur={field.onBlur}
                    id="workspace-type"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="general">
                        <Layers aria-hidden="true" />
                        General purpose
                      </SelectItem>
                      <SelectItem value="coding">
                        <Code2 aria-hidden="true" />
                        Coding
                        <Badge variant="secondary">Preview</Badge>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Coding adds GitHub projects and Git worktrees. The type cannot be changed later.
                </FieldDescription>
              </Field>
            )}
          />
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || Boolean(errors?.name)}>
                <FieldLabel htmlFor="workspace-name" required>
                  Name
                </FieldLabel>
                <Input
                  {...field}
                  id="workspace-name"
                  required
                  autoComplete="off"
                  maxLength={80}
                  disabled={pending}
                  placeholder="e.g. Research lab"
                  aria-invalid={fieldState.invalid || Boolean(errors?.name)}
                  aria-describedby="workspace-name-error"
                />
                <FieldError id="workspace-name-error" errors={[fieldState.error]}>
                  {errors?.name?.[0]}
                </FieldError>
              </Field>
            )}
          />
          <Controller
            name="admin_member_ids"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || Boolean(errors?.admin_member_ids)}>
                <FieldLabel htmlFor="workspace-admins">Initial administrators</FieldLabel>
                <MultiSelectDropdown
                  ref={field.ref}
                  onBlurAction={field.onBlur}
                  id="workspace-admins"
                  disabled={pending}
                  invalid={fieldState.invalid || Boolean(errors?.admin_member_ids)}
                  onValueChangeAction={field.onChange}
                  options={adminOptions}
                  placeholder="No initial administrators"
                  searchPlaceholder="Search active members..."
                  value={field.value}
                  aria-describedby="workspace-admins-error"
                />
                <FieldError id="workspace-admins-error" errors={[fieldState.error]}>
                  {errors?.admin_member_ids?.[0]}
                </FieldError>
              </Field>
            )}
          />

          <div className="grid gap-4 pt-2">
            <h3 className="font-medium">Inherited organization resources</h3>
            {inheritanceCategories.map(({ key, label }) => (
              <Controller
                key={key}
                name={`selected_organization_resources.${key}`}
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`inherited-${key}`}>{label}</FieldLabel>
                    <MultiSelectDropdown
                      ref={field.ref}
                      onBlurAction={field.onBlur}
                      id={`inherited-${key}`}
                      disabled={pending}
                      onValueChangeAction={field.onChange}
                      options={resourceOptions[key]}
                      placeholder={`No ${label.toLowerCase()} selected`}
                      searchPlaceholder={`Search ${label.toLowerCase()}...`}
                      value={field.value}
                      invalid={fieldState.invalid}
                      aria-describedby={fieldState.invalid ? `inherited-${key}-error` : undefined}
                    />
                    <FieldError id={`inherited-${key}-error`} errors={[fieldState.error]} />
                  </Field>
                )}
              />
            ))}
          </div>
        </FieldGroup>

        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline">
            <Link href={`/orgs/${orgSlug}/workspaces` as Route}>Cancel</Link>
          </Button>
          <Button disabled={pending} type="submit">
            Create Workspace
          </Button>
        </div>
      </form>

      <Dialog onOpenChange={setConfirmationOpen} open={confirmationOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm workspace creation</DialogTitle>
            <DialogDescription>
              Confirm the initial administrators and inherited resources before creating the
              Workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60dvh,36rem)] overflow-y-auto py-2">
            <dl className="grid gap-4">
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{name}</dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Workspace type</dt>
                <dd>{workspaceType === "coding" ? "Coding" : "General purpose"}</dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Administrators</dt>
                <dd>
                  {admins.length === 0
                    ? "None"
                    : candidates
                        .filter((candidate) => admins.includes(candidate.member_id))
                        .map((candidate) => candidate.name || candidate.email)
                        .join(", ")}
                </dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Inherited resources</dt>
                <dd>
                  {Object.values(inherited).reduce((count, names) => count + names.length, 0)}{" "}
                  selected
                </dd>
              </div>
            </dl>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pending} type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button data-dialog-submit disabled={pending} form="workspace-form" type="submit">
              {pending ? <Spinner /> : <Plus data-icon="inline-start" />}
              {pending ? "Creating..." : "Confirm and create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const inheritanceCategories = [
  { field: "inherited_skills", key: "skills", label: "Skills" },
  { field: "inherited_sandboxes", key: "sandboxes", label: "Sandboxes" },
  {
    field: "inherited_mcp_connections",
    key: "mcp_connections",
    label: "MCP connections",
  },
  {
    field: "inherited_inference_providers",
    key: "inference_providers",
    label: "Inference providers",
  },
] as const
