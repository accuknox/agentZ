"use client"

import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { teamFormSchema } from "@/data/schema"
import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { startTransition, useActionState } from "react"
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
  const form = useForm<z.infer<typeof teamFormSchema>>({
    defaultValues: {
      name: data.team?.name ?? "",
      memberIds: data.team?.memberIds ?? [],
      roleIds: data.team?.roleIds ?? [],
      updatedAt: data.team?.updatedAt,
    },
    resolver: zodResolver(teamFormSchema),
  })
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(
    async (state, formData) => {
      const result = await teamFormAction(orgSlug, data.team?.id, state, formData)
      for (const name of ["name", "memberIds", "roleIds"] as const) {
        const message = result.errors?.[name]?.[0]
        if (message) form.setError(name, { type: "server", message })
      }
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
  const submit = form.handleSubmit((values) => {
    const formData = new FormData()
    formData.set("name", values.name)
    if (values.updatedAt) formData.set("updated_at", values.updatedAt)
    for (const id of values.memberIds) formData.append("member_ids", id)
    for (const id of values.roleIds) formData.append("role_ids", id)
    startTransition(() => formAction(formData))
  })
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded ? (
        <AdministrationPageHeader title={data.team ? "Edit Team" : "Create Team"} />
      ) : null}
      <form
        onSubmit={submit}
        noValidate
        className="flex max-w-3xl flex-col gap-6 px-4 pb-6 md:px-6"
      >
        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Team could not be saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup>
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="team-name" required>
                  Name
                </FieldLabel>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  aria-describedby={fieldState.invalid ? "team-name-error" : undefined}
                  required
                  autoComplete="off"
                  id="team-name"
                  maxLength={100}
                  disabled={pending}
                  placeholder="e.g. Security operations"
                />
                <FieldError id="team-name-error" errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="memberIds"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="team-members" required>
                  Members
                </FieldLabel>
                <MultiSelectDropdown
                  ref={field.ref}
                  id="team-members"
                  invalid={fieldState.invalid}
                  aria-required="true"
                  aria-describedby={fieldState.invalid ? "team-members-error" : undefined}
                  onBlurAction={field.onBlur}
                  onValueChangeAction={field.onChange}
                  options={memberOptions}
                  placeholder="Select active members"
                  searchPlaceholder="Search active members..."
                  value={field.value}
                  disabled={pending}
                />
                <FieldError id="team-members-error" errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="roleIds"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="team-roles">Roles</FieldLabel>
                <MultiSelectDropdown
                  ref={field.ref}
                  id="team-roles"
                  invalid={fieldState.invalid}
                  aria-describedby={fieldState.invalid ? "team-roles-error" : undefined}
                  onBlurAction={field.onBlur}
                  onValueChangeAction={field.onChange}
                  options={roleOptions}
                  placeholder="Select Roles"
                  searchPlaceholder="Search Roles..."
                  value={field.value}
                  disabled={pending}
                />
                <FieldError id="team-roles-error" errors={[fieldState.error]} />
              </Field>
            )}
          />
        </FieldGroup>

        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline">
            <Link href={root as Route}>Cancel</Link>
          </Button>
          <Button disabled={pending} type="submit">
            {pending ? <Spinner /> : <Save data-icon="inline-start" />}
            {pending ? "Saving..." : data.team ? "Update team" : "Create team"}
          </Button>
        </div>
      </form>
    </div>
  )
}
