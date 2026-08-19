"use client"

import { useActionState, useId, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  CircleAlert,
  KeyRound,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
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
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TokenTablePagination } from "@/components/table-pagination"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage, UserIdentity } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { DisabledReason } from "@/components/ui/tooltip"

const shareLayout: Record<string, AdminColumnLayout> = {
  target_label: { minWidth: 224, contentMaxWidth: 320 },
  source: { minWidth: 144, width: 144 },
  capabilities: { minWidth: 224, contentMaxWidth: 352 },
  created_by_label: { minWidth: 224, contentMaxWidth: 288 },
  actions: { minWidth: 64, width: 64, align: "end" },
}

const capabilityLabels = {
  use_shared: "Use shared Agent",
  share_non_authored: "Delegate sharing",
  read_shared_secret: "Read secret metadata",
  write_shared_secret: "Write secrets",
  delete_shared_secret: "Delete secrets",
} satisfies Record<AgentShareCapability, string>

const capabilityOptions = Object.entries(capabilityLabels).map(([value, label]) => ({
  icon: KeyRound,
  label,
  value,
}))

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
  const [state, formAction, pending] = useActionState<AgentOwnerFormState, FormData>(
    async (state, formData) => {
      const result = await transferAgentOwnerFormAction(actionScope, agentName, state, formData)
      if (result.success) toast.success("Agent owner updated")
      return result
    },
    {}
  )
  const [owner, setOwner] = useState("")
  const candidates = users.filter((user) => user.id !== ownerUserId)

  return (
    <section className="flex max-w-3xl min-w-0 flex-col gap-3">
      <h2 className="px-4 text-lg font-medium md:px-6">Transfer ownership</h2>
      <div className="border-b px-4 pb-6 md:px-6">
        <form action={formAction} className="flex flex-col gap-5">
          {state.error ? (
            <FormError title="Ownership was not transferred" message={state.error} />
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="owner-user-id" required>
                New owner
              </FieldLabel>
              <Select name="owner_user_id" value={owner} onValueChange={setOwner}>
                <SelectTrigger id="owner-user-id" className="w-full">
                  <SelectValue placeholder="Choose a new owner" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {candidates.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        <Avatar size="sm">
                          <AvatarImage alt="" src={user.image ?? undefined} />
                          <AvatarFallback>{user.label.slice(0, 1).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        {user.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            {pending || owner ? (
              <Button aria-busy={pending} type="submit" disabled={pending}>
                {pending ? <Spinner /> : <RefreshCw />}
                {pending ? "Transferring…" : "Transfer owner"}
              </Button>
            ) : (
              <DisabledReason reason="Choose a different eligible user to transfer ownership.">
                <Button type="submit" disabled>
                  <RefreshCw />
                  Transfer owner
                </Button>
              </DisabledReason>
            )}
          </div>
        </form>
      </div>
    </section>
  )
}

export function AgentShareDialog({
  actionScope,
  agentName,
  teams,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  teams: AgentShareTarget[]
  users: AgentShareTarget[]
}) {
  const [open, setOpen] = useState(false)
  const [flow, setFlow] = useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) setFlow((value) => value + 1)
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Share2 data-icon="inline-start" />
          Share agent
        </Button>
      </DialogTrigger>
      <AgentShareDialogForm
        actionScope={actionScope}
        agentName={agentName}
        key={flow}
        onSuccessAction={() => setOpen(false)}
        teams={teams}
        users={users}
      />
    </Dialog>
  )
}

function AgentShareDialogForm({
  actionScope,
  agentName,
  onSuccessAction,
  share,
  teams,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  onSuccessAction: () => void
  share?: AgentShareRow
  teams: AgentShareTarget[]
  users: AgentShareTarget[]
}) {
  const save = upsertAgentShareFormAction.bind(null, actionScope, agentName)
  const [state, formAction, pending] = useActionState<AgentShareFormState, FormData>(
    async (previousState, formData) => {
      const nextState = await save(previousState, formData)
      if (nextState.success) {
        toast.success(share ? "Agent access updated" : "Agent access added")
        onSuccessAction()
      }
      return nextState
    },
    {}
  )
  const formId = useId()
  const editing = Boolean(share)
  const [targetKind, setTargetKind] = useState(share?.target_user_id ? "user" : "team")
  const [targetId, setTargetId] = useState(share?.target_user_id ?? share?.target_team_id ?? "")
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>(
    share?.capabilities ?? []
  )
  const targets = targetKind === "user" ? users : teams
  const target = targets.find((candidate) => candidate.id === targetId)
  const allowedCapabilities = new Set<string>(target?.capabilities)
  const submitBlocker = !targetId
    ? `Choose a ${targetKind} before saving this share.`
    : selectedCapabilities.length === 0
      ? "Select at least one capability before saving this share."
      : undefined

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {editing ? "Edit" : "Share"} {agentName}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? "Change the capabilities granted by this share."
            : "Add access for a user or team. Saving replaces an existing share for the same target."}
        </DialogDescription>
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-5">
        {selectedCapabilities.map((capability) => (
          <input key={capability} name="capabilities" type="hidden" value={capability} />
        ))}
        <input name="target_kind" type="hidden" value={targetKind} />
        <input name="target_id" type="hidden" value={targetId} />
        {state.error ? <FormError title="Share was not saved" message={state.error} /> : null}
        <FieldGroup className="grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${formId}-target-kind`} required>
              Target type
            </FieldLabel>
            <Select
              disabled={editing}
              value={targetKind}
              onValueChange={(value) => {
                setTargetKind(value)
                setTargetId("")
                setSelectedCapabilities([])
              }}
            >
              <SelectTrigger id={`${formId}-target-kind`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="user">
                    <UserRound aria-hidden="true" />
                    User
                  </SelectItem>
                  <SelectItem value="team">
                    <UsersRound aria-hidden="true" />
                    Team
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-target-id`} required>
              Target
            </FieldLabel>
            <Select
              disabled={editing}
              value={targetId}
              onValueChange={(value) => {
                setTargetId(value)
                setSelectedCapabilities([])
              }}
            >
              <SelectTrigger id={`${formId}-target-id`} className="w-full">
                <SelectValue placeholder={`Choose a ${targetKind}`} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {targets.map((target) => (
                    <SelectItem
                      disabled={target.capabilities.length === 0}
                      key={target.id}
                      value={target.id}
                    >
                      {targetKind === "user" ? (
                        <Avatar size="sm">
                          <AvatarImage alt={target.label} src={target.image ?? undefined} />
                          <AvatarFallback>{target.label.slice(0, 1).toUpperCase()}</AvatarFallback>
                        </Avatar>
                      ) : (
                        <UsersRound aria-hidden="true" />
                      )}
                      <span className="truncate">{target.label}</span>
                      {target.capabilities.length === 0 ? (
                        <span className="text-muted-foreground">No eligible permissions</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${formId}-capabilities`} required>
              Capabilities
            </FieldLabel>
            {!target ? (
              <DisabledReason reason={`Choose a ${targetKind} before selecting capabilities.`}>
                <MultiSelectDropdown
                  emptyMessage="No capabilities available."
                  disabled
                  id={`${formId}-capabilities`}
                  onValueChangeAction={setSelectedCapabilities}
                  options={[]}
                  placeholder="Select capabilities"
                  searchPlaceholder="Search capabilities…"
                  value={selectedCapabilities}
                />
              </DisabledReason>
            ) : (
              <MultiSelectDropdown
                emptyMessage="No capabilities available."
                id={`${formId}-capabilities`}
                onValueChangeAction={setSelectedCapabilities}
                options={capabilityOptions.filter((option) =>
                  allowedCapabilities.has(option.value)
                )}
                placeholder="Select capabilities"
                searchPlaceholder="Search capabilities…"
                value={selectedCapabilities}
              />
            )}
            <FieldDescription>
              Only capabilities backed by the target&apos;s effective Workspace permissions are
              available.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          {submitBlocker && !pending ? (
            <DisabledReason reason={submitBlocker}>
              <Button data-dialog-submit disabled type="submit">
                <Share2 data-icon="inline-start" />
                {editing ? "Save changes" : "Save share"}
              </Button>
            </DisabledReason>
          ) : (
            <Button aria-busy={pending} data-dialog-submit disabled={pending} type="submit">
              {pending ? <Spinner /> : <Share2 data-icon="inline-start" />}
              {pending ? "Saving…" : editing ? "Save changes" : "Save share"}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

export function AgentSharesTable({
  actionScope,
  agentName,
  nextPageToken,
  shares,
  teams,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  nextPageToken: string
  shares: AgentShareRow[]
  teams: AgentShareTarget[]
  users: AgentShareTarget[]
}) {
  "use no memo"

  const columns = useMemo<ColumnDef<AgentShareRow>[]>(
    () => [
      {
        accessorKey: "target_label",
        header: "Target",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar>
              {row.original.target_user_id ? (
                <AvatarImage alt={row.original.target_label} src={row.original.target_image} />
              ) : null}
              <AvatarFallback>
                {row.original.target_user_id ? (
                  row.original.target_label.slice(0, 1).toUpperCase()
                ) : (
                  <UsersRound aria-hidden className="size-4" />
                )}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate font-medium" title={row.original.target_label}>
                {row.original.target_label}
              </div>
              {row.original.target_email ? (
                <div
                  className="text-muted-foreground truncate text-xs"
                  title={row.original.target_email}
                >
                  {row.original.target_email}
                </div>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: "source",
        header: "Source",
        cell: ({ row }) => (
          <AccessSourceChip source={row.original.target_user_id ? "Direct Share" : "Team Share"} />
        ),
      },
      {
        accessorKey: "capabilities",
        header: "Capabilities",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.capabilities.map((capability) => (
              <Badge key={capability} variant="secondary">
                {capabilityLabels[capability]}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        accessorKey: "created_by_label",
        header: "Created by",
        cell: ({ row }) => (
          <UserIdentity
            email={row.original.created_by_email}
            image={row.original.created_by_image}
            name={row.original.created_by_label}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <AgentShareActions
            actionScope={actionScope}
            agentName={agentName}
            share={row.original}
            teams={teams}
            users={users}
          />
        ),
      },
    ],
    [actionScope, agentName, teams, users]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: shares,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  return (
    <AdminDataGrid
      ariaLabel={`${agentName} shares`}
      emptyState={<p className="text-muted-foreground py-8 text-center">No shares found.</p>}
      layout={shareLayout}
      pagination={
        <TokenTablePagination hasNextPage={Boolean(nextPageToken)} nextPageToken={nextPageToken} />
      }
      rows={shares}
      table={table}
    />
  )
}

function AgentShareActions({
  actionScope,
  agentName,
  share,
  teams,
  users,
}: {
  actionScope: AgentActionScope
  agentName: string
  share: AgentShareRow
  teams: AgentShareTarget[]
  users: AgentShareTarget[]
}) {
  const [state, formAction, pending] = useActionState<AgentShareFormState, FormData>(
    async (state, formData) => {
      const result = await deleteAgentShareFormAction(actionScope, agentName, state, formData)
      if (result.success) toast.success("Agent access removed")
      return result
    },
    {}
  )
  const formId = useId()
  const [editOpen, setEditOpen] = useState(false)
  const targetExists = share.target_user_id
    ? users.some((user) => user.id === share.target_user_id)
    : teams.some((team) => team.id === share.target_team_id)

  return (
    <div className="flex flex-col items-end gap-2">
      <form action={formAction} id={formId}>
        <input name="share_id" type="hidden" value={share.id} />
      </form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="Share actions" disabled={pending} size="icon" variant="ghost">
            {pending ? <Spinner /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {targetExists ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  setEditOpen(true)
                }}
              >
                <Pencil />
                Edit share
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild variant="destructive">
              <button form={formId} type="submit">
                <Trash2 />
                Remove share
              </button>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <AgentShareDialogForm
          actionScope={actionScope}
          agentName={agentName}
          onSuccessAction={() => setEditOpen(false)}
          share={share}
          teams={teams}
          users={users}
        />
      </Dialog>
      {state.error ? <span className="text-destructive text-xs">{state.error}</span> : null}
    </div>
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
