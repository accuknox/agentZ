"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { BrickWallShield, CircleAlert, GripVertical, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { GuardrailPolicy, GuardrailSettings } from "@/lib/gateway/client"
import { saveGuardrailSettingsAction } from "@/data/guardrail.actions"
import { LoadingButton } from "@/components/interior/loading-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"

type GuardrailOrganizationSettingsProps = {
  initial: GuardrailSettings
  policies: GuardrailPolicy[]
}

export function GuardrailOrganizationSettings(props: GuardrailOrganizationSettingsProps) {
  const { initial, policies } = props

  const id = useId()
  const router = useRouter()
  const [settings, setSettings] = useState(initial)
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()
  const organizationPolicies = policies.filter((policy) => policy.scope === "Organisation")
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function reorder({ active, over }: DragEndEvent) {
    if (pending || !over || active.id === over.id) return
    setSettings((current) => {
      const from = current.mandatoryPolicies.findIndex((name) => name === active.id)
      const to = current.mandatoryPolicies.findIndex((name) => name === over.id)
      if (from < 0 || to < 0) return current
      return {
        ...current,
        mandatoryPolicies: arrayMove(current.mandatoryPolicies, from, to),
      }
    })
  }

  return (
    <form
      className="flex max-w-4xl min-w-0 flex-col gap-8 px-4 pb-6 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        startTransition(async () => {
          const result = await saveGuardrailSettingsAction(settings)
          if (result.error) {
            setError(result.error.message)
            return
          }
          toast.success("Organization guardrail settings saved")
          router.refresh()
        })
      }}
    >
      <FieldSet className="gap-5">
        <FieldLegend className="font-semibold">Organization baseline</FieldLegend>
        <FieldDescription>
          Selected policies protect every managed request, including external applications and CLI
          agents. Workspaces cannot remove them.
        </FieldDescription>
        <MultiSelectDropdown
          aria-label="Organization baseline policies"
          disabled={pending}
          emptyMessage="No organization policies found."
          placeholder="Select baseline policies"
          searchPlaceholder="Search policies..."
          options={organizationPolicies.map((policy) => ({
            icon: BrickWallShield,
            label: policy.displayName,
            value: policy.name,
            badge: `${policy.checks.length} ${policy.checks.length === 1 ? "check" : "checks"}`,
            description: policy.description || undefined,
          }))}
          value={settings.mandatoryPolicies}
          onValueChangeAction={(selected) => {
            // The shared picker sorts selections; baseline execution order must stay intact.
            setSettings((current) => ({
              ...current,
              mandatoryPolicies: [
                ...current.mandatoryPolicies.filter((name) => selected.includes(name)),
                ...selected.filter((name) => !current.mandatoryPolicies.includes(name)),
              ],
            }))
          }}
        />
        {organizationPolicies.length === 0 ? (
          <FieldDescription>
            Create an organization policy before adding it to the required baseline.
          </FieldDescription>
        ) : null}
        {settings.mandatoryPolicies.length > 0 ? (
          <DndContext
            id={id}
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={reorder}
          >
            <SortableContext
              items={settings.mandatoryPolicies}
              strategy={verticalListSortingStrategy}
            >
              <ol aria-label="Baseline policy order" className="flex min-w-0 flex-col gap-1">
                {settings.mandatoryPolicies.map((name) => (
                  <SortablePolicy
                    key={name}
                    name={name}
                    policy={organizationPolicies.find((policy) => policy.name === name)}
                    disabled={pending}
                    reorderable={settings.mandatoryPolicies.length > 1}
                    onRemove={() => {
                      setSettings((current) => ({
                        ...current,
                        mandatoryPolicies: current.mandatoryPolicies.filter(
                          (policy) => policy !== name
                        ),
                      }))
                    }}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        ) : null}
      </FieldSet>
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Settings not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="-mx-4 flex w-[100cqw] justify-end border-t px-4 pt-6 md:-mx-6 md:px-6">
        <LoadingButton pending={pending} pendingLabel="Saving..." type="submit">
          <Save data-icon="inline-start" />
          Save settings
        </LoadingButton>
      </div>
    </form>
  )
}

function SortablePolicy({
  name,
  policy,
  disabled,
  reorderable,
  onRemove,
}: {
  name: string
  policy: GuardrailPolicy | undefined
  disabled: boolean
  reorderable: boolean
  onRemove: () => void
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, attributes, listeners } =
    useSortable({ id: name, disabled: disabled || !reorderable })
  const label = policy?.displayName ?? name

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted/50"
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="cursor-grab touch-none active:cursor-grabbing"
        disabled={disabled || !reorderable}
        aria-label={`Reorder ${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden />
      </Button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{name}</span>
          {policy ? (
            <>
              <span aria-hidden> · </span>
              <span className="tabular-nums">
                {policy.checks.length} {policy.checks.length === 1 ? "check" : "checks"}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="icon-sm"
        disabled={disabled}
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  )
}
