"use client"

import Link from "next/link"
import type { Route } from "next"
import { useActionState, useState, useTransition } from "react"
import { Send, ShieldPlus, X } from "lucide-react"
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
  const [stage, setStage] = useState<"details" | "review">("details")
  const [email, setEmail] = useState(invitation?.email ?? "")
  const [roleIds, setRoleIds] = useState(invitation?.roleIds ?? [])
  const [teamIds, setTeamIds] = useState(invitation?.teamIds ?? [])
  const [state, action, pending] = useActionState<InviteMemberFormState, FormData>(
    inviteMemberAction.bind(null, orgSlug),
    {}
  )
  const selectedRoles = roles.filter((role) => roleIds.includes(role.id))
  const selectedTeams = teams.filter((team) => teamIds.includes(team.id))
  const ready = email.trim() !== "" && roleIds.length + teamIds.length > 0

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <Send />
          {invitation ? "Edit" : "Invite user"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(44rem,calc(100vh-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>
            Creates a 48-hour bearer link. Anyone with the link can try to accept it, so share it
            only with the invited email owner.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-5">
          <input name="email" type="hidden" value={email} />
          {roleIds.map((id) => (
            <input key={id} name="role_ids" type="hidden" value={id} />
          ))}
          {teamIds.map((id) => (
            <input key={id} name="team_ids" type="hidden" value={id} />
          ))}
          {stage === "details" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`invite-email-${invitation?.id ?? "new"}`}>Email</FieldLabel>
                <Input
                  id={`invite-email-${invitation?.id ?? "new"}`}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                  required
                />
              </Field>
              <AssignmentChecks
                label="Initial Roles"
                onChange={setRoleIds}
                options={roles}
                selected={roleIds}
              />
              <AssignmentChecks
                label="Initial Teams"
                onChange={setTeamIds}
                options={teams}
                selected={teamIds}
              />
            </>
          ) : (
            <section aria-label="Invitation access review" className="grid gap-4">
              <h3 className="font-medium">Review initial access</h3>
              <dl className="grid gap-3 text-sm">
                <div className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="break-all">{email}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                  <dt className="text-muted-foreground">Direct Roles</dt>
                  <dd>{selectedRoles.map((role) => role.name).join(", ") || "None"}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                  <dt className="text-muted-foreground">Teams</dt>
                  <dd>{selectedTeams.map((team) => team.name).join(", ") || "None"}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                  <dt className="text-muted-foreground">Effective access</dt>
                  <dd>
                    Union of {selectedRoles.length} direct Role
                    {selectedRoles.length === 1 ? "" : "s"} and {selectedTeams.length} Team
                    {selectedTeams.length === 1 ? "" : "s"}.
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
          {state.link ? (
            <div className="bg-muted/40 flex min-w-0 items-center gap-2 p-2">
              <code className="min-w-0 flex-1 truncate text-xs">{state.link}</code>
              <CopyButton content={state.link} label="Copy" />
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            {stage === "review" ? (
              <Button onClick={() => setStage("details")} type="button" variant="outline">
                Back
              </Button>
            ) : null}
            {stage === "details" ? (
              <Button disabled={!ready} onClick={() => setStage("review")} type="button">
                Review access
              </Button>
            ) : (
              <Button disabled={pending} type="submit">
                {pending ? <Spinner /> : <Send />}
                {invitation ? "Replace invitation" : "Create invitation"}
              </Button>
            )}
          </div>
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
