"use client"

import { useActionState, useTransition } from "react"
import { Send, ShieldOff, ShieldPlus, X } from "lucide-react"
import {
  cancelInvitationAction,
  inviteMemberAction,
  setMemberDisabledAction,
  type InviteMemberFormState,
} from "@/app/(scoped)/orgs/actions"
import type { AssignmentOption, InvitationRow } from "@/data/members"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function InviteMemberDialog({
  orgSlug,
  roles,
  teams,
  invitation,
}: {
  orgSlug: string
  roles: AssignmentOption[]
  teams: AssignmentOption[]
  invitation?: InvitationRow
}) {
  const [state, action, pending] = useActionState<InviteMemberFormState, FormData>(
    inviteMemberAction.bind(null, orgSlug),
    {}
  )

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <Send />
          {invitation ? "Edit" : "Invite User"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(44rem,calc(100vh-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
          <DialogDescription>
            Creates a 48-hour bearer link. Anyone with the link can try to accept it, so share it
            only with the invited email owner.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor={`invite-email-${invitation?.id ?? "new"}`}>Email</FieldLabel>
            <Input
              defaultValue={invitation?.email}
              id={`invite-email-${invitation?.id ?? "new"}`}
              name="email"
              type="email"
              required
            />
          </Field>
          <AssignmentChecks
            label="Initial Roles"
            name="role_ids"
            options={roles}
            selected={invitation?.roleIds}
          />
          <AssignmentChecks
            label="Initial Teams"
            name="team_ids"
            options={teams}
            selected={invitation?.teamIds}
          />
          {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
          {state.link ? (
            <div className="bg-muted/40 flex min-w-0 items-center gap-2 rounded-lg border p-2">
              <code className="min-w-0 flex-1 truncate text-xs">{state.link}</code>
              <CopyButton content={state.link} label="Copy" />
            </div>
          ) : null}
          <Button disabled={pending} type="submit">
            {pending ? <Spinner /> : <Send />}
            Create Invitation
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CancelInvitationButton({
  invitationId,
  orgSlug,
}: {
  invitationId: string
  orgSlug: string
}) {
  const [pending, start] = useTransition()
  return (
    <Button
      disabled={pending}
      onClick={() => start(() => cancelInvitationAction(orgSlug, invitationId))}
      size="sm"
      type="button"
      variant="ghost"
    >
      {pending ? <Spinner /> : <X />}
      Cancel
    </Button>
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
  return (
    <Button
      disabled={pending}
      onClick={() => start(() => setMemberDisabledAction(orgSlug, memberId, !disabled))}
      size="sm"
      type="button"
      variant={disabled ? "outline" : "destructive"}
    >
      {pending ? <Spinner /> : disabled ? <ShieldPlus /> : <ShieldOff />}
      {disabled ? "Restore" : "Disable"}
    </Button>
  )
}

function AssignmentChecks({
  label,
  name,
  options,
  selected = [],
}: {
  label: string
  name: string
  options: AssignmentOption[]
  selected?: string[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            className="hover:bg-muted/40 flex items-center gap-2 rounded-md border p-2 text-sm"
            key={option.id}
          >
            <Checkbox defaultChecked={selected.includes(option.id)} name={name} value={option.id} />
            <span className="truncate" title={option.name}>
              {option.name}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
