"use client"

import type { Route } from "next"
import Link from "next/link"
import { useActionState, useState } from "react"
import { CircleAlert } from "lucide-react"
import { teamFormAction, type TeamFormState } from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"

export type TeamFormData = {
  team?: { id: string; name: string; updatedAt: string; memberIds: string[]; roleIds: string[] }
  members: { id: string; name: string | null; email: string }[]
  roles: { id: string; name: string; scope: string }[]
}

export function TeamForm({
  data,
  embedded = false,
  orgSlug,
}: {
  data: TeamFormData
  embedded?: boolean
  orgSlug: string
}) {
  const [stage, setStage] = useState<"details" | "review">("details")
  const [name, setName] = useState(data.team?.name ?? "")
  const [memberIds, setMemberIds] = useState<string[]>(data.team?.memberIds ?? [])
  const [roleIds, setRoleIds] = useState<string[]>(data.team?.roleIds ?? [])
  const action = teamFormAction.bind(null, orgSlug, data.team?.id)
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(action, {})
  const root = `/orgs/${orgSlug}/teams`
  const memberOptions = data.members.map((member) => ({
    label: member.name ? `${member.name} (${member.email})` : member.email,
    value: member.id,
  }))
  const roleOptions = data.roles.map((role) => ({
    label: `${role.name} · ${role.scope}`,
    value: role.id,
  }))
  const input = JSON.stringify({
    name,
    memberIds,
    roleIds,
    ...(data.team ? { updatedAt: data.team.updatedAt } : {}),
  })
  const reviewing = stage === "review" && state.preview?.input === input

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded ? (
        <div className="px-4 pt-4 md:px-6 md:pt-6">
          <h1 className="text-2xl font-semibold tracking-normal">
            {!reviewing ? `${data.team ? "Edit" : "Create"} Team` : "Review Team access"}
          </h1>
        </div>
      ) : null}
      <form action={formAction} className="flex max-w-3xl flex-col gap-6 px-4 pb-6 md:px-6">
        <input name="name" type="hidden" value={name} />
        {data.team ? <input name="updated_at" type="hidden" value={data.team.updatedAt} /> : null}
        {memberIds.map((id) => (
          <input key={id} name="member_ids" type="hidden" value={id} />
        ))}
        {roleIds.map((id) => (
          <input key={id} name="role_ids" type="hidden" value={id} />
        ))}
        {reviewing ? (
          <input name="preview_fingerprint" type="hidden" value={state.preview?.fingerprint} />
        ) : null}

        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Team could not be saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        {!reviewing ? (
          <FieldGroup>
            <Field data-invalid={Boolean(state.errors?.name)}>
              <FieldLabel htmlFor="team-name" required>
                Name
              </FieldLabel>
              <Input
                aria-invalid={Boolean(state.errors?.name)}
                autoComplete="off"
                id="team-name"
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                placeholder="Platform Engineering"
                value={name}
              />
              <FieldError>{state.errors?.name?.[0]}</FieldError>
            </Field>
            <Field data-invalid={Boolean(state.errors?.memberIds)}>
              <FieldLabel htmlFor="team-members" required>
                Members
              </FieldLabel>
              <MultiSelectDropdown
                id="team-members"
                invalid={Boolean(state.errors?.memberIds)}
                onValueChangeAction={setMemberIds}
                options={memberOptions}
                placeholder="Select active members"
                searchPlaceholder="Search active members…"
                value={memberIds}
              />
              <FieldError>{state.errors?.memberIds?.[0]}</FieldError>
            </Field>
            <Field data-invalid={Boolean(state.errors?.roleIds)}>
              <FieldLabel htmlFor="team-roles" required>
                Roles
              </FieldLabel>
              <MultiSelectDropdown
                id="team-roles"
                invalid={Boolean(state.errors?.roleIds)}
                onValueChangeAction={setRoleIds}
                options={roleOptions}
                placeholder="Select Roles"
                searchPlaceholder="Search Roles…"
                value={roleIds}
              />
              <FieldError>{state.errors?.roleIds?.[0]}</FieldError>
            </Field>
          </FieldGroup>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-4">
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium break-words">{name}</dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Members</dt>
                <dd>
                  {memberIds.length} active member{memberIds.length === 1 ? "" : "s"}
                </dd>
              </div>
              <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Roles</dt>
                <dd>
                  {data.roles
                    .filter((role) => roleIds.includes(role.id))
                    .map((role) => `${role.name} · ${role.scope}`)
                    .join(", ")}
                </dd>
              </div>
            </dl>
            <dl className="grid gap-4">
              {state.preview?.rows.map((row) => (
                <div className="grid gap-1 sm:grid-cols-[12rem_1fr]" key={row.id}>
                  <dt className="font-medium">{row.label}</dt>
                  <dd className="text-muted-foreground break-words">{row.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {!reviewing ? (
            <>
              <Button asChild variant="outline">
                <Link href={root as Route}>Cancel</Link>
              </Button>
              <Button
                disabled={pending || !name.trim() || memberIds.length === 0 || roleIds.length === 0}
                onClick={() => setStage("review")}
                name="intent"
                type="submit"
                value="preview"
              >
                {pending ? <Spinner /> : null}
                {pending ? "Reviewing…" : "Review access"}
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={pending}
                onClick={() => setStage("details")}
                type="button"
                variant="outline"
              >
                Back
              </Button>
              <Button disabled={pending} type="submit">
                {pending ? <Spinner /> : null}
                {pending ? "Saving…" : "Save Team"}
              </Button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
