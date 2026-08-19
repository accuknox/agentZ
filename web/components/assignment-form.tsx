"use client"

import { useActionState, useState } from "react"
import { CircleAlert, PanelsTopLeft, Save, Shield, UsersRound } from "lucide-react"
import { toast } from "sonner"
import {
  saveMemberAssignmentsAction,
  saveTeamRolesAction,
  type AssignmentFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Spinner } from "@/components/ui/spinner"
import type { AssignmentOption, ScopedAssignmentOption } from "@/data/members"

type AssignmentFormProps = {
  name: string
  orgSlug: string
  roleIds: string[]
  roles: ScopedAssignmentOption[]
} & (
  | {
      kind: "member"
      memberId: string
      teamIds: string[]
      teams: AssignmentOption[]
    }
  | {
      kind: "team"
      teamId: string
      updatedAt: string
    }
)

export function AssignmentForm(props: AssignmentFormProps) {
  const baseline = [
    props.roleIds.toSorted().join("\0"),
    props.kind === "member" ? props.teamIds.toSorted().join("\0") : "",
  ].join("\u0001")
  const [roleIds, setRoleIds] = useState(props.roleIds)
  const [teamIds, setTeamIds] = useState(props.kind === "member" ? props.teamIds : [])
  const [renderedBaseline, setRenderedBaseline] = useState(baseline)
  if (renderedBaseline !== baseline) {
    setRenderedBaseline(baseline)
    setRoleIds(props.roleIds)
    setTeamIds(props.kind === "member" ? props.teamIds : [])
  }
  const [state, action, pending] = useActionState<AssignmentFormState, FormData>(
    async (state, formData) => {
      const result =
        props.kind === "member"
          ? await saveMemberAssignmentsAction(props.orgSlug, props.memberId, state, formData)
          : await saveTeamRolesAction(props.orgSlug, props.teamId, state, formData)
      if (result.saved) toast.success("Assignments updated")
      return result
    },
    {}
  )
  const changed =
    roleIds.toSorted().join("\0") !== props.roleIds.toSorted().join("\0") ||
    (props.kind === "member" &&
      teamIds.toSorted().join("\0") !== props.teamIds.toSorted().join("\0"))
  const assignmentRequired = props.kind === "member" && roleIds.length + teamIds.length === 0

  return (
    <form action={action} className="flex max-w-3xl min-w-0 flex-col gap-5 px-4 md:px-6">
      {roleIds.map((roleId) => (
        <input key={`role:${roleId}`} name="role_ids" type="hidden" value={roleId} />
      ))}
      {teamIds.map((teamId) => (
        <input key={`team:${teamId}`} name="team_ids" type="hidden" value={teamId} />
      ))}
      {props.kind === "member" ? (
        <>
          {props.roleIds.map((roleId) => (
            <input
              key={`previous-role:${roleId}`}
              name="previous_role_ids"
              type="hidden"
              value={roleId}
            />
          ))}
          {props.teamIds.map((teamId) => (
            <input
              key={`previous-team:${teamId}`}
              name="previous_team_ids"
              type="hidden"
              value={teamId}
            />
          ))}
        </>
      ) : (
        <input name="updated_at" type="hidden" value={props.updatedAt} />
      )}

      <div>
        <h2 className="text-lg font-medium">Assignments</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {props.kind === "member"
            ? `Manage the direct Roles and Teams assigned to ${props.name}.`
            : `Manage the Roles granted through ${props.name}.`}
        </p>
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Assignments not saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup className={props.kind === "member" ? "grid sm:grid-cols-2" : undefined}>
        <Field data-invalid={assignmentRequired}>
          <FieldLabel htmlFor={`${props.kind}-roles`}>
            {props.kind === "member" ? "Direct roles" : "Roles"}
          </FieldLabel>
          <MultiSelectDropdown
            emptyMessage="No roles available."
            id={`${props.kind}-roles`}
            invalid={assignmentRequired}
            onValueChangeAction={setRoleIds}
            options={props.roles.map((role) => ({
              badge: role.workspace ?? role.scope,
              badgeIcon: role.workspace ? PanelsTopLeft : undefined,
              group: role.scope,
              icon: Shield,
              label: role.name,
              value: role.id,
            }))}
            placeholder={props.kind === "member" ? "Select direct roles" : "Select roles"}
            searchPlaceholder="Search roles..."
            value={roleIds}
          />
        </Field>
        {props.kind === "member" ? (
          <Field data-invalid={assignmentRequired}>
            <FieldLabel htmlFor="member-teams">Teams</FieldLabel>
            <MultiSelectDropdown
              emptyMessage="No teams available."
              id="member-teams"
              invalid={assignmentRequired}
              onValueChangeAction={setTeamIds}
              options={props.teams.map((team) => ({
                icon: UsersRound,
                label: team.name,
                value: team.id,
              }))}
              placeholder="Select teams"
              searchPlaceholder="Search teams..."
              value={teamIds}
            />
          </Field>
        ) : null}
        {assignmentRequired ? (
          <FieldError className="sm:col-span-2">
            Select at least one direct Role or Team.
          </FieldError>
        ) : null}
      </FieldGroup>
      <div className="flex justify-end">
        <Button disabled={pending || !changed || assignmentRequired} type="submit">
          {pending ? <Spinner /> : <Save data-icon="inline-start" />}
          {pending ? "Saving…" : "Save assignments"}
        </Button>
      </div>
    </form>
  )
}
