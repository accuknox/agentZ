"use client"

import * as React from "react"
import Fuse from "fuse.js"
import { zodResolver } from "@hookform/resolvers/zod"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import {
  Controller,
  useController,
  useFieldArray,
  useForm,
  useWatch,
  type Control,
  type FieldError as RHFFieldError,
} from "react-hook-form"
import * as z from "zod"
import { Check, ChevronDown, CircleAlert, RefreshCw, Settings2, Trash2, X } from "lucide-react"
import { findMcpServerByURL, mcpFallbackIcon, mcpServers, type McpServer } from "@/app/mcps/catalog"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { McpFormState } from "@/data/mcp.actions"
import {
  formBearerDefaults,
  formOAuthDefaults,
  mcpFormSchema,
  type McpFormInput,
} from "@/data/mcp.schema"
import type { McpConnection } from "@/lib/gateway/client"
import { authModeOf } from "@/lib/mcp"
import {
  oauthBroadcastChannelName,
  oauthWindowMessageSource,
  parseOAuthPopupMessage,
  type OAuthPopupMessage,
} from "@/lib/mcp-oauth-shared"

type SubmitMcpAction = (_: McpFormState, formData: FormData) => Promise<McpFormState>

const defaultFormValues: McpFormInput = {
  mode: "create",
  current_name: undefined,
  current_auth_mode: "none",
  name: "",
  endpoint_url: "",
  endpoint_timeout: undefined,
  extra_headers: [],
  auth_mode: "oauth",
  oauth_discovery_state: "idle",
  bearer_token: "",
  oauth_scopes: "",
  oauth_client_id: "",
  oauth_client_secret: "",
  oauth_issuer: "",
  oauth_authorization_endpoint: "",
  oauth_token_endpoint: "",
  oauth_registration_endpoint: "",
  oauth_resource: "",
  oauth_location_header_name: "Authorization",
  oauth_location_header_prefix: "Bearer",
  bearer_location_header_name: "Authorization",
  bearer_location_header_prefix: "Bearer",
}

const clientCredentialsAccordionItem = "client-credentials"
const advancedAccordionItem = "advanced"
const initialServerResults = 8
const discoveryDebounceMs = 500
const discoveryErrorMessage =
  "If the MCP server supports OAuth, please fill in the required fields in advanced section manually."
