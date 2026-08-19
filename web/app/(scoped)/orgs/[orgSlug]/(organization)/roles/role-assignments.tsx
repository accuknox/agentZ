"use client"

import { useActionState, useMemo, useState } from "react"
import { CircleAlert, Save } from "lucide-react"
import { toast } from "sonner"
import {
  assignOrganizationRoleUsersAction,
  assignWorkspaceRoleUsersAction,
  type AssignmentFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { UserIdentity } from "@/components/ui/avatar"
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

type RoleUser = {
  assigned: boolean
  email: string
  image: string | null
  memberId: string
  name: string
}

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
  const [state, formAction, pending] = useActionState<AssignmentFormState, FormData>(
    async (state, formData) => {
      const result = workspaceSlug
        ? await assignWorkspaceRoleUsersAction(orgSlug, workspaceSlug, roleId, state, formData)
        : await assignOrganizationRoleUsersAction(orgSlug, roleId, state, formData)
      if (result.saved) toast.success("Role assignments updated")
      return result
    },
    {}
  )
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
                  <TableCell>
                    <UserIdentity email={user.email} image={user.image} name={user.name} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={2}>
                  <span className="text-muted-foreground">_</span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end px-4 pb-6 md:px-6">
        <Button disabled={immutable || pending || !changed} type="submit">
          {pending ? <Spinner /> : <Save data-icon="inline-start" />}
          {pending ? "Saving…" : "Save assignments"}
        </Button>
      </div>
    </form>
  )
}
