"use client"

import type { ColumnDef, PaginationState, SortingState } from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { zodResolver } from "@hookform/resolvers/zod"
import { defineStepper } from "@stepperize/react"
import {
  ArrowUpDown,
  ArrowLeft,
  ArrowRight,
  Box,
  Globe2,
  Link2,
  PackageSearch as PackageSearchIcon,
  Plus,
  X,
} from "lucide-react"
import * as React from "react"
import { startTransition, useActionState, useState } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { dayjs } from "@/lib/dayjs"
import { WizardShell } from "@/components/blocks/wizard"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  createEnvironmentFormAction,
  updateEnvironmentFormAction,
} from "@/data/environment.actions"
import * as z from "zod"
import { environmentAllowedHostSchema, environmentNameSchema } from "@/data/schema"
import type { McpConnection } from "@/lib/gateway/client"
import { authModeOf } from "@/lib/mcp"
import { findMcpServerByURL, mcpFallbackIcon } from "@/app/mcps/catalog"
import { PackageSearch } from "./package-search"

type EnvironmentWizardMode = "create" | "update"

type EnvironmentIdentity = {
  name: string
}

type EnvironmentWizardData = {
  identity?: EnvironmentIdentity
  packages?: string[]
  mcps?: string[]
}

type EnvironmentWizardProps = {
  initialName?: string
  initialAllowedHosts?: string[]
  initialMcpConnectionRefs?: string[]
  initialPackages?: string[]
  mcpConnections: McpConnection[]
  mode: EnvironmentWizardMode
}

type PackageStepProps = {
  initialPackages: string[]
  onPrev: () => void
  onNext: (packages: string[]) => void
}

type AllowedHostsStepProps = {
  identity: EnvironmentIdentity
  initialAllowedHosts: string[]
  mcpConnectionRefs: string[]
  packages: string[]
  mode: EnvironmentWizardMode
  onPrev: () => void
}

type McpStepProps = {
  initialMcpConnectionRefs: string[]
  mcpConnections: McpConnection[]
  onNext: (mcpConnectionRefs: string[]) => void
  onPrev: () => void
}

type McpStepValues = {
  mcpConnectionRefs: string[]
}

const identitySchema = z.object({
  name: environmentNameSchema,
})

