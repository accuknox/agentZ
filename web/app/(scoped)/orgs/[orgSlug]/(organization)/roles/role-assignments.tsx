"use client"

import { useActionState, useMemo, useState } from "react"
import { CircleAlert, Save } from "lucide-react"
import {
  assignOrganizationRoleUsersAction,
  assignWorkspaceRoleUsersAction,
  type RoleAssignmentFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type RoleUser = { assigned: boolean; email: string; memberId: string; name: string }

export function RoleAssignments({
  immutable,
  name,
  orgSlug,
  roleId,
  users,
  workspaceSlug,
}: {
  immutable: boolean
  name: string
  orgSlug: string
  roleId: string
  users: RoleUser[]
  workspaceSlug?: string
}) {
  const baseline = useMemo(
    () => users.filter((user) => user.assigned).map((user) => user.memberId),
    [users]
  )
  const [selected, setSelected] = useState(baseline)
  const baselineKey = baseline.join("\0")
  const [selectedBaselineKey, setSelectedBaselineKey] = useState(baselineKey)
  if (selectedBaselineKey !== baselineKey) {
    setSelectedBaselineKey(baselineKey)
    setSelected(baseline)
  }
  const action = workspaceSlug
    ? assignWorkspaceRoleUsersAction.bind(null, orgSlug, workspaceSlug, roleId)
    : assignOrganizationRoleUsersAction.bind(null, orgSlug, roleId)
  const [state, formAction, pending] = useActionState<RoleAssignmentFormState, FormData>(action, {})
  const changed =
    selected.some((memberId) => !baseline.includes(memberId)) ||
    baseline.some((memberId) => !selected.includes(memberId))

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {selected.map((memberId) => (
        <input key={memberId} name="member_ids" type="hidden" value={memberId} />
      ))}
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Assignments not saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <h2 className="px-4 text-lg font-medium md:px-6">User assignments</h2>
      <div className="w-full min-w-0 border-b">
        <Table aria-label={`Users assigned to ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20 text-center">Assigned</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length ? (
              users.map((user) => (
                <TableRow key={user.memberId}>
                  <TableCell className="text-center">
                    <Checkbox
                      aria-label={`Assign ${name} to ${user.name || user.email}`}
                      checked={selected.includes(user.memberId)}
                      disabled={immutable}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, user.memberId]
                            : current.filter((memberId) => memberId !== user.memberId)
                        )
                      }
                    />
                  </TableCell>
                  <TableCell className="font-medium">{user.name || "Unnamed User"}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={3}>
                  No users
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end px-4 pb-6 md:px-6">
        <Button disabled={immutable || pending || !changed} type="submit">
          {pending ? <Spinner /> : <Save data-icon="inline-start" />}
          {pending ? "Saving..." : "Save assignments"}
        </Button>
      </div>
    </form>
  )
}
