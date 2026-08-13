"use client"

import Link from "next/link"
import type { Route } from "next"
import { useActionState, useState, useTransition } from "react"
import { Check, Copy, MoreHorizontal, Pencil, Send, ShieldPlus, X } from "lucide-react"
import {
  cancelInvitationAction,
  inviteMemberAction,
  restoreMembershipAction,
  type InviteMemberFormState,
} from "@/app/(scoped)/orgs/actions"
import type { AssignmentOption, InvitationRow } from "@/data/members"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CopyButton } from "@/components/ui/copy-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

export function InviteMemberDialog({
  orgSlug,
  roles,
  teams,
  invitation,
  open,
  onOpenChange,
  showTrigger = true,
}: {
  orgSlug: string
  roles: AssignmentOption[]
  teams: AssignmentOption[]
  invitation?: InvitationRow
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}) {
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [email, setEmail] = useState(invitation?.email ?? "")
  const [roleIds, setRoleIds] = useState(invitation?.roleIds ?? [])
  const [teamIds, setTeamIds] = useState(invitation?.teamIds ?? [])
  const [state, action, pending] = useActionState<InviteMemberFormState, FormData>(
    async (previousState, formData) => {
      const result = await inviteMemberAction(orgSlug, previousState, formData)
      setConfirmationOpen(false)
      return result
    },
    {}
  )
  const selectedRoles = roles.filter((role) => roleIds.includes(role.id))
  const selectedTeams = teams.filter((team) => teamIds.includes(team.id))
  const ready = email.trim() !== "" && roleIds.length + teamIds.length > 0
  const formId = `invitation-form-${invitation?.id ?? "new"}`

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        {showTrigger ? (
          <DialogTrigger asChild>
            <Button>
              <Send />
              {invitation ? "Edit" : "Invite user"}
            </Button>
          </DialogTrigger>
        ) : null}
        <DialogContent className="max-h-[min(44rem,calc(100vh-2rem))] overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>
              Creates a 48-hour bearer link. Anyone with the link can try to accept it, so share it
              only with the invited email owner.
            </DialogDescription>
          </DialogHeader>
          <form action={action} className="flex min-w-0 flex-col gap-5" id={formId}>
            <input name="email" type="hidden" value={email} />
            {roleIds.map((id) => (
              <input key={id} name="role_ids" type="hidden" value={id} />
            ))}
            {teamIds.map((id) => (
              <input key={id} name="team_ids" type="hidden" value={id} />
            ))}
            <Field>
              <FieldLabel htmlFor={`invite-email-${invitation?.id ?? "new"}`}>Email</FieldLabel>
              <Input
                id={`invite-email-${invitation?.id ?? "new"}`}
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </Field>
            <AssignmentChecks
              label="Initial Roles"
              onChange={setRoleIds}
              options={roles}
              selected={roleIds}
            />
            {teams.length ? (
              <AssignmentChecks
                label="Initial Teams"
                onChange={setTeamIds}
                options={teams}
                selected={teamIds}
              />
            ) : null}
            {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
            {state.link ? (
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
            ) : null}
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              <Button disabled={!ready} onClick={() => setConfirmationOpen(true)} type="button">
                {invitation ? "Replace invitation" : "Create invitation"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setConfirmationOpen} open={confirmationOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm invitation</DialogTitle>
            <DialogDescription>
              Confirm the recipient and their initial access before creating the invitation.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(60dvh,36rem)] overflow-y-auto py-2">
            <section aria-label="Invitation access confirmation" className="grid min-w-0 gap-4">
              <dl className="grid min-w-0 gap-3 text-sm">
                <div className="grid min-w-0 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="min-w-0 break-all">{email}</dd>
                </div>
                <div className="grid min-w-0 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Direct Roles</dt>
                  <dd className="min-w-0 break-words">
                    {selectedRoles.map((role) => role.name).join(", ") || "None"}
                  </dd>
                </div>
                {teams.length ? (
                  <div className="grid min-w-0 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <dt className="text-muted-foreground">Teams</dt>
                    <dd className="min-w-0 break-words">
                      {selectedTeams.map((team) => team.name).join(", ") || "None"}
                    </dd>
                  </div>
                ) : null}
                <div className="grid min-w-0 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Effective access</dt>
                  <dd className="min-w-0 break-words">
                    {teams.length ? "Union of " : ""}
                    {selectedRoles.length} direct Role
                    {selectedRoles.length === 1 ? "" : "s"}
                    {teams.length
                      ? ` and ${selectedTeams.length} Team${selectedTeams.length === 1 ? "" : "s"}`
                      : ""}
                    .
                  </dd>
                </div>
              </dl>
            </section>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pending} type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button data-dialog-submit disabled={pending} form={formId} type="submit">
              {pending ? <Spinner /> : <Send />}
              {pending ? "Saving..." : invitation ? "Confirm replacement" : "Confirm invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function InvitationActions({
  invitation,
  orgSlug,
  roles,
  teams,
}: {
  invitation: InvitationRow
  orgSlug: string
  roles: AssignmentOption[]
  teams: AssignmentOption[]
}) {
  const [editing, setEditing] = useState(false)
  const [pending, start] = useTransition()
  const { isCopied, handleCopy } = useCopyToClipboard({ text: invitation.link })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={`Actions for ${invitation.email}`} size="icon-sm" variant="ghost">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleCopy}>
            {isCopied ? <Check /> : <Copy />}
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => start(() => cancelInvitationAction(orgSlug, invitation.id))}
            variant="destructive"
          >
            {pending ? <Spinner /> : <X />}
            Cancel
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <InviteMemberDialog
        invitation={invitation}
        onOpenChange={setEditing}
        open={editing}
        orgSlug={orgSlug}
        roles={roles}
        showTrigger={false}
        teams={teams}
      />
    </>
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
      onClick={() => start(() => restoreMembershipAction(orgSlug, memberId))}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? <Spinner /> : <ShieldPlus />}
      Restore
    </Button>
  )
}

function AssignmentChecks({
  label,
  onChange,
  options,
  selected = [],
}: {
  label: string
  onChange: (ids: string[]) => void
  options: AssignmentOption[]
  selected?: string[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label className="hover:bg-muted/40 flex items-center gap-2 py-2 text-sm" key={option.id}>
            <Checkbox
              checked={selected.includes(option.id)}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...selected, option.id] : selected.filter((id) => id !== option.id)
                )
              }
              value={option.id}
            />
            <span className="truncate" title={option.name}>
              {option.name}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
