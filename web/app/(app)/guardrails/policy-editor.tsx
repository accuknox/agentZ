"use client"

import { customAlphabet, nanoid } from "nanoid"
import { useId, useState, useTransition } from "react"
import { flushSync } from "react-dom"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronDown, CircleAlert, Plus, Regex, Save, BrickWallShield } from "lucide-react"
import { GuardrailProviderIcon } from "./provider-shared"
import { toast } from "sonner"
import type {
  GuardrailCheck,
  GuardrailConnection,
  GuardrailPolicy,
  GuardrailPolicyInput,
} from "@/lib/gateway/client"
import { saveGuardrailPolicyAction, type GuardrailActionScope } from "@/data/guardrail.actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LoadingButton } from "@/components/interior/loading-button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConnectionSheet } from "./connection-sheet"
import { CheckEditor } from "./check-editor"

type PolicyEditorProps = {
  policy?: GuardrailPolicy
  connections: GuardrailConnection[]
  scope: GuardrailActionScope
  basePath?: `/orgs/${string}/guardrails`
  onSaved?: (policy: GuardrailPolicy) => void
  onCancel?: () => void
  canCreateConnection: boolean
}

export function PolicyEditor(props: PolicyEditorProps) {
  const {
    policy,
    connections: initialConnections,
    scope,
    basePath,
    canCreateConnection,
    onSaved,
    onCancel,
  } = props

  const id = useId()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [draft, setDraft] = useState<GuardrailPolicyInput>(() => ({
    name: policy?.name ?? "",
    displayName: policy?.displayName ?? "",
    description: policy?.description ?? "",
    checks: policy?.checks ?? [],
  }))
  const [connections, setConnections] = useState(initialConnections)
  const [addingConnection, setAddingConnection] = useState(false)
  const [editingCheck, setEditingCheck] = useState<string | undefined>(
    policy?.checks.find((check) => check.id === searchParams.get("check"))?.id
  )
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState("")
  const [validationVisible, setValidationVisible] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const readOnly = policy !== undefined && !policy.canModify
  let title = "Add guardrail policy"
  if (policy) title = "Edit guardrail policy"
  if (readOnly) title = "Guardrail policy"

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function reorder({ active, over }: DragEndEvent) {
    if (readOnly || pending || !over || active.id === over.id) return
    setDraft((current) => {
      const from = current.checks.findIndex((check) => check.id === active.id)
      const to = current.checks.findIndex((check) => check.id === over.id)
      if (from < 0 || to < 0) return current
      return { ...current, checks: arrayMove(current.checks, from, to) }
    })
  }

  function close() {
    if (pending) return
    if (onCancel) {
      onCancel()
      return
    }
    if (basePath) router.push(`${basePath}/policies`)
  }

  function addCheck(connection?: GuardrailConnection) {
    // Bedrock can mistake trusted system instructions for prompt injection.
    const check: GuardrailCheck = {
      id: nanoid(),
      name: "",
      phase: "input",
      scopes:
        connection && connection.provider !== "Bedrock"
          ? ["instructions", "conversation"]
          : ["conversation"],
      mode: "enforce",
      failureMode: "closed",
      action: "deny",
      ...(connection
        ? { connection: { scope: connection.scope, name: connection.name } }
        : { regex: { patterns: [] } }),
    }
    setDraft({ ...draft, checks: [...draft.checks, check] })
    setEditingCheck(check.id)
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent size="half" className="h-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BrickWallShield aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {title}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Configure checks for model input and output.
          </SheetDescription>
          {policy?.mandatory || readOnly ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {readOnly ? <Badge variant="secondary">Read only</Badge> : null}
              {policy?.mandatory ? (
                <Badge variant="secondary">Required by the organization</Badge>
              ) : null}
            </div>
          ) : null}
        </SheetHeader>
        <form
          className="flex flex-1 flex-col gap-5 px-4 pb-2"
          id={`${id}-form`}
          onSubmit={(event) => {
            event.preventDefault()
            setError("")
            const incomplete = draft.checks.find((check) => {
              const connection = connections.find(
                (item) =>
                  item.scope === check.connection?.scope && item.name === check.connection.name
              )
              return (
                (connection?.provider === "Bedrock" &&
                  (!check.guardrailId || !check.guardrailVersion)) ||
                (connection?.provider === "ModelArmor" && !check.template)
              )
            })
            if (incomplete) {
              flushSync(() => {
                setValidationVisible(true)
                setEditingCheck(incomplete.id)
              })
              event.currentTarget
                .querySelector<HTMLButtonElement>('button[aria-invalid="true"]:not(:disabled)')
                ?.focus()
              return
            }
            startTransition(async () => {
              const checks = draft.checks.map((check) => {
                if (!check.regex) return check
                const patterns = check.regex.patterns?.filter((pattern) => pattern.trim() !== "")
                return { ...check, regex: { ...check.regex, patterns } }
              })
              const result = await saveGuardrailPolicyAction(
                scope,
                { ...draft, checks },
                policy !== undefined
              )
              if (result.error) {
                setError(result.error.message)
                return
              }
              toast.success("Policy saved")
              onSaved?.(result.data)
              if (basePath) router.push(`${basePath}/policies`)
              router.refresh()
            })
          }}
        >
          {policy?.status.state === "Error" && policy.status.message ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertTitle>Policy error</AlertTitle>
              <AlertDescription>{policy.status.message}</AlertDescription>
            </Alert>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${id}-display`} required>
              Name
            </FieldLabel>
            <Input
              disabled={readOnly || pending}
              id={`${id}-display`}
              maxLength={128}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  displayName: event.target.value,
                  name:
                    draft.name ||
                    `policy-${customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789")(16)}`,
                })
              }
              placeholder="Protect sensitive data"
              required
              value={draft.displayName}
            />
          </Field>
          <section>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                Checks
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {draft.checks.length}
                </span>
              </h2>
              {!readOnly ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      disabled={pending || draft.checks.length >= 16}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Plus /> Add check <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => addCheck()}>
                        <Regex /> Regex pattern
                      </DropdownMenuItem>
                      {connections.map((connection) => (
                        <DropdownMenuItem
                          key={`${connection.scope}/${connection.name}`}
                          onSelect={() => addCheck(connection)}
                        >
                          <GuardrailProviderIcon provider={connection.provider} />
                          {connection.displayName}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                    {canCreateConnection ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuItem onSelect={() => setAddingConnection(true)}>
                            <Plus /> New connection
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            {draft.checks.length ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragStart={() => flushSync(() => setEditingCheck(undefined))}
                onDragEnd={reorder}
              >
                <SortableContext
                  items={draft.checks.map((check) => check.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div>
                    {draft.checks.map((check, index) => (
                      <CheckEditor
                        reorderable={draft.checks.length > 1}
                        check={check}
                        connections={connections}
                        disabled={readOnly || pending}
                        expanded={editingCheck === check.id}
                        index={index}
                        scope={scope}
                        validationVisible={validationVisible}
                        key={check.id}
                        onExpandedChange={(open) => {
                          if (open) {
                            setEditingCheck(check.id)
                            return
                          }
                          setEditingCheck((current) => (current === check.id ? undefined : current))
                        }}
                        onChange={(value) => {
                          setDraft({
                            ...draft,
                            checks: draft.checks.map((item) =>
                              item.id === check.id ? value : item
                            ),
                          })
                        }}
                        onRemove={() => {
                          setDraft({
                            ...draft,
                            checks: draft.checks.filter((item) => item.id !== check.id),
                          })
                          setEditingCheck(undefined)
                        }}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <p className="rounded-lg border-2 border-dashed border-muted-foreground/50 p-4 text-center text-sm text-muted-foreground">
                No checks
              </p>
            )}
          </section>
          <Accordion
            collapsible
            type="single"
            value={detailsOpen ? "details" : ""}
            onValueChange={(value) => setDetailsOpen(value === "details")}
          >
            <AccordionItem value="details">
              <AccordionTrigger>Details</AccordionTrigger>
              <AccordionContent forceMount hidden={!detailsOpen}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
                    <Textarea
                      disabled={readOnly || pending}
                      id={`${id}-description`}
                      maxLength={2048}
                      onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                      rows={2}
                      value={draft.description ?? ""}
                    />
                  </Field>
                </FieldGroup>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertTitle>Policy not saved</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!readOnly ? (
            <div className="flex justify-end">
              <LoadingButton
                disabled={!draft.checks.length}
                pending={pending}
                pendingLabel="Saving..."
                type="submit"
              >
                <Save data-icon="inline-start" />
                {policy ? "Save changes" : "Add policy"}
              </LoadingButton>
            </div>
          ) : null}
        </form>
        {addingConnection ? (
          <ConnectionSheet
            scope={scope}
            onClose={() => setAddingConnection(false)}
            onSaved={(connection) => {
              setConnections((items) => [
                ...items.filter(
                  (item) => item.scope !== connection.scope || item.name !== connection.name
                ),
                connection,
              ])
              addCheck(connection)
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