const oauthAdvancedFields = [
  {
    name: "oauth_issuer",
    label: "Issuer",
    placeholder: "https://issuer.example.com",
  },
  {
    name: "oauth_authorization_endpoint",
    label: "Authorization endpoint",
    placeholder: "https://issuer.example.com/authorize",
  },
  {
    name: "oauth_token_endpoint",
    label: "Token endpoint",
    placeholder: "https://issuer.example.com/token",
  },
  {
    name: "oauth_registration_endpoint",
    label: "Registration endpoint",
    placeholder: "https://issuer.example.com/register",
  },
  {
    name: "oauth_resource",
    label: "Resource",
    placeholder: "https://example.com/mcp",
  },
  {
    name: "oauth_scopes",
    label: "Scopes",
    placeholder: "scope:read\nscope:write",
    kind: "textarea",
  },
  {
    name: "oauth_location_header_name",
    label: "Bearer token header name",
    placeholder: "Authorization",
  },
  {
    name: "oauth_location_header_prefix",
    label: "Bearer token prefix",
    placeholder: "Bearer",
  },
] as const
const serverErrorFields = [
  "name",
  "endpoint_url",
  "bearer_token",
  "oauth_client_id",
  "oauth_client_secret",
  ...oauthAdvancedFields.map((field) => field.name),
  "bearer_location_header_name",
  "bearer_location_header_prefix",
] as const
const scalarFormDataFields = [
  "mode",
  "current_name",
  "current_auth_mode",
  "name",
  "endpoint_url",
  "endpoint_timeout",
  "auth_mode",
  "oauth_discovery_state",
  "bearer_token",
  "oauth_scopes",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_issuer",
  "oauth_authorization_endpoint",
  "oauth_token_endpoint",
  "oauth_registration_endpoint",
  "oauth_resource",
  "oauth_location_header_name",
  "oauth_location_header_prefix",
  "bearer_location_header_name",
  "bearer_location_header_prefix",
] as const
const conditionalFormFields = [
  "oauth_client_id",
  "oauth_client_secret",
  ...oauthAdvancedFields.map((field) => field.name),
  "bearer_location_header_name",
  "bearer_location_header_prefix",
] as const
const oauthDiscoveryResponseSchema = z.object({
  oauth: z
    .object({
      issuer: z.string().optional(),
      authorization_endpoint: z.string().optional(),
      token_endpoint: z.string().optional(),
      registration_endpoint: z.string().optional(),
      resource: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      location: z
        .object({
          header: z
            .object({
              name: z.string().optional(),
              prefix: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

type OauthAdvancedFieldName = (typeof oauthAdvancedFields)[number]["name"]
type ServerErrorField = (typeof serverErrorFields)[number]
type OAuthDiscoveryPayload = z.infer<typeof oauthDiscoveryResponseSchema>
type OAuthDiscoveryResponse = OAuthDiscoveryPayload & {
  endpointURL: string
}
type ExtraHeaderFieldKey = "key" | "value"
type AccordionAction =
  | {
      type: "set"
      value: string[]
    }
  | {
      type: "expand"
      items: string[]
    }
  | {
      type: "reset"
    }
type McpCatalogResult =
  | {
      kind: "catalog"
      server: McpServer
    }
  | {
      kind: "custom"
      mcpUrl: string
    }

const mcpServerSearch = new Fuse(mcpServers, {
  keys: ["name", "mcpUrl"],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
})

const oauthDiscoveryQueryOptions = (endpointURL: string) =>
  queryOptions({
    queryKey: ["mcp", "oauth-discovery", endpointURL],
    queryFn: async ({ signal }) => {
      const response = await fetch("/mcps/oauth/discovery", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          endpointUrl: endpointURL,
        }),
        signal,
      })
      const payload = oauthDiscoveryResponseSchema.parse(await response.json())

      if (!response.ok) {
        throw new Error(discoveryErrorMessage)
      }

      return {
        ...payload,
        endpointURL,
      } satisfies OAuthDiscoveryResponse
    },
    placeholderData: (previousData) => previousData,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = React.useState(value)

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(value)
    }, delay)
    return () => {
      window.clearTimeout(id)
    }
  }, [delay, value])

  return debounced
}

function isHTTPSURL(value: string) {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function accordionReducer(state: string[], action: AccordionAction) {
  if (action.type === "set") {
    return action.value
  }

  if (action.type === "reset") {
    return []
  }

  const next = new Set(state)
  for (const item of action.items) {
    next.add(item)
  }
  return [...next]
}

function formDefaults(connection?: McpConnection): McpFormInput {
  if (!connection) {
    return defaultFormValues
  }

  const authMode = authModeOf(connection)
  const oauthDefaults = formOAuthDefaults(connection)
  const bearerDefaults = formBearerDefaults(connection)
  return {
    mode: "update",
    current_name: connection.name,
    current_auth_mode: authMode,
    name: connection.name,
    endpoint_url: connection.endpoint.url,
    endpoint_timeout: connection.endpoint.timeout,
    extra_headers: Object.entries(connection.endpoint.headers).map(([key, value]) => ({
      key,
      value,
    })),
    auth_mode: authMode === "bearer" ? "bearer" : "oauth",
    oauth_discovery_state: "idle",
    bearer_token: "",
    oauth_scopes: oauthDefaults.oauth_scopes,
    oauth_client_id: "",
    oauth_client_secret: "",
    oauth_issuer: oauthDefaults.oauth_issuer,
    oauth_authorization_endpoint: oauthDefaults.oauth_authorization_endpoint,
    oauth_token_endpoint: oauthDefaults.oauth_token_endpoint,
    oauth_registration_endpoint: oauthDefaults.oauth_registration_endpoint,
    oauth_resource: oauthDefaults.oauth_resource,
    oauth_location_header_name: oauthDefaults.oauth_location_header_name,
    oauth_location_header_prefix: oauthDefaults.oauth_location_header_prefix,
    bearer_location_header_name: bearerDefaults.bearer_location_header_name,
    bearer_location_header_prefix: bearerDefaults.bearer_location_header_prefix,
  }
}

function applyServerErrors(form: ReturnType<typeof useForm<McpFormInput>>, state: McpFormState) {
  if (!state.error?.errors) {
    return
  }

  for (const error of state.error.errors) {
    if (serverErrorFields.includes(error.field as ServerErrorField)) {
      form.setError(error.field as ServerErrorField, {
        type: "server",
        message: error.message,
      })
      continue
    }

    if (!error.field.startsWith("extra_headers.")) {
      continue
    }

    const match = /^extra_headers\.(\d+)\.(key|value)$/.exec(error.field)
    if (!match) {
      continue
    }

    const index = Number(match[1])
    if (!Number.isInteger(index)) {
      continue
    }

    const key = match[2] as ExtraHeaderFieldKey
    form.setError(`extra_headers.${index}.${key}` as const, {
      type: "server",
      message: error.message,
    })
  }
}

function generalErrorMessage(error: McpFormState["error"]) {
  if (!error) {
    return undefined
  }

  const fieldErrors =
    error.errors?.filter((item) => {
      return (
        serverErrorFields.includes(item.field as ServerErrorField) ||
        item.field.startsWith("extra_headers.")
      )
    }) ?? []
  const hasGeneralError = !error.errors || error.errors.length > fieldErrors.length

  return hasGeneralError ? error.message : undefined
}

function formDataFromValues(values: McpFormInput) {
  const formData = new FormData()

  for (const fieldName of scalarFormDataFields) {
    formData.set(fieldName, values[fieldName] ?? "")
  }

  for (const header of values.extra_headers) {
    formData.append("extra_header_key", header.key)
    formData.append("extra_header_value", header.value)
  }

  return formData
}

const ServerURLField = React.memo(function ServerURLField({
  control,
  authMode,
  endpointError,
  discoveryIconState,
  isRefreshingDiscovery,
  discoveryURLOverride,
  onDiscoveryURLOverrideChangeAction,
  onRefreshDiscoveryAction,
}: {
  control: Control<McpFormInput>
  authMode: McpFormInput["auth_mode"]
  endpointError?: RHFFieldError
  discoveryIconState: "idle" | "loading" | "error" | "success"
  isRefreshingDiscovery: boolean
  discoveryURLOverride?: string
  onDiscoveryURLOverrideChangeAction: (value: string | undefined) => void
  onRefreshDiscoveryAction: () => void
}) {
  const { field } = useController({
    control,
    name: "endpoint_url",
  })
  const [serverPickerOpen, setServerPickerOpen] = React.useState(false)
  const serverFieldRef = React.useRef<HTMLDivElement | null>(null)
  const serverInputRef = React.useRef<HTMLInputElement | null>(null)
  const serverPopoverRef = React.useRef<HTMLDivElement | null>(null)
  const selectedServer = React.useMemo(
    () => findMcpServerByURL((field.value ?? "").trim()),
    [field.value]
  )
  const SelectedServerIcon = selectedServer?.icon ?? mcpFallbackIcon
  const deferredEndpointURL = React.useDeferredValue((field.value ?? "").trim())
  const serverResults = React.useMemo(() => {
    const query = deferredEndpointURL
    const catalogResults = query
      ? mcpServerSearch.search(query).map((result) => result.item)
      : mcpServers.slice(0, initialServerResults)
    const results: McpCatalogResult[] = catalogResults.map((server) => ({
      kind: "catalog",
      server,
    }))
    const hasExactCatalogURL = findMcpServerByURL(query) !== undefined

    if (!query) {
      return results
    }

    try {
      const customURL = new URL(query)
      if (customURL.protocol === "https:" && !hasExactCatalogURL) {
        results.push({
          kind: "custom",
          mcpUrl: query,
        })
      }
    } catch {}

    return results
  }, [deferredEndpointURL])

  function isInServerField(target: EventTarget | null) {
    if (!(target instanceof Node)) {
      return false
    }

    return (
      serverFieldRef.current?.contains(target) === true ||
      serverPopoverRef.current?.contains(target) === true
    )
  }

  function selectServer(result: McpCatalogResult) {
    const value = result.kind === "catalog" ? result.server.mcpUrl : result.mcpUrl
    field.onChange(value)
    setServerPickerOpen(false)
    serverInputRef.current?.focus()
  }

  return (
    <Field data-invalid={Boolean(endpointError)}>
      <FieldLabel htmlFor="mcp-endpoint-url">MCP Server</FieldLabel>
      <Popover open={serverPickerOpen} onOpenChange={setServerPickerOpen}>
        <PopoverAnchor asChild>
          <div ref={serverFieldRef} className="relative">
            <SelectedServerIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="mcp-endpoint-url"
              name={field.name}
              ref={(node) => {
                field.ref(node)
                serverInputRef.current = node
              }}
              value={field.value ?? ""}
              onFocus={() => {
                setServerPickerOpen(true)
              }}
              onBlur={(event) => {
                if (isInServerField(event.relatedTarget)) {
                  return
                }
                setServerPickerOpen(false)
                field.onBlur()
              }}
              onChange={(event) => {
                field.onChange(event)
                if (discoveryURLOverride && discoveryURLOverride !== event.target.value.trim()) {
                  onDiscoveryURLOverrideChangeAction(undefined)
                }
                if (!serverPickerOpen) {
                  setServerPickerOpen(true)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setServerPickerOpen(false)
                }
              }}
              placeholder="https://example.com/mcp"
              className={authMode === "oauth" ? "pr-25 pl-9" : "pr-10 pl-9"}
              aria-invalid={Boolean(endpointError)}
              aria-expanded={serverPickerOpen}
              aria-autocomplete="list"
              aria-controls="mcp-endpoint-url-suggestions"
              role="combobox"
            />
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
            {authMode === "oauth" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute inset-y-0 right-8 my-auto"
                onClick={onRefreshDiscoveryAction}
                disabled={isRefreshingDiscovery}
                aria-label="Discover OAuth metadata"
              >
                {discoveryIconState === "loading" ? (
                  <Spinner aria-hidden="true" />
                ) : discoveryIconState === "success" ? (
                  <Check />
                ) : discoveryIconState === "error" ? (
                  <CircleAlert />
                ) : (
                  <RefreshCw />
                )}
              </Button>
            ) : null}
          </div>
        </PopoverAnchor>
        <PopoverContent
          ref={serverPopoverRef}
          align="start"
          className="w-(--radix-popper-anchor-width) p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
          }}
          onFocusOutside={(event) => {
            if (isInServerField(event.target)) {
              event.preventDefault()
            }
          }}
          onInteractOutside={(event) => {
            if (isInServerField(event.target)) {
              event.preventDefault()
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
          }}
          sideOffset={8}
        >
          <Command shouldFilter={false}>
            <CommandList id="mcp-endpoint-url-suggestions">
              <CommandEmpty>
                No known MCP servers match. You can still use the typed URL.
              </CommandEmpty>
              <CommandGroup>
                {serverResults.map((result) => {
                  if (result.kind === "catalog") {
                    const Icon = result.server.icon
                    return (
                      <CommandItem
                        key={result.server.mcpUrl}
                        value={result.server.mcpUrl}
                        className="cursor-pointer"
                        onMouseDown={(event) => {
                          event.preventDefault()
                        }}
                        onSelect={() => {
                          selectServer(result)
                        }}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                          <Icon />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{result.server.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {result.server.mcpUrl}
                          </span>
                        </span>
                      </CommandItem>
                    )
                  }

                  return (
                    <CommandItem
                      key={result.mcpUrl}
                      value={result.mcpUrl}
                      className="cursor-pointer"
                      onMouseDown={(event) => {
                        event.preventDefault()
                      }}
                      onSelect={() => {
                        selectServer(result)
                      }}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                        <Settings2 />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">Custom Server</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {result.mcpUrl}
                        </span>
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {endpointError ? <FieldError errors={[endpointError]} /> : null}
    </Field>
  )
})

export function McpSheet({
  mode,
  connection,
  open,
  onOpenChangeAction,
  submitMcpAction,
}: {
  mode: "create" | "update"
  connection?: McpConnection
  open: boolean
  onOpenChangeAction: (open: boolean) => void
  submitMcpAction: SubmitMcpAction
}) {
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()
  const defaultValues = React.useMemo(() => formDefaults(connection), [connection])
  const form = useForm<McpFormInput>({
    resolver: zodResolver(mcpFormSchema),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues,
  })
  const { errors, isValid } = form.formState
  const headerFields = useFieldArray({
    control: form.control,
    name: "extra_headers",
  })
  const authMode = useWatch({
    control: form.control,
    name: "auth_mode",
    defaultValue: defaultValues.auth_mode,
  })
  const oauthDiscoveryState = useWatch({
    control: form.control,
    name: "oauth_discovery_state",
    defaultValue: defaultValues.oauth_discovery_state,
  })
  const oauthFields = useWatch({
    control: form.control,
    name: [
      "oauth_client_id",
      "oauth_client_secret",
      "oauth_registration_endpoint",
      "oauth_issuer",
      "oauth_authorization_endpoint",
      "oauth_token_endpoint",
    ] as const,
  })
  const [
    oauthClientID = defaultValues.oauth_client_id,
    oauthClientSecret = defaultValues.oauth_client_secret,
    oauthRegistrationEndpoint = defaultValues.oauth_registration_endpoint,
    oauthIssuer = defaultValues.oauth_issuer,
    oauthAuthorizationEndpoint = defaultValues.oauth_authorization_endpoint,
    oauthTokenEndpoint = defaultValues.oauth_token_endpoint,
  ] = oauthFields
  const [oauthPopupFlowId, setOauthPopupFlowId] = React.useState<string>()
  const [submitError, setSubmitError] = React.useState<string>()
  const [successMessage, setSuccessMessage] = React.useState<string>()
  const [submitted, setSubmitted] = React.useState(false)
  const [userExpandedAccordions, dispatchAccordion] = React.useReducer(accordionReducer, [])
  const [dismissedDiscoveryWarningKey, setDismissedDiscoveryWarningKey] = React.useState<string>()
  const [discoveryURLOverride, setDiscoveryURLOverride] = React.useState<string>()
  const [endpointURL, setEndpointURL] = React.useState(defaultValues.endpoint_url)
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const mountedRef = React.useRef(true)
  const messageHandlerRef = React.useRef<((event: MessageEvent<unknown>) => void) | null>(null)
  const trimmedEndpointURL = endpointURL.trim()
  const debouncedEndpointURL = useDebouncedValue(trimmedEndpointURL, discoveryDebounceMs)
  const validEndpointURL = isHTTPSURL(trimmedEndpointURL)
  const discoveryURL = discoveryURLOverride ?? debouncedEndpointURL
  const oauthQuery = useQuery({
    ...oauthDiscoveryQueryOptions(discoveryURL),
    enabled: authMode === "oauth" && isHTTPSURL(discoveryURL),
  })
  const oauthDiscoveryData = oauthQuery.data?.oauth
  const isCurrentDiscoveryTarget = discoveryURL === trimmedEndpointURL
  const isCurrentDiscoveryResult = oauthQuery.data?.endpointURL === trimmedEndpointURL
  const discoveryWarningMessage =
    oauthQuery.error instanceof Error ? oauthQuery.error.message : undefined
  const discoveryWarningURL =
    authMode === "oauth" && isCurrentDiscoveryTarget && isHTTPSURL(discoveryURL)
      ? discoveryURL
      : undefined
  const discoveryWarningKey =
    discoveryWarningURL && discoveryWarningMessage
      ? `${discoveryWarningURL}:${discoveryWarningMessage}`
      : undefined
  const isDiscoveryPendingForCurrentURL =
    authMode === "oauth" &&
    validEndpointURL &&
    (!isCurrentDiscoveryTarget || oauthQuery.fetchStatus === "fetching")
  const currentDiscoveryState =
    authMode !== "oauth" || !validEndpointURL
      ? "idle"
      : isDiscoveryPendingForCurrentURL
        ? "discovering"
        : oauthQuery.isError
          ? "manual"
          : isCurrentDiscoveryResult && oauthQuery.isSuccess
            ? "success"
            : "idle"
  const discoveryIconState =
    authMode !== "oauth" || !validEndpointURL || !isCurrentDiscoveryTarget
      ? "idle"
      : oauthQuery.fetchStatus === "fetching"
        ? "loading"
        : oauthQuery.isError
          ? "error"
          : isCurrentDiscoveryResult && oauthQuery.isSuccess
            ? "success"
            : "idle"

  const cancelPendingOAuthFlow = React.useCallback(() => {
    void fetch("/mcps/oauth/pending", {
      method: "POST",
      keepalive: true,
    }).catch(() => {})
  }, [])

  const cleanupPopupFlow = React.useCallback(
    (options?: { closePopup?: boolean; cancelPending?: boolean }) => {
      const handler = messageHandlerRef.current
      if (handler) {
        window.removeEventListener("message", handler)
        messageHandlerRef.current = null
      }
      broadcastChannelRef.current?.close()
      broadcastChannelRef.current = null
      if (popupPollRef.current !== null) {
        window.clearInterval(popupPollRef.current)
        popupPollRef.current = null
      }
      if (options?.closePopup && popupRef.current && !popupRef.current.closed) {
        popupRef.current.close()
      }
      popupRef.current = null
      setOauthPopupFlowId(undefined)
      if (options?.cancelPending) {
        cancelPendingOAuthFlow()
      }
    },
    [cancelPendingOAuthFlow]
  )

  React.useEffect(() => {
    return () => {
      mountedRef.current = false
      cleanupPopupFlow({
        closePopup: true,
      })
    }
  }, [cleanupPopupFlow])

  React.useEffect(() => {
    if (!open) {
      return
    }

    form.reset(defaultValues)
  }, [defaultValues, form, open])

  React.useEffect(() => {
    const unsubscribe = form.subscribe({
      name: "endpoint_url",
      exact: true,
      formState: {
        values: true,
      },
      callback: ({ values }) => {
        setEndpointURL(values.endpoint_url ?? "")
      },
    })

    return () => {
      unsubscribe()
    }
  }, [form])

  React.useEffect(() => {
    for (const fieldName of conditionalFormFields) {
      form.register(fieldName)
    }
  }, [form])

  React.useEffect(() => {
    const discoveredEndpointURL = oauthQuery.data?.endpointURL

    if (
      !oauthDiscoveryData ||
      !discoveredEndpointURL ||
      authMode !== "oauth" ||
      !isCurrentDiscoveryTarget
    ) {
      return
    }

    if (discoveredEndpointURL !== trimmedEndpointURL) {
      return
    }

    form.setValue("oauth_issuer", oauthDiscoveryData.issuer ?? "", {
      shouldValidate: true,
    })
    form.setValue("oauth_authorization_endpoint", oauthDiscoveryData.authorization_endpoint ?? "", {
      shouldValidate: true,
    })
    form.setValue("oauth_token_endpoint", oauthDiscoveryData.token_endpoint ?? "", {
      shouldValidate: true,
    })
    form.setValue("oauth_registration_endpoint", oauthDiscoveryData.registration_endpoint ?? "", {
      shouldValidate: true,
    })
    form.setValue("oauth_resource", oauthDiscoveryData.resource ?? "", {
      shouldValidate: true,
    })
    form.setValue("oauth_scopes", oauthDiscoveryData.scopes?.join("\n") ?? "", {
      shouldValidate: true,
    })
    form.setValue(
      "oauth_location_header_name",
      oauthDiscoveryData.location?.header?.name ?? "Authorization",
      {
        shouldValidate: true,
      }
    )
    form.setValue(
      "oauth_location_header_prefix",
      oauthDiscoveryData.location?.header?.prefix ?? "Bearer",
      {
        shouldValidate: true,
      }
    )
  }, [
    authMode,
    form,
    isCurrentDiscoveryTarget,
    oauthDiscoveryData,
    oauthQuery.data?.endpointURL,
    trimmedEndpointURL,
  ])

  React.useEffect(() => {
    if (oauthDiscoveryState === currentDiscoveryState) {
      return
    }

    form.setValue("oauth_discovery_state", currentDiscoveryState, {
      shouldValidate: true,
    })
  }, [currentDiscoveryState, form, oauthDiscoveryState])

  const openOAuthPopup = React.useCallback(
    (oauth: { flowId: string; url: string }) => {
      setSubmitError(undefined)
      setSuccessMessage(undefined)
      let completed = false

      function finishPopupFlow() {
        cleanupPopupFlow()
      }

      function acknowledgePopup(flowId: string) {
        const ack: OAuthPopupMessage = {
          source: oauthWindowMessageSource,
          kind: "ack",
          flowId,
        }
        broadcastChannelRef.current?.postMessage(ack)
      }

      function handlePopupMessage(data: unknown) {
        const message = parseOAuthPopupMessage(data)
        if (!message || message.kind !== "result" || message.flowId !== oauth.flowId) {
          return
        }

        completed = true
        acknowledgePopup(message.flowId)
        finishPopupFlow()

        if (message.status === "success") {
          setSubmitError(undefined)
          setSuccessMessage(message.message)
          setSubmitted(true)
          startTransition(() => {
            router.refresh()
          })
          return
        }

        setSubmitError(message.message)
      }

      function onWindowMessage(event: MessageEvent<unknown>) {
        if (event.origin !== window.location.origin) {
          return
        }
        handlePopupMessage(event.data)
      }

      messageHandlerRef.current = onWindowMessage
      window.addEventListener("message", onWindowMessage)
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(oauthBroadcastChannelName)
        channel.onmessage = (event: MessageEvent<OAuthPopupMessage>) => {
          handlePopupMessage(event.data)
        }
        broadcastChannelRef.current = channel
      }

      const popup = window.open(
        oauth.url,
        `mcp-oauth-${oauth.flowId}`,
        "popup=yes,width=520,height=760,resizable=yes,scrollbars=yes"
      )
      if (!popup) {
        finishPopupFlow()
        setSubmitError("OAuth popup was blocked by the browser. Allow popups and try again.")
        return
      }

      popupRef.current = popup
      setOauthPopupFlowId(oauth.flowId)

      popupPollRef.current = window.setInterval(() => {
        if (!popupRef.current || !popupRef.current.closed) {
          return
        }
        if (completed) {
          return
        }
        finishPopupFlow()
        cancelPendingOAuthFlow()
        setSubmitError("OAuth popup was closed before authentication completed.")
      }, 400)
    },
    [cancelPendingOAuthFlow, cleanupPopupFlow, router]
  )

  const submitValues = React.useCallback(
    async (values: McpFormInput) => {
      setSubmitError(undefined)
      form.clearErrors()

      const formData = formDataFromValues(values)
      startTransition(() => {
        void (async () => {
          const nextState = await submitMcpAction({}, formData)
          if (!mountedRef.current) {
            return
          }

          applyServerErrors(form, nextState)
          if (nextState.error) {
            setSubmitError(generalErrorMessage(nextState.error) ?? nextState.error.message)
            return
          }

          if ("oauth" in nextState && nextState.oauth) {
            openOAuthPopup(nextState.oauth)
            return
          }

          if (nextState.success) {
            setSubmitted(true)
            setSubmitError(undefined)
            setSuccessMessage(nextState.message)
            form.reset(defaultValues)
            router.refresh()
          }
        })()
      })
    },
    [defaultValues, form, openOAuthPopup, router, submitMcpAction]
  )

  const discoveryWarningVisible =
    authMode === "oauth" &&
    discoveryWarningKey &&
    discoveryWarningKey !== dismissedDiscoveryWarningKey &&
    discoveryWarningMessage &&
    discoveryWarningURL &&
    oauthQuery.isError
      ? {
          key: discoveryWarningKey,
          message: discoveryWarningMessage,
        }
      : undefined
  const oauthClientCredentialsRequired =
    Boolean(oauthClientID?.trim()) ||
    Boolean(oauthClientSecret?.trim()) ||
    (authMode === "oauth" &&
      oauthDiscoveryState === "success" &&
      !oauthRegistrationEndpoint?.trim())
  const oauthAdvancedRequiredFields = React.useMemo(
    () =>
      new Set<OauthAdvancedFieldName>(
        authMode !== "oauth"
          ? []
          : oauthDiscoveryState === "manual"
            ? ["oauth_issuer", "oauth_authorization_endpoint", "oauth_token_endpoint"]
            : oauthDiscoveryState === "success"
              ? [
                  ...(!oauthIssuer?.trim() ? (["oauth_issuer"] as const) : []),
                  ...(!oauthAuthorizationEndpoint?.trim()
                    ? (["oauth_authorization_endpoint"] as const)
                    : []),
                  ...(!oauthTokenEndpoint?.trim() ? (["oauth_token_endpoint"] as const) : []),
                ]
              : []
      ),
    [authMode, oauthAuthorizationEndpoint, oauthDiscoveryState, oauthIssuer, oauthTokenEndpoint]
  )
  const requiredConditionalFields = React.useMemo(
    () => [
      ...(oauthClientCredentialsRequired
        ? (["oauth_client_id", "oauth_client_secret"] as const)
        : []),
      ...oauthAdvancedRequiredFields,
    ],
    [oauthAdvancedRequiredFields, oauthClientCredentialsRequired]
  )
  const hasOAuthClientCredentialsAttention =
    authMode === "oauth" &&
    (oauthClientCredentialsRequired ||
      Boolean(errors.oauth_client_id) ||
      Boolean(errors.oauth_client_secret))
  const hasOAuthAdvancedAttention =
    authMode === "oauth" &&
    (oauthAdvancedRequiredFields.size > 0 ||
      Boolean(discoveryWarningKey && discoveryWarningKey !== dismissedDiscoveryWarningKey) ||
      oauthAdvancedFields.some((field) => Boolean(errors[field.name])))
  const previousAccordionAttentionRef = React.useRef({
    clientCredentials: false,
    advanced: false,
  })

  React.useEffect(() => {
    const previousAttention = previousAccordionAttentionRef.current
    const nextExpandedAccordions = new Set<string>()

    if (!previousAttention.clientCredentials && hasOAuthClientCredentialsAttention) {
      nextExpandedAccordions.add(clientCredentialsAccordionItem)
    }

    if (!previousAttention.advanced && hasOAuthAdvancedAttention) {
      nextExpandedAccordions.add(advancedAccordionItem)
    }

    previousAccordionAttentionRef.current = {
      clientCredentials: hasOAuthClientCredentialsAttention,
      advanced: hasOAuthAdvancedAttention,
    }

    if (nextExpandedAccordions.size === 0) {
      return
    }

    dispatchAccordion({
      type: "expand",
      items: [...nextExpandedAccordions],
    })
  }, [hasOAuthAdvancedAttention, hasOAuthClientCredentialsAttention])
  const previousRequiredConditionalFieldsRef = React.useRef<string>("")

  React.useEffect(() => {
    const nextRequiredFieldsKey = requiredConditionalFields.join("|")
    if (previousRequiredConditionalFieldsRef.current === nextRequiredFieldsKey) {
      return
    }

    previousRequiredConditionalFieldsRef.current = nextRequiredFieldsKey
    if (requiredConditionalFields.length === 0) {
      return
    }

    void form.trigger(requiredConditionalFields)
  }, [form, requiredConditionalFields])
  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      cleanupPopupFlow({
        closePopup: true,
        cancelPending: Boolean(oauthPopupFlowId),
      })
      form.reset(defaultValues)
      setSubmitError(undefined)
      setSuccessMessage(undefined)
      setSubmitted(false)
      dispatchAccordion({
        type: "reset",
      })
      setDismissedDiscoveryWarningKey(undefined)
      setDiscoveryURLOverride(undefined)
      previousAccordionAttentionRef.current = {
        clientCredentials: false,
        advanced: false,
      }
      previousRequiredConditionalFieldsRef.current = ""
    }

    onOpenChangeAction(nextOpen)
  }

  async function refreshDiscovery() {
    const valid = await form.trigger("endpoint_url")
    if (!valid) {
      return
    }

    const nextURL = form.getValues("endpoint_url").trim()
    if (!isHTTPSURL(nextURL)) {
      return
    }

    if (nextURL === discoveryURL) {
      await oauthQuery.refetch()
      return
    }

    setDiscoveryURLOverride(nextURL)
  }

  const title = "Connect MCP server"
  const submitLabel =
    mode === "create" ? "Connect" : authMode === "oauth" ? "Save changes" : "Update credential"

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      <SheetContent
        className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!"
        onPointerDownOutside={(event) => {
          if (!oauthPopupFlowId) {
            return
          }
          event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (!oauthPopupFlowId) {
            return
          }
          event.preventDefault()
        }}
        showCloseButton={oauthPopupFlowId === undefined}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        {discoveryWarningVisible ? (
          <Alert variant="warning" className="mx-4 mt-4 w-auto">
            <CircleAlert className="size-4" />
            <AlertTitle>Auto-discovery failed</AlertTitle>
            <AlertDescription>{discoveryWarningVisible.message}</AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setDismissedDiscoveryWarningKey(discoveryWarningVisible.key)
                }}
                aria-label="Dismiss auto-discovery warning"
              >
                <X />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {submitted ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-2">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <Check className="size-6 text-primary" />
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {successMessage ??
                `MCP server connection has been ${mode === "create" ? "created" : "updated"} successfully.`}
            </p>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit(submitValues)(event)
            }}
            className="flex flex-1 flex-col gap-5 px-4 pb-2"
          >
            <FieldGroup>
              <Field data-invalid={Boolean(errors.name)}>
                <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                <Input
                  id="mcp-name"
                  placeholder="Example MCP"
                  disabled={mode === "update"}
                  aria-invalid={Boolean(errors.name)}
                  {...form.register("name")}
                />
                {errors.name ? <FieldError errors={[errors.name]} /> : null}
              </Field>
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Controller
                  name="auth_mode"
                  control={form.control}
                  render={({ field }) => (
                    <ButtonGroup>
                      <Button
                        type="button"
                        variant={field.value === "oauth" ? "secondary" : "ghost"}
                        onClick={() => {
                          field.onChange("oauth")
                        }}
                      >
                        OAuth
                      </Button>
                      <Button
                        type="button"
                        variant={field.value === "bearer" ? "secondary" : "ghost"}
                        onClick={() => {
                          field.onChange("bearer")
                        }}
                      >
                        Bearer token
                      </Button>
                    </ButtonGroup>
                  )}
                />
              </Field>
              <ServerURLField
                control={form.control}
                authMode={authMode}
                endpointError={errors.endpoint_url}
                discoveryIconState={discoveryIconState}
                isRefreshingDiscovery={oauthQuery.fetchStatus === "fetching"}
                discoveryURLOverride={discoveryURLOverride}
                onDiscoveryURLOverrideChangeAction={setDiscoveryURLOverride}
                onRefreshDiscoveryAction={() => {
                  void refreshDiscovery()
                }}
              />
              {authMode === "oauth" ? (
                <Accordion
                  type="multiple"
                  className="rounded-lg border px-4"
                  value={userExpandedAccordions}
                  onValueChange={(value) => {
                    dispatchAccordion({
                      type: "set",
                      value,
                    })
                  }}
                >
                  <AccordionItem value={clientCredentialsAccordionItem} className="border-none">
                    <AccordionTrigger className="py-4 hover:no-underline">
                      <span>OAuth client credentials</span>
                    </AccordionTrigger>
                    <AccordionContent className="[&>div]:h-auto">
                      <FieldGroup>
                        <Field data-invalid={Boolean(errors.oauth_client_id)}>
                          <FieldLabel>Client ID</FieldLabel>
                          <Input
                            placeholder="Client ID"
                            required={oauthClientCredentialsRequired}
                            aria-invalid={Boolean(errors.oauth_client_id)}
                            {...form.register("oauth_client_id")}
                          />
                          {errors.oauth_client_id ? (
                            <FieldError errors={[errors.oauth_client_id]} />
                          ) : null}
                        </Field>
                        <Field data-invalid={Boolean(errors.oauth_client_secret)}>
                          <FieldLabel>Client secret</FieldLabel>
                          <Input
                            type="password"
                            placeholder="Client secret"
                            required={oauthClientCredentialsRequired}
                            aria-invalid={Boolean(errors.oauth_client_secret)}
                            {...form.register("oauth_client_secret")}
                          />
                          {errors.oauth_client_secret ? (
                            <FieldError errors={[errors.oauth_client_secret]} />
                          ) : null}
                        </Field>
                      </FieldGroup>
                    </AccordionContent>
                  </AccordionItem>
                  <div className="-mx-4.25">
                    <Separator />
                  </div>
                  <AccordionItem value={advancedAccordionItem} className="border-none">
                    <AccordionTrigger className="py-4 hover:no-underline">
                      <span>Advanced</span>
                    </AccordionTrigger>
                    <AccordionContent className="[&>div]:h-auto">
                      <FieldGroup>
                        {oauthAdvancedFields.map((config) => {
                          const error = errors[config.name]
                          const required = oauthAdvancedRequiredFields.has(config.name)
                          return (
                            <Field key={config.name} data-invalid={Boolean(error)}>
                              <FieldLabel>{config.label}</FieldLabel>
                              {"kind" in config && config.kind === "textarea" ? (
                                <Textarea
                                  rows={3}
                                  placeholder={config.placeholder}
                                  required={required}
                                  aria-invalid={Boolean(error)}
                                  {...form.register(config.name)}
                                />
                              ) : (
                                <Input
                                  placeholder={config.placeholder}
                                  required={required}
                                  aria-invalid={Boolean(error)}
                                  {...form.register(config.name)}
                                />
                              )}
                              {error ? <FieldError errors={[error]} /> : null}
                            </Field>
                          )
                        })}
                      </FieldGroup>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : (
                <>
                  <Field data-invalid={Boolean(errors.bearer_token)}>
                    <FieldLabel htmlFor="mcp-bearer-token">Token</FieldLabel>
                    <Input
                      id="mcp-bearer-token"
                      placeholder="API key or personal access token"
                      aria-invalid={Boolean(errors.bearer_token)}
                      {...form.register("bearer_token")}
                    />
                    {errors.bearer_token ? <FieldError errors={[errors.bearer_token]} /> : null}
                  </Field>
                  <Accordion
                    type="multiple"
                    className="rounded-lg border px-4"
                    value={userExpandedAccordions}
                    onValueChange={(value) => {
                      dispatchAccordion({
                        type: "set",
                        value,
                      })
                    }}
                  >
                    <AccordionItem value={advancedAccordionItem} className="border-none">
                      <AccordionTrigger className="py-4 hover:no-underline">
                        <span>Advanced</span>
                      </AccordionTrigger>
                      <AccordionContent className="[&>div]:h-auto" style={{ animation: "none" }}>
                        <FieldGroup>
                          <Field data-invalid={Boolean(errors.bearer_location_header_name)}>
                            <FieldLabel>Bearer token header name</FieldLabel>
                            <Input
                              placeholder="Authorization"
                              aria-invalid={Boolean(errors.bearer_location_header_name)}
                              {...form.register("bearer_location_header_name")}
                            />
                            {errors.bearer_location_header_name ? (
                              <FieldError errors={[errors.bearer_location_header_name]} />
                            ) : null}
                          </Field>
                          <Field data-invalid={Boolean(errors.bearer_location_header_prefix)}>
                            <FieldLabel>Bearer token prefix</FieldLabel>
                            <Input
                              placeholder="Bearer"
                              aria-invalid={Boolean(errors.bearer_location_header_prefix)}
                              {...form.register("bearer_location_header_prefix")}
                            />
                            {errors.bearer_location_header_prefix ? (
                              <FieldError errors={[errors.bearer_location_header_prefix]} />
                            ) : null}
                          </Field>
                        </FieldGroup>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </>
              )}
              <Field>
                <FieldLabel>Extra headers</FieldLabel>
                <div className="flex flex-col gap-4">
                  {headerFields.fields.map((item, index) => (
                    <div key={item.id} className="flex items-start gap-4">
                      <Field
                        className="flex-1"
                        data-invalid={Boolean(errors.extra_headers?.[index]?.key)}
                      >
                        <Input
                          placeholder={`Key ${index + 1}`}
                          aria-invalid={Boolean(errors.extra_headers?.[index]?.key)}
                          {...form.register(`extra_headers.${index}.key`)}
                        />
                        {errors.extra_headers?.[index]?.key ? (
                          <FieldError errors={[errors.extra_headers[index].key]} />
                        ) : null}
                      </Field>
                      <Field
                        className="flex-1"
                        data-invalid={Boolean(errors.extra_headers?.[index]?.value)}
                      >
                        <Textarea
                          rows={2}
                          placeholder={`Value ${index + 1}`}
                          aria-invalid={Boolean(errors.extra_headers?.[index]?.value)}
                          {...form.register(`extra_headers.${index}.value`)}
                        />
                        {errors.extra_headers?.[index]?.value ? (
                          <FieldError errors={[errors.extra_headers[index].value]} />
                        ) : null}
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-1"
                        onClick={() => {
                          headerFields.remove(index)
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit"
                    onClick={() => {
                      headerFields.append({ key: "", value: "" })
                    }}
                  >
                    + Add
                  </Button>
                </div>
              </Field>
            </FieldGroup>
            {submitError ? (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertTitle>Connection failed</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={
                  !isValid ||
                  isPending ||
                  oauthPopupFlowId !== undefined ||
                  isDiscoveryPendingForCurrentURL
                }
              >
                {isPending || oauthPopupFlowId || isDiscoveryPendingForCurrentURL ? (
                  <Spinner />
                ) : null}
                {oauthPopupFlowId
                  ? "Waiting for OAuth"
                  : isPending
                    ? `${submitLabel}ing`
                    : submitLabel}
              </Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}
