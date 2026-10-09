"use client"

import { useMemo, useState, useTransition } from "react"
import {
  Copy,
  KeyRound,
  Plus,
  Trash2,
  Pencil,
  AppWindow,
  MoreHorizontal,
  CirclePause,
  CirclePlay,
  CircleCheck,
  Server,
  Monitor,
  Smartphone,
  type LucideIcon,
} from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { oauthApplicationInput } from "@/data/schema"
import { toast } from "sonner"
import { AdministrationPageHeader } from "@/components/administration"
import type { oauthClients } from "@/db/auth-schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Field,
  FieldContent,
  FieldError,
  RequiredIndicator,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from "@/components/ui/select"
import { changeApplicationAction, delegationSettingAction, saveApplicationAction } from "./actions"

const scopes = [
  { value: "openid", label: "Sign in", description: "Authenticate users with OpenID Connect." },
  { value: "profile", label: "Profile", description: "Read the user's name and profile image." },
  {
    value: "email",
    label: "Email",
    description: "Read the user's email address and verification status.",
  },
  {
    value: "offline_access",
    label: "Offline access",
    description: "Refresh access when the user is away.",
  },
  {
    value: "inference:use",
    label: "Inference",
    description: "Use models explicitly selected by the user.",
  },
  {
    value: "mcp:use",
    label: "MCP",
    description: "Use tools, prompts and resources explicitly selected by the user.",
  },
] as const

const clientTypes = {
  confidential: {
    icon: Server,
    label: "Confidential backend",
    description:
      "For server-side apps that can securely store a client secret. Keep the secret on your server.",
  },
  browser: {
    icon: Monitor,
    label: "Public browser application",
    description: "For apps that run in a browser. Uses PKCE without a client secret.",
  },
  native: {
    icon: Smartphone,
    label: "Public native application",
    description:
      "For mobile and desktop apps. Uses PKCE without a client secret and supports native callback URLs.",
  },
} satisfies Record<
  Parameters<typeof saveApplicationAction>[1]["type"],
  { label: string; description: string; icon: LucideIcon }
>

const columnLayout = {
  name: { minWidth: 224, width: 288, contentMaxWidth: 256 },
  type: { minWidth: 248, width: 248, contentMaxWidth: 216 },
  disabled: { minWidth: 112, width: 112 },
  scopes: { minWidth: 128, width: 128, contentMaxWidth: 96 },
  redirectUris: { minWidth: 200, contentMaxWidth: 320 },
  actions: { minWidth: 64, width: 64, align: "end" },
} satisfies Record<string, AdminColumnLayout>

type Credential = { clientId: string; secret: string }

type Application = Pick<
  typeof oauthClients.$inferSelect,
  | "clientId"
  | "name"
  | "redirectUris"
  | "scopes"
  | "tokenEndpointAuthMethod"
  | "applicationType"
  | "disabled"
> & { authorizedOrigins: string[] }

