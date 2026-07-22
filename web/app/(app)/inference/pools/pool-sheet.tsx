"use client"

import * as React from "react"
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
import { zodResolver } from "@hookform/resolvers/zod"
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  GripVertical,
  Layers3,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { Controller, useFieldArray, useForm, useWatch, type UseFormReturn } from "react-hook-form"
import { toast } from "sonner"
import * as z from "zod"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { getInferencePoolUsageAction, saveInferencePoolAction } from "@/data/inference-pool.actions"
import { formatCompactNumber } from "@/lib/format"
import type {
  InferenceModel,
  InferencePool,
  InferencePoolMember,
  InferencePoolWrite,
  InferenceProvider,
} from "@/lib/gateway/client"
import { ProviderIcon, providerKindLabels } from "../providers/provider-shared"

const poolMemberSchema = z.object({
  provider: z
    .string({ error: "Choose a provider for this member" })
    .min(1, { message: "Choose a provider for this member" })
    .max(63, { message: "Choose a valid provider" }),
  model: z
    .string({ error: "Choose a model for this member" })
    .min(1, { message: "Choose a model for this member" })
    .max(512, { message: "Model names must be 512 characters or fewer" }),
})

const poolSchema = z
  .object({
    display_name: z
      .string({ error: "Enter a name for this Pool" })
      .min(1, { message: "Enter a name for this Pool" })
      .max(128, { message: "Pool names must be 128 characters or fewer" })
      .refine((name) => name.trim().length > 0, {
        message: "Enter a name for this Pool",
      }),
    automatic_failover: z.boolean({
      error: "Choose whether this Pool should switch to a backup automatically",
    }),
    members: z
      .array(poolMemberSchema, { error: "Add at least one model to this Pool" })
      .min(1, { message: "Add at least one model to this Pool" })
      .max(8, { message: "A Pool can have up to 8 models" }),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.members.forEach((member, index) => {
      const key = `${member.provider}\u0000${member.model}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", index, "model"],
          message: "This provider-model pair is already in the Pool",
        })
      }
      seen.add(key)
    })
  })

const blankMember: InferencePoolMember = { provider: "", model: "" }

export function NewInferencePoolButton({ providers }: { providers: InferenceProvider[] }) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New pool
      </Button>
      <PoolSheet
        key={open ? "new" : "closed"}
        open={open}
        providers={providers}
        onOpenChange={setOpen}
      />
    </>
  )
}

export function PoolSheet({
  pool,
  providers,
  open,
  onOpenChange,
}: {
  pool?: InferencePool
  providers: InferenceProvider[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const defaults: InferencePoolWrite = pool
    ? {
        display_name: pool.display_name,
        automatic_failover: pool.automatic_failover,
        members: pool.members,
      }
    : { display_name: "", automatic_failover: true, members: [blankMember] }
  const form = useForm<InferencePoolWrite>({
    defaultValues: defaults,
    mode: "onSubmit",
    reValidateMode: "onBlur",
    resolver: zodResolver(poolSchema),
  })
  const members = useFieldArray({ control: form.control, name: "members", keyName: "key" })
  const memberValues = useWatch({
    control: form.control,
    name: "members",
    defaultValue: defaults.members,
  })
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const [submitError, setSubmitError] = React.useState("")
  const [submitDetails, setSubmitDetails] = React.useState<string[]>([])
  const [impact, setImpact] = React.useState<{
    values: InferencePoolWrite
    sandboxes: string[]
  }>()
  const [pending, startTransition] = React.useTransition()

  const selected = memberValues.map((member) => {
    const provider = providers.find((candidate) => candidate.id === member.provider)
    const model = provider?.models.find((candidate) => candidate.id === member.model)
    return { provider, model }
  })
  const models: InferenceModel[] = []
  for (const item of selected) {
    if (!item.model) {
      models.length = 0
      break
    }
    models.push(item.model)
  }
  let contract:
    | {
        capabilities: InferenceModel["capabilities"]
        modalities: InferenceModel["modalities"]
        limits: InferenceModel["limits"]
      }
    | undefined
  const first = models[0]
  if (first && models.length === selected.length) {
    contract = {
      capabilities: {
        attachment: models.every((model) => model.capabilities.attachment),
        reasoning: models.every((model) => model.capabilities.reasoning),
        temperature: models.every((model) => model.capabilities.temperature),
        tool_call: models.every((model) => model.capabilities.tool_call),
      },
      modalities: {
        input: first.modalities.input.filter((modality) =>
          models.every((model) => model.modalities.input.includes(modality))
        ),
        output: first.modalities.output.filter((modality) =>
          models.every((model) => model.modalities.output.includes(modality))
        ),
      },
      limits: {
        context: Math.min(...models.map((model) => model.limits.context)),
        input: Math.min(...models.map((model) => model.limits.input ?? model.limits.context)),
        output: Math.min(...models.map((model) => model.limits.output)),
      },
    }
  }
  const protocols = new Set(
    selected.flatMap(({ provider }) => {
      if (!provider) return []
      return [
        provider.kind === "Anthropic" || provider.kind === "AnthropicCompatible"
          ? "Anthropic"
          : "OpenAI",
      ]
    })
  )

  function reorder(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    const from = members.fields.findIndex((member) => member.key === event.active.id)
    const to = members.fields.findIndex((member) => member.key === event.over?.id)
    if (from < 0 || to < 0) return
    members.replace(arrayMove(form.getValues("members"), from, to))
  }

  function save(input: InferencePoolWrite) {
    setSubmitError("")
    setSubmitDetails([])
    startTransition(async () => {
      const result = pool
        ? await saveInferencePoolAction({
            poolName: pool.id,
            resourceVersion: pool.resource_version,
            pool: input,
          })
        : await saveInferencePoolAction({ pool: input })
      if (result.error) {
        setSubmitError(result.error.message)
        setSubmitDetails(
          result.error.errors?.map((error) => `${error.field}: ${error.message}`) ?? []
        )
        return
      }
      toast.success(pool ? "Inference Pool updated" : "Inference Pool created")
      onOpenChange(false)
    })
  }

  function submit(input: InferencePoolWrite) {
    if (
      !pool ||
      (pool.automatic_failover === input.automatic_failover &&
        JSON.stringify(pool.members) === JSON.stringify(input.members))
    ) {
      save(input)
      return
    }

    startTransition(async () => {
      const result = await getInferencePoolUsageAction(pool.id)
      if (result.error) {
        setSubmitError(result.error.message)
        return
      }
      if (!result.usage || result.usage.sandboxes.length === 0) {
        save(input)
        return
      }
      setImpact({ values: input, sandboxes: result.usage.sandboxes })
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="h-full overflow-hidden sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <Layers3 className="size-4" />
            {pool ? "Edit Pool" : "New Pool"}
          </SheetTitle>
          <SheetDescription>
            Choose a primary model and the backups to use if it becomes unavailable.
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={form.handleSubmit(submit)}>
          <div className="flex-1 space-y-7 overflow-y-auto px-4 pb-4">
            <FieldGroup>
              <Field data-invalid={Boolean(form.formState.errors.display_name)}>
                <FieldLabel htmlFor="pool-display-name" required>
                  Name
                </FieldLabel>
                <Input
                  id="pool-display-name"
                  aria-invalid={Boolean(form.formState.errors.display_name)}
                  {...form.register("display_name")}
                />
                <FieldError errors={[form.formState.errors.display_name]} />
              </Field>
              <Controller
                control={form.control}
                name="automatic_failover"
                render={({ field, fieldState }) => (
                  <Field orientation="horizontal" data-invalid={fieldState.invalid}>
                    <div>
                      <FieldLabel>Automatic failover</FieldLabel>
                      <FieldDescription>
                        If a model keeps failing, new requests use the next model until it recovers.
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </div>
                    <Switch
                      checked={field.value}
                      aria-invalid={fieldState.invalid}
                      onBlur={field.onBlur}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                )}
              />
            </FieldGroup>

            <section className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium">Members</h2>
                  <p className="text-muted-foreground text-sm">
                    The first model is preferred. Drag to arrange its backups.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={members.fields.length >= 8}
                  onClick={() => members.append(blankMember)}
                >
                  <Plus /> Add member
                </Button>
              </div>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={reorder}
              >
                <SortableContext
                  items={members.fields.map((member) => member.key)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {members.fields.map((member, index) => (
                      <SortableMember
                        key={member.key}
                        id={member.key}
                        index={index}
                        form={form}
                        providers={providers}
                        removable={members.fields.length > 1}
                        remove={() => members.remove(index)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              <FieldError errors={[form.formState.errors.members]} />
            </section>

            {protocols.size > 1 ? (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertTitle>These models use different API formats</AlertTitle>
                <AlertDescription>
                  Basic prompts will work, but provider-specific features may not carry over when
                  this Pool switches models.
                </AlertDescription>
              </Alert>
            ) : null}

            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-medium">Pool Contract</h2>
                <p className="text-muted-foreground text-sm">
                  What every model in this Pool can handle.
                </p>
              </div>
              {contract ? (
                <div className="bg-muted/30 grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                  <ContractDetail
                    label="Capabilities"
                    value={
                      Object.entries(contract.capabilities)
                        .filter(([, enabled]) => enabled)
                        .map(([name]) => name.replace("_", " "))
                        .join(", ") || "Text generation only"
                    }
                  />
                  <ContractDetail
                    label="Input modalities"
                    value={contract.modalities.input.join(", ")}
                  />
                  <ContractDetail
                    label="Output modalities"
                    value={contract.modalities.output.join(", ")}
                  />
                  <ContractDetail
                    label="Token limits"
                    value={`${formatCompactNumber(contract.limits.context)} context · ${formatCompactNumber(contract.limits.input ?? contract.limits.context)} input · ${formatCompactNumber(contract.limits.output)} output`}
                  />
                </div>
              ) : (
                <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                  Choose a provider and model in every row to see their shared support.
                </p>
              )}
            </section>

            {submitError ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>{submitError}</AlertTitle>
                {submitDetails.length ? (
                  <AlertDescription>{submitDetails.join("\n")}</AlertDescription>
                ) : null}
              </Alert>
            ) : null}
          </div>
          <SheetFooter className="border-t">
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}
                {pool ? "Save changes" : "Create Pool"}
              </Button>
            </div>
          </SheetFooter>
        </form>
        <Dialog open={Boolean(impact)} onOpenChange={(next) => !next && setImpact(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Update a Pool used by Sandboxes?</DialogTitle>
              <DialogDescription>
                Changing the models, their order, or failover setting changes where requests go.
                Agents using these Sandboxes will pick up the change automatically.
              </DialogDescription>
            </DialogHeader>
            {impact ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">Affected Sandboxes</p>
                <p className="text-muted-foreground">{impact.sandboxes.join(", ")}</p>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setImpact(undefined)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!impact) return
                  const values = impact.values
                  setImpact(undefined)
                  save(values)
                }}
              >
                Update Pool
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}

/* eslint-disable react-hooks/refs -- @dnd-kit exposes node refs and transform state during render. */
function SortableMember({
  id,
  index,
  form,
  providers,
  removable,
  remove,
}: {
  id: string
  index: number
  form: UseFormReturn<InferencePoolWrite>
  providers: InferenceProvider[]
  removable: boolean
  remove: () => void
}) {
  const sortable = useSortable({ id })
  const member = useWatch({ control: form.control, name: `members.${index}` })
  const provider = providers.find((candidate) => candidate.id === member.provider)

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className="bg-background grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 rounded-lg border p-3 shadow-xs"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="mt-6 cursor-grab touch-none active:cursor-grabbing"
        aria-label={`Reorder member ${index + 1}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical />
      </Button>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Controller
          control={form.control}
          name={`members.${index}.provider`}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel>Provider {index + 1}</FieldLabel>
              <MemberPicker
                value={field.value}
                placeholder="Choose a provider"
                items={providers.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.display_name,
                  detail:
                    candidate.state === "Ready"
                      ? providerKindLabels[candidate.kind]
                      : `${candidate.state} · unavailable`,
                  disabled: candidate.state !== "Ready",
                  icon: <ProviderIcon provider={candidate.catalog_provider} className="size-4" />,
                }))}
                onBlur={field.onBlur}
                onChange={(value) => {
                  field.onChange(value)
                  form.setValue(`members.${index}.model`, "", {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name={`members.${index}.model`}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel>Model</FieldLabel>
              <MemberPicker
                value={field.value}
                placeholder={provider ? "Choose a model" : "Choose a provider first"}
                disabled={!provider}
                items={(provider?.models ?? []).map((model) => {
                  const supportsText =
                    model.modalities.input.includes("text") &&
                    model.modalities.output.includes("text")
                  return {
                    value: model.id,
                    label: model.display_name,
                    detail: supportsText ? model.id : `${model.id} · text is not supported`,
                    disabled: !supportsText,
                  }
                })}
                onBlur={field.onBlur}
                onChange={field.onChange}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </div>
      <Button
        type="button"
        variant="destructive"
        size="icon-sm"
        className="mt-6"
        aria-label={`Remove member ${index + 1}`}
        disabled={!removable}
        onClick={remove}
      >
        <Trash2 />
      </Button>
    </div>
  )
}
/* eslint-enable react-hooks/refs */

function MemberPicker({
  value,
  placeholder,
  items,
  disabled,
  onBlur,
  onChange,
}: {
  value: string
  placeholder: string
  items: Array<{
    value: string
    label: string
    detail: string
    disabled?: boolean
    icon?: React.ReactNode
  }>
  disabled?: boolean
  onBlur?: () => void
  onChange: (value: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selected = items.find((item) => item.value === value)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onBlur?.()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          className="min-w-0 justify-between font-normal"
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={`${item.label} ${item.detail} ${item.value}`}
                  disabled={item.disabled}
                  onSelect={() => {
                    onChange(item.value)
                    setOpen(false)
                  }}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {item.detail}
                    </span>
                  </span>
                  {item.value === value ? <Check className="size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ContractDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  )
}
