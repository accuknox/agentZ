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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
    description: "Full non-secret Agent and workflow control.",
  },
  {
    value: "share_non_authored",
    label: "Delegate sharing",
    description: "May share this Agent within delegated authority.",
  },
  {
    value: "read_shared_secret",
    label: "Read secret metadata",
    description: "Names, kinds, hosts, OAuth metadata, and status only.",
  },
  {
    value: "write_shared_secret",
    label: "Write secrets",
    description: "Create or update credential material without later reveal.",
  },
  {
    value: "delete_shared_secret",
    label: "Delete secrets",
    description: "Remove credential metadata and stored material.",
  },
] as const satisfies readonly {
  value: AgentShareCapability
  label: string
  description: string
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
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>
          <h3>Transfer ownership</h3>
        </CardTitle>
        <CardDescription>
          The recipient must be an active Organisation member with independent Workspace access and
          current Agent Author permission.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
              <FieldDescription>
                Only active members with independent Workspace access and Agent Author are listed.
                Ownership alone does not preserve access after a Role or membership change.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || owner === ownerUserId}>
              {pending ? <Spinner /> : <RefreshCw />}
              Transfer owner
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
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
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Current shares</h3>
          </CardTitle>
          <CardDescription>
            Direct and Team shares are intersected with current recipient Workspace eligibility on
            every request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgentSharesTable actionScope={actionScope} agentName={agentName} shares={shares} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Add or replace share</h3>
          </CardTitle>
          <CardDescription>
            UseShared grants full non-secret Agent and workflow control. Secret values are never
            readable through shared access.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                <div className="grid gap-3">
                  {capabilities.map((capability) => (
                    <label
                      className="hover:bg-muted/40 flex items-start gap-3 rounded-md border p-3"
                      key={capability.value}
                    >
                      <Checkbox name="capabilities" value={capability.value} />
                      <span className="grid gap-1">
                        <span className="font-medium">{capability.label}</span>
                        <span className="text-muted-foreground text-sm">
                          {capability.description}
                        </span>
                      </span>
                    </label>
                  ))}
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
        </CardContent>
      </Card>
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
      <div className="text-muted-foreground flex min-h-40 items-center justify-center rounded-md border text-sm">
        No shares
      </div>
    )
  }

  return (
    <Table aria-label={`${agentName} shares`}>
      <TableHeader>
        <TableRow>
          <TableHead>Target</TableHead>
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
              <div className="flex flex-wrap gap-1.5">
                {share.capabilities.map((capability) => (
                  <Badge key={capability} variant="outline">
                    {capability.replaceAll("_", " ")}
                  </Badge>
                ))}
              </div>
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