const allowedHostsStepSchema = z.object({
  allowedHosts: z
    .array(environmentAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})

type PackageStepValues = {
  packages: string[]
}

type AllowedHostsStepValues = z.infer<typeof allowedHostsStepSchema>

const mcpColumnClassName: Record<string, string> = {
  name: "w-40",
  auth_mode: "w-32",
  endpoint: "min-w-0 w-0",
  age: "w-28",
  attach: "w-14",
}

const defaultMcpSorting: SortingState = [{ id: "age", desc: true }]
const defaultMcpPagination: PaginationState = { pageIndex: 0, pageSize: 10 }

const steps = [
  {
    id: "identity",
    title: "Identity",
    icon: Box,
  },
  {
    id: "packages",
    title: "Packages",
    icon: PackageSearchIcon,
  },
  {
    id: "mcps",
    title: "MCP",
    icon: Link2,
  },
  {
    id: "allowedHosts",
    title: "Allowed hosts",
    icon: Globe2,
  },
] as const

const { Stepper } = defineStepper(...steps)

const canVisitStep = (index: number, currentIndex: number, data: EnvironmentWizardData) => {
  if (index <= currentIndex) return true
  return Boolean(data.identity)
}

function IdentityForm({
  defaultValues,
  lockName,
  onNext,
}: {
  defaultValues: EnvironmentIdentity
  lockName: boolean
  onNext: (data: EnvironmentIdentity) => void
}) {
  const form = useForm<EnvironmentIdentity>({
    resolver: zodResolver(identitySchema),
    defaultValues,
  })

  return (
    <form
      id="environment-form-identity"
      onSubmit={form.handleSubmit(onNext)}
      className="flex min-h-full flex-col gap-5"
    >
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid} data-disabled={lockName}>
              <FieldLabel htmlFor="environment-form-name">Name</FieldLabel>
              <Input
                id="environment-form-name"
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={field.onChange}
                disabled={lockName}
                readOnly={lockName}
                autoComplete="off"
                placeholder="my-environment"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                {lockName
                  ? "Environment name cannot be changed."
                  : "Lowercase letters, numbers, and hyphens only. Max 32 characters."}
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <StepActions>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function PackageStep({ initialPackages, onNext, onPrev }: PackageStepProps) {
  const form = useForm<PackageStepValues>({
    defaultValues: {
      packages: initialPackages,
    },
  })
  const selected = useWatch({
    control: form.control,
    name: "packages",
    defaultValue: initialPackages,
  })

  return (
    <form
      onSubmit={form.handleSubmit((data) => onNext(data.packages))}
      className="flex min-h-full flex-col gap-5"
    >
      <PackageSearch
        installed={initialPackages}
        selected={selected}
        onSelectedChangeAction={(packages) =>
          form.setValue("packages", packages, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
      />
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          Previous
        </Button>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function McpNameCell({ connection }: { connection: McpConnection }) {
  const server = findMcpServerByURL(connection.endpoint.url)
  const Icon = server?.icon ?? mcpFallbackIcon

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{connection.name}</span>
    </div>
  )
}

function formatAge(value: string) {
  const d = dayjs(value)
  if (!d.isValid()) {
    return "Unknown"
  }

  return d.fromNow()
}

function createMcpSelectionColumns({
  selectedNames,
  onCheckedChange,
}: {
  selectedNames: ReadonlySet<string>
  onCheckedChange: (name: string, checked: boolean) => void
}): ColumnDef<McpConnection>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <McpNameCell connection={row.original} />,
    },
    {
      id: "auth_mode",
      header: "Auth type",
      accessorFn: (row) => authModeOf(row),
      cell: ({ row }) => <span className="capitalize">{authModeOf(row.original)}</span>,
    },
    {
      id: "endpoint",
      header: "Endpoint",
      accessorFn: (row) => row.endpoint.url,
      cell: ({ row }) => (
        <span
          className="text-muted-foreground block min-w-0 truncate"
          title={row.original.endpoint.url}
        >
          {row.original.endpoint.url}
        </span>
      ),
    },
    {
      id: "age",
      accessorKey: "created_at",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Age
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => formatAge(row.original.created_at),
    },
    {
      id: "attach",
      header: "",
      accessorFn: (row) => selectedNames.has(row.name),
      cell: ({ row }) => {
        const name = row.original.name

        return (
          <div className="flex justify-end">
            <Switch
              checked={selectedNames.has(name)}
              aria-label={`Attach ${name}`}
              onCheckedChange={(checked) => onCheckedChange(name, checked)}
            />
          </div>
        )
      },
    },
  ]
}

function McpStep({ initialMcpConnectionRefs, mcpConnections, onNext, onPrev }: McpStepProps) {
  const form = useForm<McpStepValues>({
    defaultValues: {
      mcpConnectionRefs: initialMcpConnectionRefs,
    },
  })
  const watchedSelected = useWatch({
    control: form.control,
    name: "mcpConnectionRefs",
    defaultValue: initialMcpConnectionRefs,
  })
  const selected = React.useMemo(() => watchedSelected ?? [], [watchedSelected])
  const selectedNames = React.useMemo(() => new Set(selected), [selected])
  const connections = React.useMemo(
    () => mcpConnections.toSorted((a, b) => a.name.localeCompare(b.name)),
    [mcpConnections]
  )
  const [sorting, setSorting] = React.useState<SortingState>(defaultMcpSorting)
  const [pagination, setPagination] = React.useState<PaginationState>(defaultMcpPagination)
  const setSelected = React.useCallback(
    (name: string, checked: boolean) => {
      const current = form.getValues("mcpConnectionRefs") ?? []
      const next = new Set(current)

      if (checked) {
        next.add(name)
      } else {
        next.delete(name)
      }

      const nextRefs = Array.from(next).toSorted((a, b) => a.localeCompare(b))
      if (
        current.length === nextRefs.length &&
        current.every((value, index) => value === nextRefs[index])
      ) {
        return
      }

      form.setValue("mcpConnectionRefs", nextRefs, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [form]
  )

  const columns = React.useMemo(
    () =>
      createMcpSelectionColumns({
        selectedNames,
        onCheckedChange: setSelected,
      }),
    [selectedNames, setSelected]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: connections,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    state: {
      pagination,
      sorting,
    },
  })

  return (
    <form
      onSubmit={form.handleSubmit((data) =>
        onNext(data.mcpConnectionRefs.toSorted((a, b) => a.localeCompare(b)))
      )}
      className="flex min-h-full flex-col gap-5"
    >
      <div className="-mx-4 -mt-4 min-w-0 space-y-4 sm:-mx-6 sm:-mt-6">
        <div className="w-full min-w-0 overflow-hidden border-b">
          <Table className="table-auto">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={`h-8 ${mcpColumnClassName[header.column.id] ?? "px-4"}`}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length > 0 ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={`h-11 py-2 align-middle ${mcpColumnClassName[cell.column.id] ?? "px-4"}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    No MCP connections
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2 px-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            type="button"
          >
            <ArrowLeft data-icon="inline-start" />
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            type="button"
          >
            Next
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          Previous
        </Button>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function AllowedHostsStep({
  identity,
  initialAllowedHosts,
  mcpConnectionRefs,
  packages,
  mode,
  onPrev,
}: AllowedHostsStepProps) {
  const [draft, setDraft] = React.useState("")
  const [draftError, setDraftError] = React.useState<string>()
  const formAction =
    mode === "update"
      ? updateEnvironmentFormAction.bind(null, identity.name)
      : createEnvironmentFormAction
  const [state, action, pending] = useActionState(formAction, {})
  const form = useForm<AllowedHostsStepValues>({
    resolver: zodResolver(allowedHostsStepSchema),
    defaultValues: {
      allowedHosts: initialAllowedHosts,
    },
  })
  const submitLabel = mode === "update" ? "Update environment" : "Create environment"
  const pendingLabel = mode === "update" ? "Updating..." : "Creating..."
  const hosts = useWatch({
    control: form.control,
    name: "allowedHosts",
    defaultValue: initialAllowedHosts,
  })
  const allowedHostsError = form.formState.errors.allowedHosts
  const hostFieldInvalid = Boolean(allowedHostsError) || Boolean(draftError)
  const generalError =
    state.error && !state.error.errors?.some((error) => error.field === "allowedHosts")
      ? state.error
      : undefined

  React.useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const error of state.error.errors) {
      if (error.field === "allowedHosts") {
        form.setError("allowedHosts", {
          type: "server",
          message: error.message,
        })
      }
    }
  }, [form, state.error])

  function setHosts(hosts: string[]) {
    form.setValue("allowedHosts", hosts, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  function addHost() {
    const parsed = environmentAllowedHostSchema.safeParse(draft)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? "Host is invalid")
      return
    }

    const nextHosts = Array.from(new Set([...hosts, parsed.data])).sort()
    setHosts(nextHosts)
    setDraft("")
    setDraftError(undefined)
    form.clearErrors("allowedHosts")
  }

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    if (draft.trim() !== "") {
      setDraftError("Add or clear the host before submitting")
      return
    }

    startTransition(() => {
      action(formData)
    })
  }

  return (
    <form action={submitAction} className="flex min-h-full flex-col gap-5">
      <input type="hidden" name="name" value={identity.name} />
      {packages.map((pkg) => (
        <input key={pkg} type="hidden" name="packages" value={pkg} />
      ))}
      {mcpConnectionRefs.map((name) => (
        <input key={name} type="hidden" name="mcpConnectionRefs" value={name} />
      ))}
      {hosts.map((host) => (
        <input key={host} type="hidden" name="allowedHosts" value={host} />
      ))}
      <FieldSet>
        <FieldLegend>Allowed hosts</FieldLegend>
        <FieldDescription>
          Exact domains, leading wildcard domains, and IPv4 or IPv6 CIDR ranges.
        </FieldDescription>
        <FieldGroup>
          <Field data-invalid={hostFieldInvalid}>
            <FieldLabel htmlFor="environment-form-allowed-host">Host</FieldLabel>
            <InputGroup className="h-9">
              <InputGroupInput
                id="environment-form-allowed-host"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setDraftError(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addHost()
                }}
                placeholder="api.github.com"
                autoComplete="off"
                aria-invalid={hostFieldInvalid}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={addHost} aria-label="Add allowed host">
                  <Plus />
                  Add
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          {hosts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {hosts.map((host) => (
                <Button
                  key={host}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setHosts(hosts.filter((item) => item !== host))}
                >
                  {host}
                  <X data-icon="inline-end" />
                </Button>
              ))}
            </div>
          ) : null}
          {draftError ? <FieldError errors={[{ message: draftError }]} /> : null}
          {allowedHostsError ? <FieldError errors={[allowedHostsError]} /> : null}
        </FieldGroup>
      </FieldSet>
      {generalError ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded border p-3 text-sm"
        >
          <p className="font-medium">{generalError.message}</p>
          {generalError.errors && generalError.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {generalError.errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  {error.field}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev} disabled={pending}>
          Previous
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </StepActions>
    </form>
  )
}

function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex flex-wrap justify-end gap-3 pt-4">{children}</div>
}

export function EnvironmentWizard({
  initialAllowedHosts = [],
  initialMcpConnectionRefs = [],
  initialName = "",
  initialPackages = [],
  mcpConnections,
  mode,
}: EnvironmentWizardProps) {
  const [direction, setDirection] = useState(1)
  const initialIdentity = { name: initialName }

  return (
    <Stepper.Root
      className="flex min-h-0 w-full flex-1"
      initialMetadata={{
        identity: initialName ? initialIdentity : undefined,
        packages: initialPackages,
        mcps: initialMcpConnectionRefs,
      }}
      orientation="horizontal"
    >
      {({ stepper }) => {
        const data: EnvironmentWizardData = {
          identity: stepper.metadata.get("identity") as EnvironmentIdentity | undefined,
          packages: stepper.metadata.get("packages") as string[] | undefined,
          mcps: stepper.metadata.get("mcps") as string[] | undefined,
        }
        const goPrev = () => {
          setDirection(-1)
          stepper.navigation.prev()
        }
        const goNext = () => {
          setDirection(1)
          stepper.navigation.next()
        }

        return (
          <WizardShell
            steps={steps}
            currentIndex={stepper.state.current.index}
            currentStepId={stepper.state.current.data.id}
            direction={direction}
            layout="horizontal"
            canVisitStepAction={(_, index) =>
              canVisitStep(index, stepper.state.current.index, data)
            }
            onStepSelectAction={(step, index) => {
              setDirection(index >= stepper.state.current.index ? 1 : -1)
              stepper.navigation.goTo(step.id)
            }}
          >
            {stepper.flow.switch({
              identity: () => (
                <IdentityForm
                  defaultValues={data.identity ?? initialIdentity}
                  lockName={mode === "update"}
                  onNext={(identity) => {
                    stepper.metadata.set("identity", identity)
                    goNext()
                  }}
                />
              ),
              packages: () => (
                <PackageStep
                  initialPackages={data.packages ?? initialPackages}
                  onPrev={goPrev}
                  onNext={(packages) => {
                    stepper.metadata.set("packages", packages)
                    goNext()
                  }}
                />
              ),
              mcps: () => (
                <McpStep
                  initialMcpConnectionRefs={data.mcps ?? initialMcpConnectionRefs}
                  mcpConnections={mcpConnections}
                  onPrev={goPrev}
                  onNext={(mcpConnectionRefs) => {
                    stepper.metadata.set("mcps", mcpConnectionRefs)
                    goNext()
                  }}
                />
              ),
              allowedHosts: () => (
                <AllowedHostsStep
                  identity={data.identity!}
                  initialAllowedHosts={initialAllowedHosts}
                  mcpConnectionRefs={data.mcps ?? initialMcpConnectionRefs}
                  packages={data.packages ?? initialPackages}
                  mode={mode}
                  onPrev={goPrev}
                />
              ),
            })}
          </WizardShell>
        )
      }}
    </Stepper.Root>
  )
}