export function Applications({
  organizationId,
  clients,
  delegationEnabled,
}: {
  organizationId: string
  clients: Application[]
  delegationEnabled: boolean
}) {
  "use no memo"

  const [pending, startTransition] = useTransition()
  const [editor, setEditor] = useState<Application | "new">()
  const [credential, setCredential] = useState<Credential>()
  const [confirmation, setConfirmation] = useState<
    { client: Application; operation: "delete" | "rotate" | "disable" } | "delegation"
  >()

  const columns = useMemo<ColumnDef<Application>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row: { original: client } }) => (
          <div className="flex min-w-0 items-center gap-2">
            <AppWindow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium" title={client.name ?? undefined}>
              {client.name}
            </span>
          </div>
        ),
      },
      {
        id: "type",
        header: "Client type",
        cell: ({ row: { original: client } }) => {
          let type: keyof typeof clientTypes = "confidential"
          if (client.tokenEndpointAuthMethod === "none") {
            type = client.applicationType === "native" ? "native" : "browser"
          }
          const Icon = clientTypes[type].icon
          return (
            <span
              className="flex min-w-0 items-center gap-2"
              title={`${clientTypes[type].label}. S256 PKCE required.`}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{clientTypes[type].label}</span>
            </span>
          )
        },
      },
      {
        accessorKey: "disabled",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={row.original.disabled ? "pending" : "success"}>
            {row.original.disabled ? (
              <CirclePause aria-hidden="true" data-icon="inline-start" />
            ) : (
              <CircleCheck aria-hidden="true" data-icon="inline-start" />
            )}
            {row.original.disabled ? "Disabled" : "Active"}
          </Badge>
        ),
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        cell: ({ row }) => <ApplicationValues values={row.original.scopes ?? []} />,
      },
      {
        accessorKey: "redirectUris",
        header: "Callback URLs",
        cell: ({ row }) => <ApplicationValues values={row.original.redirectUris} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original: client } }) => (
          <div
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Actions for ${client.name}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setEditor(client)}>
                    <Pencil aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={async () => {
                      try {
                        await navigator.clipboard.writeText(client.clientId)
                        toast.success("Client ID copied")
                      } catch {
                        toast.error("Client ID could not be copied. Try again.")
                      }
                    }}
                  >
                    <Copy aria-hidden="true" />
                    Copy client ID
                  </DropdownMenuItem>
                  {client.tokenEndpointAuthMethod !== "none" ? (
                    <DropdownMenuItem
                      onSelect={() => setConfirmation({ client, operation: "rotate" })}
                    >
                      <KeyRound aria-hidden="true" />
                      Rotate secret
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    onSelect={() => {
                      if (!client.disabled) {
                        setConfirmation({ client, operation: "disable" })
                        return
                      }
                      startTransition(async () => {
                        const result = await changeApplicationAction(
                          organizationId,
                          client.clientId,
                          "enable"
                        )
                        if ("error" in result) toast.error(result.error)
                        else toast.success("Application enabled")
                      })
                    }}
                  >
                    {client.disabled ? (
                      <CirclePlay aria-hidden="true" />
                    ) : (
                      <CirclePause aria-hidden="true" />
                    )}
                    {client.disabled ? "Enable" : "Disable"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setConfirmation({ client, operation: "delete" })}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [organizationId, pending]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ columns, data: clients, getCoreRowModel: getCoreRowModel() })

  let confirmationTitle = "Disable application?"
  let confirmationDescription =
    "Existing access is revoked for new requests. Work already dispatched may finish. Users must grant access again after re-enabling."
  if (confirmation === "delegation") {
    confirmationTitle = "Turn off resource delegation?"
  } else if (confirmation?.operation === "delete") {
    confirmationTitle = "Delete application?"
    confirmationDescription =
      "This permanently deletes the application and revokes its authorizations. Work already dispatched may finish."
  } else if (confirmation?.operation === "rotate") {
    confirmationTitle = "Rotate client secret?"
    confirmationDescription =
      "The old secret stops working immediately. Update the application with the new secret."
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader title="Applications" />
      <div className="flex min-w-0 flex-col gap-8 px-4 pb-6 md:px-6">
        <Field orientation="horizontal" className="max-w-4xl">
          <FieldContent>
            <FieldLabel htmlFor="resource-delegation">Resource delegation</FieldLabel>
            <FieldDescription id="resource-delegation-description">
              Allow members to grant external apps access to this organization&apos;s models and MCP
              capabilities. Members require Use and Delegate permissions. Turning this off revokes
              existing resource access. Turning it back on requires fresh consent.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="resource-delegation"
            aria-describedby="resource-delegation-description"
            checked={delegationEnabled}
            disabled={pending}
            onCheckedChange={(enabled) => {
              if (!enabled) {
                setConfirmation("delegation")
                return
              }
              startTransition(async () => {
                const result = await delegationSettingAction(organizationId, true)
                if ("error" in result) toast.error(result.error)
                else toast.success("Resource delegation enabled")
              })
            }}
          />
        </Field>
        <section className="flex min-w-0 flex-col gap-5" aria-labelledby="registered-applications">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="registered-applications" className="text-base font-semibold">
                Registered applications
              </h2>
              <p className="max-w-lg text-sm text-muted-foreground">
                Let other applications sign in with AgentZ and request access to user-selected
                resources.
              </p>
            </div>
            <Button variant="outline" disabled={pending} onClick={() => setEditor("new")}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              Create application
            </Button>
          </div>
          <AdminDataGrid
            ariaLabel="Registered applications"
            className={clients.length ? "-mx-4 md:-mx-6" : undefined}
            rows={clients}
            onRowActivate={setEditor}
            rowAriaLabel={(client) => `Edit ${client.name}`}
            rowCanActivate={() => !pending}
            table={table}
            layout={columnLayout}
            emptyState={
              <Empty className="border-2 border-dashed border-border/70 bg-card/40 py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <AppWindow aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Your first application</EmptyTitle>
                  <EmptyDescription>
                    Register an application to offer Sign in with AgentZ. Users choose which
                    resources it can use.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            }
          />
        </section>
      </div>
      {editor !== undefined ? (
        <ApplicationEditor
          organizationId={organizationId}
          client={editor === "new" ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSaved={(credential) => {
            setEditor(undefined)
            setCredential(credential)
          }}
        />
      ) : null}
      <Dialog
        open={credential !== undefined}
        onOpenChange={(open) => {
          if (!open) setCredential(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Application credentials</DialogTitle>
            <DialogDescription>
              Copy the secret now. AgentZ stores its hash and cannot show it again.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="application-client-id">Client ID</FieldLabel>
              <div className="flex items-center gap-2">
                <Input id="application-client-id" readOnly value={credential?.clientId ?? ""} />
                <CopyButton content={credential?.clientId ?? ""} label="Copy client ID" />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="application-client-secret">Client secret</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="application-client-secret"
                  readOnly
                  type="password"
                  value={credential?.secret ?? ""}
                  autoComplete="off"
                />
                <CopyButton content={credential?.secret ?? ""} label="Copy client secret" />
              </div>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={() => setCredential(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!pending && !open) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmationTitle}</DialogTitle>
            <DialogDescription>{confirmationDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!confirmation) return
                  if (confirmation === "delegation") {
                    const result = await delegationSettingAction(organizationId, false)
                    if ("error" in result) {
                      toast.error(result.error)
                      return
                    }
                  } else {
                    const result = await changeApplicationAction(
                      organizationId,
                      confirmation.client.clientId,
                      confirmation.operation
                    )
                    if ("error" in result) {
                      toast.error(result.error)
                      return
                    }
                    if (result.secret)
                      setCredential({
                        clientId: confirmation.client.clientId,
                        secret: result.secret,
                      })
                  }
                  setConfirmation(undefined)
                  toast.success("Application settings updated")
                })
              }
            >
              {pending ? "Updating…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function ApplicationValues({ values }: { values: string[] }) {
  if (!values.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="flex min-w-0 items-center gap-2">
          <span className="truncate text-muted-foreground">{values[0]}</span>
          {values.length > 1 ? <Badge variant="secondary">+{values.length - 1}</Badge> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-96 break-all whitespace-pre-line">
        {values.join("\n")}
      </TooltipContent>
    </Tooltip>
  )
}

const applicationFormSchema = z
  .object({
    name: z.string(),
    type: oauthApplicationInput.shape.type,
    redirectUris: z.string(),
    authorizedOrigins: z.string(),
    scopes: z.array(z.string()),
  })
  .transform((input, ctx) => {
    const parsed = oauthApplicationInput.safeParse({
      ...input,
      redirectUris: input.redirectUris
        .split("\n")
        .map((uri) => uri.trim())
        .filter(Boolean),
      authorizedOrigins:
        input.type === "browser"
          ? input.authorizedOrigins
              .split("\n")
              .map((origin) => origin.trim())
              .filter(Boolean)
          : [],
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: issue.path.slice(0, 1) })
      return z.NEVER
    }
    return parsed.data
  })

function ApplicationEditor({
  organizationId,
  client,
  onClose,
  onSaved,
}: {
  organizationId: string
  client?: Application
  onClose: () => void
  onSaved: (credential?: Credential) => void
}) {
  let initialType: keyof typeof clientTypes = "confidential"
  if (client?.tokenEndpointAuthMethod === "none")
    initialType = client.applicationType === "native" ? "native" : "browser"
  const form = useForm<
    z.input<typeof applicationFormSchema>,
    undefined,
    z.output<typeof applicationFormSchema>
  >({
    resolver: zodResolver(applicationFormSchema),
    defaultValues: {
      name: client?.name ?? "",
      type: initialType,
      redirectUris: client?.redirectUris.join("\n") ?? "",
      authorizedOrigins: client?.authorizedOrigins.join("\n") ?? "",
      scopes: client ? (client.scopes ?? []) : ["openid", "profile", "email"],
    },
  })
  const type = useWatch({ control: form.control, name: "type" })
  const pending = form.formState.isSubmitting
  const error = form.formState.errors.root?.message
  const save = form.handleSubmit(async (input) => {
    form.clearErrors("root")
    const result = await saveApplicationAction(organizationId, input, client?.clientId)
    if ("error" in result) {
      form.setError("root", { message: result.error })
      return
    }
    onSaved(result.secret ? { clientId: result.clientId, secret: result.secret } : undefined)
    toast.success("Application saved")
  })
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!pending && !open) onClose()
      }}
    >
      <SheetContent size="md" className="gap-0" showCloseButton={!pending}>
        <SheetHeader>
          <SheetTitle>{client ? "Edit application" : "Create application"}</SheetTitle>
          <SheetDescription>
            Configure callback URLs, browser origins, and the scopes this application may request.
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={save} noValidate>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <FieldGroup>
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="application-name" required>
                      Name
                    </FieldLabel>
                    <Input
                      {...field}
                      id="application-name"
                      required
                      maxLength={100}
                      disabled={pending}
                      aria-invalid={fieldState.invalid}
                      aria-describedby={fieldState.invalid ? "application-name-error" : undefined}
                    />
                    <FieldError id="application-name-error" errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                name="type"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-disabled={!!client || pending} data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="application-type" required>
                      Client type
                    </FieldLabel>
                    <Select
                      name={field.name}
                      value={field.value}
                      disabled={!!client || pending}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger
                        ref={field.ref}
                        onBlur={field.onBlur}
                        id="application-type"
                        className="w-full"
                        aria-required="true"
                        aria-invalid={fieldState.invalid}
                        aria-describedby="application-type-description application-type-error"
                      >
                        <SelectValue>{clientTypes[type].label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                        <SelectGroup>
                          {Object.entries(clientTypes).map(([value, option]) => (
                            <SelectItem key={value} value={value} textValue={option.label}>
                              <span className="flex flex-col gap-1 py-1">
                                <span>{option.label}</span>
                                <span className="text-xs text-muted-foreground">
                                  {option.description}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription id="application-type-description">
                      {clientTypes[type].description}
                    </FieldDescription>
                    <FieldError id="application-type-error" errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                name="redirectUris"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="application-redirects" required>
                      Callback URLs
                    </FieldLabel>
                    <Textarea
                      {...field}
                      id="application-redirects"
                      required
                      disabled={pending}
                      aria-invalid={fieldState.invalid}
                      aria-describedby="application-redirects-description application-redirects-error"
                      placeholder="https://app.example.com/auth/agentz/callback"
                    />
                    <FieldDescription id="application-redirects-description">
                      One URL per line. Web clients need HTTPS on a public hostname. Native clients
                      can use HTTP loopback URLs or a reverse-domain URI scheme.
                    </FieldDescription>
                    <FieldError id="application-redirects-error" errors={[fieldState.error]} />
                  </Field>
                )}
              />
              {type === "browser" && (
                <Controller
                  name="authorizedOrigins"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="application-origins" required>
                        Authorized JavaScript origins
                      </FieldLabel>
                      <Textarea
                        {...field}
                        id="application-origins"
                        required
                        disabled={pending}
                        aria-invalid={fieldState.invalid}
                        aria-describedby="application-origins-description application-origins-error"
                        placeholder={"https://app.example.com\nhttp://localhost:5173"}
                      />
                      <FieldDescription id="application-origins-description">
                        One origin per line, up to 10. Include the scheme and port, without a path.
                        HTTPS is required except for HTTP localhost, 127.0.0.1, or [::1]. These
                        origins may call OAuth, MCP, and inference APIs from a browser.
                      </FieldDescription>
                      <FieldError id="application-origins-error" errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              )}
              <Controller
                name="scopes"
                control={form.control}
                render={({ field, fieldState }) => (
                  <FieldSet
                    disabled={pending}
                    data-invalid={fieldState.invalid}
                    aria-describedby="application-scopes-error"
                  >
                    <FieldLegend variant="label">
                      Allowed scopes <RequiredIndicator />
                    </FieldLegend>
                    <FieldGroup data-slot="checkbox-group">
                      {scopes.map((scope, index) => (
                        <Field key={scope.value} orientation="horizontal">
                          <Checkbox
                            id={`application-scope-${scope.value}`}
                            ref={index === 0 ? field.ref : undefined}
                            onBlur={field.onBlur}
                            checked={field.value.includes(scope.value)}
                            disabled={pending}
                            aria-invalid={fieldState.invalid}
                            aria-describedby={`application-scope-${scope.value}-description application-scopes-error`}
                            onCheckedChange={(checked) =>
                              field.onChange(
                                checked === true
                                  ? [...field.value, scope.value]
                                  : field.value.filter((value) => value !== scope.value)
                              )
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor={`application-scope-${scope.value}`}>
                              {scope.label}{" "}
                              <code className="text-xs font-normal text-muted-foreground">
                                {scope.value}
                              </code>
                            </FieldLabel>
                            <FieldDescription id={`application-scope-${scope.value}-description`}>
                              {scope.description}
                            </FieldDescription>
                          </FieldContent>
                        </Field>
                      ))}
                    </FieldGroup>
                    <FieldError id="application-scopes-error" errors={[fieldState.error]} />
                  </FieldSet>
                )}
              />
              {error && !pending ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </div>
          <SheetFooter className="shrink-0 flex-row justify-end border-t">
            <Button variant="outline" type="button" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save application"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
