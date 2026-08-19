"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { useActionState, useState } from "react"
import { CircleAlert, PanelsTopLeft, Save, Shield } from "lucide-react"
import { teamFormAction, type TeamFormState } from "@/app/(scoped)/orgs/actions"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"

export type TeamFormData = {
  team?: { id: string; name: string; updatedAt: string; memberIds: string[]; roleIds: string[] }
  members: { id: string; name: string | null; email: string; image: string | null }[]
  roles: { id: string; name: string; scope: string; workspace: string | null }[]
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
  const router = useRouter()
  const [name, setName] = useState(data.team?.name ?? "")
  const [memberIds, setMemberIds] = useState<string[]>(data.team?.memberIds ?? [])
  const [roleIds, setRoleIds] = useState<string[]>(data.team?.roleIds ?? [])
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(
    async (state, formData) => {
      const result = await teamFormAction(orgSlug, data.team?.id, state, formData)
      if (result.href) {
        toast.success(data.team ? "Team updated" : "Team created")
        router.push(result.href)
      }
      return result
    },
    {}
  )
  const root = `/orgs/${orgSlug}/teams`
  const memberOptions = data.members.map((member) => ({
    image: member.image,
    initials: (member.name ?? member.email).slice(0, 1).toUpperCase(),
    label: member.name ? `${member.name} (${member.email})` : member.email,
    value: member.id,
  }))
  const roleOptions = data.roles.map((role) => ({
    badge: role.workspace ?? role.scope,
    badgeIcon: role.workspace ? PanelsTopLeft : undefined,
    group: role.scope,
    icon: Shield,
    label: role.name,
    value: role.id,
  }))
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded ? (
        <AdministrationPageHeader title={data.team ? "Edit Team" : "Create Team"} />
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
        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Team could not be saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

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
              placeholder="e.g. Security operations"
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
              searchPlaceholder="Search active members..."
              value={memberIds}
            />
            <FieldError>{state.errors?.memberIds?.[0]}</FieldError>
          </Field>
          <Field data-invalid={Boolean(state.errors?.roleIds)}>
            <FieldLabel htmlFor="team-roles">Roles</FieldLabel>
            <MultiSelectDropdown
              id="team-roles"
              invalid={Boolean(state.errors?.roleIds)}
              onValueChangeAction={setRoleIds}
              options={roleOptions}
              placeholder="Select Roles"
              searchPlaceholder="Search Roles..."
              value={roleIds}
            />
            <FieldError>{state.errors?.roleIds?.[0]}</FieldError>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline">
            <Link href={root as Route}>Cancel</Link>
          </Button>
          <Button disabled={pending || !name.trim() || memberIds.length === 0} type="submit">
            {pending ? <Spinner /> : <Save data-icon="inline-start" />}
            {pending ? "Saving…" : data.team ? "Update team" : "Create team"}
          </Button>
        </div>
      </form>
    </div>
  )
}
