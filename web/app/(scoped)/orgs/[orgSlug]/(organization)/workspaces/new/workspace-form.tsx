"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { useActionState, useState } from "react"
import { Box, Brain, Cable, CircleAlert, Plus, Wrench } from "lucide-react"
import { createWorkspaceAction, type CreateWorkspaceFormState } from "@/app/(scoped)/orgs/actions"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import type { WorkspaceMemberCandidate } from "@/lib/gateway/client"
import type { SelectedOrganizationResources } from "@/lib/gateway/client"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"
import { toast } from "sonner"

export function WorkspaceForm({
  candidates,
  orgSlug,
  resources,
}: {
  candidates: WorkspaceMemberCandidate[]
  orgSlug: string
  resources: SelectedOrganizationResources
}) {
  const router = useRouter()
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [name, setName] = useState("")
  const [admins, setAdmins] = useState<string[]>([])
  const [inherited, setInherited] = useState<SelectedOrganizationResources>({
    skills: [],
    sandboxes: [],
    mcp_connections: [],
    inference_providers: [],
  })
  const [clientErrors, setClientErrors] = useState<CreateWorkspaceFormState["errors"]>()
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

  const options = candidates.map((candidate) => ({
    image: candidate.image,
    initials: (candidate.name || candidate.email).slice(0, 1).toUpperCase(),
    label: candidate.name ? `${candidate.name} (${candidate.email})` : candidate.email,
    value: candidate.member_id,
  }))
  const errors = clientErrors ?? state.errors

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Create Workspace" />
      <form
        action={formAction}
        className="flex max-w-2xl flex-col gap-6 px-4 pb-6 md:px-6"
        id="workspace-form"
      >
        <input name="name" type="hidden" value={name} />
        {admins.map((memberId) => (
          <input key={memberId} name="admin_member_ids" type="hidden" value={memberId} />
        ))}
        {inheritanceCategories.flatMap(({ field, key }) =>
          inherited[key].map((name) => (
            <input key={`${key}:${name}`} name={field} type="hidden" value={name} />
          ))
        )}

        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Workspace could not be created</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <Field data-invalid={Boolean(errors?.name)}>
            <FieldLabel htmlFor="workspace-name" required>
              Name
            </FieldLabel>
            <Input
              aria-invalid={Boolean(errors?.name)}
              autoComplete="off"
              id="workspace-name"
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value)
                setClientErrors(undefined)
              }}
              placeholder="e.g. Research lab"
              value={name}
            />
            <FieldError>{errors?.name?.[0]}</FieldError>
          </Field>

          <Field data-invalid={Boolean(errors?.admin_member_ids)}>
            <FieldLabel htmlFor="workspace-admins">Initial administrators</FieldLabel>
            <MultiSelectDropdown
              id="workspace-admins"
              invalid={Boolean(errors?.admin_member_ids)}
              onValueChangeAction={(value) => {
                setAdmins(value)
                setClientErrors(undefined)
              }}
              options={options}
              placeholder="No initial administrators"
              searchPlaceholder="Search active members..."
              value={admins}
            />
            <FieldError>{errors?.admin_member_ids?.[0]}</FieldError>
          </Field>

          <div className="grid gap-4 pt-2">
            <h3 className="font-medium">Inherited organization resources</h3>
            {inheritanceCategories.map(({ icon, key, label }) => (
              <Field key={key}>
                <FieldLabel htmlFor={`inherited-${key}`}>{label}</FieldLabel>
                <MultiSelectDropdown
                  id={`inherited-${key}`}
                  onValueChangeAction={(value) =>
                    setInherited((current) => ({ ...current, [key]: value }))
                  }
                  options={resources[key].map((name) => ({ icon, label: name, value: name }))}
                  placeholder={`No ${label.toLowerCase()} selected`}
                  searchPlaceholder={`Search ${label.toLowerCase()}...`}
                  value={inherited[key]}
                />
              </Field>
            ))}
          </div>
        </FieldGroup>

        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline">
            <Link href={`/orgs/${orgSlug}/workspaces` as Route}>Cancel</Link>
          </Button>
          <Button
            onClick={() => {
              const parsed = zCreateWorkspaceRequest.safeParse({
                admin_member_ids: admins,
                name,
                selected_organization_resources: inherited,
              })
              if (!parsed.success) {
                setClientErrors(parsed.error.flatten().fieldErrors)
                return
              }
              setClientErrors(undefined)
              setConfirmationOpen(true)
            }}
            type="button"
          >
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
              {pending ? "Creating…" : "Confirm and create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const inheritanceCategories = [
  { field: "inherited_skills", icon: Wrench, key: "skills", label: "Skills" },
  { field: "inherited_sandboxes", icon: Box, key: "sandboxes", label: "Sandboxes" },
  {
    field: "inherited_mcp_connections",
    icon: Cable,
    key: "mcp_connections",
    label: "MCP connections",
  },
  {
    field: "inherited_inference_providers",
    icon: Brain,
    key: "inference_providers",
    label: "Inference providers",
  },
] as const
