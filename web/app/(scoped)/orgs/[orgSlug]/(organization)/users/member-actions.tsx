"use client"

import Link from "next/link"
import type { Route } from "next"
import { useActionState, useId, useState, useTransition } from "react"
import { MoreHorizontal, Send, Shield, ShieldPlus, UsersRound, X } from "lucide-react"
import { toast } from "sonner"
import {
  cancelInvitationAction,
  createInvitationAction,
  restoreMembershipAction,
  type InvitationFormState,
} from "@/app/(scoped)/orgs/actions"
import type { AssignmentOption } from "@/data/members"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"

export function CreateInvitationDialog({
  orgSlug,
  roles,
  teams,
}: {
  orgSlug: string
  roles: AssignmentOption[]
  teams: AssignmentOption[]
}) {
  const [open, setOpen] = useState(false)
  const [flow, setFlow] = useState(0)

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) setFlow((current) => current + 1)
        setOpen(next)
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button>
          <Send />
          Create invitation
        </Button>
      </DialogTrigger>
      <CreateInvitationForm key={flow} orgSlug={orgSlug} roles={roles} teams={teams} />
    </Dialog>
  )
}

export function InvitationActions({
  invitationId,
  orgSlug,
}: {
  invitationId: string
  orgSlug: string
}) {
  const [pending, start] = useTransition()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Invitation actions" size="icon-sm" variant="ghost">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={pending}
          onSelect={() =>
            start(async () => {
              await cancelInvitationAction(orgSlug, invitationId)
              toast.success("Invitation cancelled")
            })
          }
          variant="destructive"
        >
          {pending ? <Spinner /> : <X />}
          Cancel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MembershipStateButton({
  disabled,
  memberId,
  orgSlug,
}: {
  disabled: boolean
  memberId: string
  orgSlug: string
}) {
  const [pending, start] = useTransition()
  if (!disabled) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/orgs/${orgSlug}/users/${memberId}` as Route}>Manage</Link>
      </Button>
    )
  }
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          await restoreMembershipAction(orgSlug, memberId)
          toast.success("User restored")
        })
      }
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? <Spinner /> : <ShieldPlus />}
      Restore
    </Button>
  )
}

function CreateInvitationForm({
  orgSlug,
  roles,
  teams,
}: {
  orgSlug: string
  roles: AssignmentOption[]
  teams: AssignmentOption[]
}) {
  const formId = useId()
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [state, submit, pending] = useActionState<InvitationFormState, FormData>(
    async (state, formData) => {
      const result = await createInvitationAction(orgSlug, state, formData)
      if (result.link) toast.success("Invitation created")
      return result
    },
    {}
  )
  const ready = roleIds.length + teamIds.length > 0

  if (state.link) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitation created</DialogTitle>
          <DialogDescription>
            Copy this link now. For security, it cannot be shown again.
          </DialogDescription>
        </DialogHeader>
        <InputGroup className="h-10">
          <InputGroupInput
            aria-label="Invitation link"
            className="font-mono text-xs"
            readOnly
            value={state.link}
          />
          <InputGroupAddon align="inline-end">
            <CopyButton content={state.link} label="Copy" />
          </InputGroupAddon>
        </InputGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    )
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Create invitation</DialogTitle>
        <DialogDescription>
          Create a one-time link that expires after 48 hours. Any signed-in user with the link can
          join with the selected access.
        </DialogDescription>
      </DialogHeader>
      <form action={submit} className="flex min-w-0 flex-col gap-5" id={formId}>
        {roleIds.map((id) => (
          <input key={id} name="role_ids" type="hidden" value={id} />
        ))}
        {teamIds.map((id) => (
          <input key={id} name="team_ids" type="hidden" value={id} />
        ))}
        <FieldGroup className="grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${formId}-roles`}>Direct roles</FieldLabel>
            <MultiSelectDropdown
              emptyMessage="No roles available."
              id={`${formId}-roles`}
              onValueChangeAction={setRoleIds}
              options={roles.map((role) => ({ icon: Shield, label: role.name, value: role.id }))}
              placeholder="Select direct roles"
              searchPlaceholder="Search roles..."
              value={roleIds}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-teams`}>Teams</FieldLabel>
            <MultiSelectDropdown
              emptyMessage="No teams available."
              id={`${formId}-teams`}
              onValueChangeAction={setTeamIds}
              options={teams.map((team) => ({
                icon: UsersRound,
                label: team.name,
                value: team.id,
              }))}
              placeholder="Select teams"
              searchPlaceholder="Search teams..."
              value={teamIds}
            />
          </Field>
        </FieldGroup>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <div className="flex justify-end">
          <Button disabled={!ready || pending} type="submit">
            {pending ? <Spinner /> : <Send />}
            {pending ? "Saving..." : "Create invitation"}
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}
