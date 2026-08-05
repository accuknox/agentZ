"use client"

import type { Route } from "next"
import Link from "next/link"
import { useActionState, useState } from "react"
import { CircleAlert } from "lucide-react"
import { createWorkspaceAction, type CreateWorkspaceFormState } from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import type { WorkspaceMemberCandidate } from "@/lib/gateway/client"
import { zCreateWorkspaceRequest } from "@/lib/gateway/client/zod.gen"

export function WorkspaceForm({
  candidates,
  orgSlug,
}: {
  candidates: WorkspaceMemberCandidate[]
  orgSlug: string
}) {
  const [stage, setStage] = useState<"details" | "review">("details")
  const [name, setName] = useState("")
  const [admins, setAdmins] = useState<string[]>([])
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

              <Field data-disabled="true">
                <FieldLabel className="border p-3">
                  <span className="flex items-center gap-2">
                    <Checkbox disabled />
                    Inherit Organisation resources
                  </span>
                  <FieldDescription>
                    No inheritable resources are available in this release.
                  </FieldDescription>
                </FieldLabel>
              </Field>
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
