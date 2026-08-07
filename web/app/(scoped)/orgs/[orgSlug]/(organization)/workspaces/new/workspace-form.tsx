"use client"

import type { Route } from "next"
import Link from "next/link"
import { useActionState, useState } from "react"
import { CircleAlert } from "lucide-react"
import { createWorkspaceAction, type CreateWorkspaceFormState } from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import type { WorkspaceMemberCandidate } from "@/lib/gateway/client"
import type { SelectedOrganizationResources } from "@/lib/gateway/client"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"

export function WorkspaceForm({
  candidates,
  orgSlug,
  resources,
}: {
  candidates: WorkspaceMemberCandidate[]
  orgSlug: string
  resources: SelectedOrganizationResources
}) {
  const [stage, setStage] = useState<"details" | "review">("details")
  const [name, setName] = useState("")
  const [admins, setAdmins] = useState<string[]>([])
  const [inherited, setInherited] = useState<SelectedOrganizationResources>({
    skills: [],
    sandboxes: [],
    mcp_connections: [],
    inference_providers: [],
  })
  const [clientErrors, setClientErrors] = useState<CreateWorkspaceFormState["errors"]>()
  const action = createWorkspaceAction.bind(null, orgSlug)
  const [state, formAction, pending] = useActionState<CreateWorkspaceFormState, FormData>(
    action,
    {}
  )

  const options = candidates.map((candidate) => ({
    label: candidate.name ? `${candidate.name} (${candidate.email})` : candidate.email,
    value: candidate.member_id,
  }))
  const errors = clientErrors ?? state.errors

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>
          <h2>{stage === "details" ? "Create a Workspace" : "Review Workspace"}</h2>
        </CardTitle>
        <CardDescription>
          {stage === "details"
            ? "Choose the Workspace identity and its initial administrators."
            : "Confirm these details before provisioning begins."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
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

          {stage === "details" ? (
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
                  placeholder="Platform Engineering"
                  value={name}
                />
                <FieldDescription>Used to derive the Workspace URL and namespace.</FieldDescription>
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
                  searchPlaceholder="Search active members…"
                  value={admins}
                />
                <FieldDescription>
                  Optional. Only active Organisation members can be selected.
                </FieldDescription>
                <FieldError>{errors?.admin_member_ids?.[0]}</FieldError>
              </Field>

              <div className="grid gap-4 border-t pt-5">
                <div>
                  <h3 className="font-medium">Inherited Organisation resources</h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Select individual live, read-only resources. Resources created later are not
                    included.
                  </p>
                </div>
                {inheritanceCategories.map(({ key, label }) => (
                  <Field key={key}>
                    <FieldLabel htmlFor={`inherited-${key}`}>{label}</FieldLabel>
                    <MultiSelectDropdown
                      id={`inherited-${key}`}
                      onValueChangeAction={(value) =>
                        setInherited((current) => ({ ...current, [key]: value }))
                      }
                      options={resources[key].map((name) => ({ label: name, value: name }))}
                      placeholder={`No ${label.toLowerCase()} selected`}
                      searchPlaceholder={`Search ${label.toLowerCase()}…`}
                      value={inherited[key]}
                    />
                    <FieldDescription>
                      {resources[key].length === 0
                        ? `No Organisation ${label.toLowerCase()} are available.`
                        : `${inherited[key].length} of ${resources[key].length} selected.`}
                    </FieldDescription>
                  </Field>
                ))}
              </div>
            </FieldGroup>
          ) : (
            <dl className="divide-border overflow-hidden rounded-lg border">
              <div className="grid gap-1 p-4 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{name}</dd>
              </div>
              <div className="grid gap-1 border-t p-4 sm:grid-cols-[10rem_1fr]">
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
              <div className="grid gap-1 border-t p-4 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Inherited resources</dt>
                <dd>
                  {Object.values(inherited).reduce((count, names) => count + names.length, 0)}{" "}
                  selected
                </dd>
              </div>
            </dl>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {stage === "details" ? (
              <>
                <Button asChild key="cancel" variant="outline">
                  <Link href={`/orgs/${orgSlug}/workspaces` as Route}>Cancel</Link>
                </Button>
                <Button
                  key="continue"
                  onClick={() => {
                    const parsed = zCreateWorkspaceRequest.safeParse({
                      admin_member_ids: admins,
                      name,
                    })
                    if (!parsed.success) {
                      setClientErrors(parsed.error.flatten().fieldErrors)
                      return
                    }
                    setClientErrors(undefined)
                    setStage("review")
                  }}
                  type="button"
                >
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={pending}
                  key="back"
                  onClick={() => setStage("details")}
                  type="button"
                  variant="outline"
                >
                  Back
                </Button>
                <Button disabled={pending} key="create" type="submit">
                  {pending ? <Spinner /> : null}
                  {pending ? "Creating…" : "Create Workspace"}
                </Button>
              </>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

const inheritanceCategories = [
  { field: "inherited_skills", key: "skills", label: "Skills" },
  { field: "inherited_sandboxes", key: "sandboxes", label: "Sandboxes" },
  { field: "inherited_mcp_connections", key: "mcp_connections", label: "MCP Connections" },
  {
    field: "inherited_inference_providers",
    key: "inference_providers",
    label: "Inference Providers",
  },
] as const
