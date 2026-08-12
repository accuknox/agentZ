"use client"

import { useActionState, useState } from "react"
import { CircleAlert, RefreshCw, Share2, Trash2 } from "lucide-react"
import {
  deleteAgentShareFormAction,
  transferAgentOwnerFormAction,
  upsertAgentShareFormAction,
  type AgentActionScope,
  type AgentOwnerFormState,
  type AgentShareFormState,
} from "@/data/agent.actions"
import type { AgentShareRow, AgentShareTarget } from "@/data/agent.queries"
import type { AgentShareCapability } from "@/lib/gateway/client"
import { AccessSourceChip } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const capabilities = [
  {
    value: "use_shared",
    label: "Use shared Agent",
  },
  {
    value: "share_non_authored",
    label: "Delegate sharing",
  },
  {
    value: "read_shared_secret",
    label: "Read secret metadata",
  },
  {
    value: "write_shared_secret",
    label: "Write secrets",
  },
  {
    value: "delete_shared_secret",
    label: "Delete secrets",
  },
] as const satisfies readonly {
  value: AgentShareCapability
  label: string
}[]

export function AgentOwnerForm({
  actionScope,
  agentName,
  ownerUserId,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  ownerUserId: string
  users: AgentShareTarget[]
}) {
  const action = transferAgentOwnerFormAction.bind(null, actionScope, agentName)
  const [state, formAction, pending] = useActionState<AgentOwnerFormState, FormData>(action, {})
  const [owner, setOwner] = useState(ownerUserId)

  return (
    <section className="max-w-3xl min-w-0 space-y-3">
      <h2 className="px-4 text-lg font-medium md:px-6">Transfer ownership</h2>
      <div className="border-b px-4 pb-6 md:px-6">
        <form action={formAction} className="space-y-5">
          {state.error ? (
            <FormError title="Ownership was not transferred" message={state.error} />
          ) : null}
          {state.success ? (
            <Alert>
              <AlertTitle>Ownership transferred</AlertTitle>
              <AlertDescription>The Agent access summary was refreshed.</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="owner-user-id" required>
                New owner
              </FieldLabel>
              <Select name="owner_user_id" value={owner} onValueChange={setOwner}>
                <SelectTrigger id="owner-user-id" className="w-full">
                  <SelectValue placeholder="Choose an active member" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || owner === ownerUserId}>
              {pending ? <Spinner /> : <RefreshCw />}
              Transfer owner
            </Button>
          </div>
        </form>
      </div>
    </section>
  )
}

export function AgentShareForm({
  actionScope,
  agentName,
  shares,
  teams,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  shares: AgentShareRow[]
  teams: AgentShareTarget[]
  users: AgentShareTarget[]
}) {
  const action = upsertAgentShareFormAction.bind(null, actionScope, agentName)
  const [state, formAction, pending] = useActionState<AgentShareFormState, FormData>(action, {})
  const [targetKind, setTargetKind] = useState<"user" | "team">("user")
  const [targetId, setTargetId] = useState("")
  const targets = targetKind === "user" ? users : teams

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="min-w-0 space-y-3">
        <h2 className="px-4 text-lg font-medium md:px-6">Current shares</h2>
        <div className="w-full min-w-0 border-b">
          <AgentSharesTable actionScope={actionScope} agentName={agentName} shares={shares} />
        </div>
      </section>
      <section className="max-w-3xl min-w-0 space-y-3">
        <h2 className="px-4 text-lg font-medium md:px-6">Add or replace share</h2>
        <div className="border-b px-4 pb-6 md:px-6">
          <form action={formAction} className="space-y-5">
            {state.error ? <FormError title="Share was not saved" message={state.error} /> : null}
            {state.success ? (
              <Alert>
                <AlertTitle>Share saved</AlertTitle>
                <AlertDescription>The Agent share list was refreshed.</AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="share-target-kind" required>
                  Target type
                </FieldLabel>
                <Select
                  name="target_kind"
                  value={targetKind}
                  onValueChange={(value) => {
                    setTargetKind(value as "user" | "team")
                    setTargetId("")
                  }}
                >
                  <SelectTrigger id="share-target-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="share-target-id" required>
                  Target
                </FieldLabel>
                <Select name="target_id" value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger id="share-target-id" className="w-full">
                    <SelectValue placeholder={`Choose a ${targetKind}`} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {targets.map((target) => (
                        <SelectItem key={target.id} value={target.id}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel required>Capabilities</FieldLabel>
                <p className="text-muted-foreground text-sm">
                  Every share grants Use Shared. Secret and delegation capabilities add to that
                  baseline and require matching Workspace permissions for the recipient.
                </p>
                <div className="grid gap-3">
                  {capabilities.map((capability) => (
                    <label
                      className="hover:bg-muted/40 flex items-start gap-3 py-2"
                      key={capability.value}
                    >
                      <Checkbox
                        aria-label={capability.label}
                        name="capabilities"
                        value={capability.value}
                      />
                      <span className="font-medium">{capability.label}</span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  aria-label="Acknowledge full non-secret control"
                  id="acknowledge-use-shared"
                  name="acknowledge_use_shared"
                />
                <div className="grid gap-1">
                  <FieldLabel htmlFor="acknowledge-use-shared">
                    I understand that every share grants full non-secret Agent control
                  </FieldLabel>
                </div>
              </Field>
            </FieldGroup>
            <div className="flex justify-end">
              <Button type="submit" disabled={pending || !targetId}>
                {pending ? <Spinner /> : <Share2 />}
                Save share
              </Button>
            </div>
          </form>
        </div>
      </section>
    </div>
  )
}

function AgentSharesTable({
  actionScope,
  agentName,
  shares,
}: {
  actionScope: AgentActionScope
  agentName: string
  shares: AgentShareRow[]
}) {
  if (shares.length === 0) {
    return (
      <div className="text-muted-foreground flex min-h-24 items-center justify-center text-sm">
        No shares
      </div>
    )
  }

  return (
    <Table aria-label={`${agentName} shares`}>
      <TableHeader>
        <TableRow>
          <TableHead>Target</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Capabilities</TableHead>
          <TableHead>Created by</TableHead>
          <TableHead className="w-16 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shares.map((share) => (
          <TableRow key={share.id}>
            <TableCell className="break-words">{share.target_label}</TableCell>
            <TableCell>
              <AccessSourceChip source={share.target_user_id ? "Direct Share" : "Team Share"} />
            </TableCell>
            <TableCell>
              {share.capabilities.map((capability) => capability.replaceAll("_", " ")).join(", ")}
            </TableCell>
            <TableCell className="break-words">{share.created_by_label}</TableCell>
            <TableCell className="text-right">
              <DeleteShareButton
                actionScope={actionScope}
                agentName={agentName}
                shareId={share.id}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DeleteShareButton({
  actionScope,
  agentName,
  shareId,
}: {
  actionScope: AgentActionScope
  agentName: string
  shareId: string
}) {
  const action = deleteAgentShareFormAction.bind(null, actionScope, agentName)
  const [state, formAction, pending] = useActionState<AgentShareFormState, FormData>(action, {})

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-2">
      <input name="share_id" type="hidden" value={shareId} />
      <Button
        aria-label="Delete share"
        size="icon"
        type="submit"
        variant="ghost"
        disabled={pending}
      >
        {pending ? <Spinner /> : <Trash2 />}
      </Button>
      {state.error ? <span className="text-destructive text-xs">{state.error}</span> : null}
    </form>
  )
}

function FormError({ message, title }: { message: string; title: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
