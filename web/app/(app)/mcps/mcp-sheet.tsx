"use client"

import * as React from "react"
import { toast } from "sonner"
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
  type UseFormReturn,
} from "react-hook-form"
import * as z from "zod"
import {
  Check,
  ChevronDown,
  CircleAlert,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react"
import {
  findMcpServerByURL,
  mcpServers,
  renderMcpServerIcon,
  type McpServer,
} from "@/app/(app)/mcps/catalog"
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
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
import { DisabledReason } from "@/components/ui/tooltip"
import { type McpFormState, type SubmitMcpFormAction } from "@/data/mcp.actions"
import { mcpFormSchema, type McpFormInput, type McpFormValues } from "@/data/mcp.schema"
import { useOAuthPopup } from "@/lib/use-oauth-popup"

type SubmitMcpAction = (_: McpFormState, action: SubmitMcpFormAction) => Promise<McpFormState>

const initialSubmitState: McpFormState = {}

const defaultFormValues: McpFormInput = {
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
const discoveryURLSchema = z
  .url({ protocol: /^https?$/, error: "MCP server URL must be a valid HTTP(S) URL" })
  .refine(
    (value) => !/^https?:\/\/[^/?#]*@/.test(value),
    "MCP server URL must not include credentials"
  )
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
  default_scopes: z.array(z.string()).optional(),
  supported_scopes: z.array(z.string()).optional(),
})
const oauthDiscoveryErrorSchema = z.object({
  message: z.string(),
})

type OauthAdvancedFieldName = (typeof oauthAdvancedFields)[number]["name"]
type ServerErrorField = (typeof serverErrorFields)[number]
type OAuthDiscoveryPayload = z.infer<typeof oauthDiscoveryResponseSchema>
type OAuthDiscoveryResponse = OAuthDiscoveryPayload & {
  endpointURL: string
}
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

function isServerErrorField(value: string): value is ServerErrorField {
  return serverErrorFields.some((field) => field === value)
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
      const payload = await response.json()

      if (!response.ok) {
        const parsedError = oauthDiscoveryErrorSchema.safeParse(payload)
        throw new Error(parsedError.success ? parsedError.data.message : discoveryErrorMessage)
      }

      return {
        ...oauthDiscoveryResponseSchema.parse(payload),
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

function applyServerErrors(
  form: UseFormReturn<McpFormInput, undefined, McpFormValues>,
  state: McpFormState
) {
  if (!state.error?.errors) {
    return
  }

  for (const error of state.error.errors) {
    if (isServerErrorField(error.field)) {
      form.setError(error.field, {
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

    const key = match[2]
    if (key !== "key" && key !== "value") {
      continue
    }

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
      return isServerErrorField(item.field) || item.field.startsWith("extra_headers.")
    }) ?? []
  const hasGeneralError = !error.errors || error.errors.length > fieldErrors.length

  return hasGeneralError ? error.message : undefined
}

function ServerURLField({
  control,
  authMode,
  endpointError,
  discoveryIconState,
  isRefreshingDiscovery,
  discoveryURLOverride,
  onDiscoveryURLOverrideChangeAction,
  onRefreshDiscoveryAction,
}: {
  control: Control<McpFormInput, undefined, McpFormValues>
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
  const [highlightedResultIndex, setHighlightedResultIndex] = React.useState(0)
  const serverFieldRef = React.useRef<HTMLDivElement | null>(null)
  const serverInputRef = React.useRef<HTMLInputElement | null>(null)
  const serverPopoverRef = React.useRef<HTMLDivElement | null>(null)
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

    const customURL = discoveryURLSchema.safeParse(query)
    if (customURL.success && !hasExactCatalogURL) {
      results.push({
        kind: "custom",
        mcpUrl: customURL.data,
      })
    }

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

  const highlightedResult = serverResults[highlightedResultIndex]

  return (
    <Field data-invalid={Boolean(endpointError)}>
      <FieldLabel htmlFor="mcp-endpoint-url" required>
        MCP connection endpoint
      </FieldLabel>
      <Popover open={serverPickerOpen} onOpenChange={setServerPickerOpen}>
        <PopoverAnchor asChild>
          <InputGroup ref={serverFieldRef}>
            <InputGroupAddon className="pr-0">
              {renderMcpServerIcon((field.value ?? "").trim(), {
                className: "pointer-events-none size-4",
              })}
            </InputGroupAddon>
            <InputGroupInput
              id="mcp-endpoint-url"
              name={field.name}
              ref={(node) => {
                field.ref(node)
                serverInputRef.current = node
              }}
              value={field.value ?? ""}
              onFocus={() => {
                setHighlightedResultIndex(0)
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
                  setHighlightedResultIndex(0)
                  setServerPickerOpen(true)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  setServerPickerOpen(false)
                  serverInputRef.current?.focus()
                } else if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setServerPickerOpen(true)
                  setHighlightedResultIndex((index) =>
                    serverResults.length === 0 ? 0 : Math.min(index + 1, serverResults.length - 1)
                  )
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setHighlightedResultIndex((index) => Math.max(index - 1, 0))
                } else if (event.key === "Enter" && serverPickerOpen) {
                  const result = serverResults[highlightedResultIndex]
                  if (result) {
                    event.preventDefault()
                    selectServer(result)
                  }
                }
              }}
              placeholder="https://example.com/mcp"
              aria-invalid={Boolean(endpointError)}
              aria-required="true"
              aria-expanded={serverPickerOpen}
              aria-autocomplete="list"
              aria-controls="mcp-endpoint-url-suggestions"
              role="combobox"
            />
            <InputGroupAddon align="inline-end" className="gap-0 pl-0">
              {authMode === "oauth" ? (
                <InputGroupButton
                  size="icon-xs"
                  onClick={onRefreshDiscoveryAction}
                  disabled={isRefreshingDiscovery}
                  aria-label="Discover OAuth metadata"
                  aria-busy={isRefreshingDiscovery}
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
                </InputGroupButton>
              ) : null}
              <ChevronDown className="pointer-events-none size-4" aria-hidden="true" />
            </InputGroupAddon>
          </InputGroup>
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
          <Command
            shouldFilter={false}
            value={
              highlightedResult?.kind === "catalog"
                ? highlightedResult.server.mcpUrl
                : highlightedResult?.mcpUrl
            }
          >
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
                        <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border">
                          <Icon />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{result.server.name}</span>
                          <span className="text-muted-foreground block truncate text-xs">
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
                      <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border">
                        <Settings2 />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">Custom Server</span>
                        <span className="text-muted-foreground block truncate text-xs">
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
}

export function McpSheet({
  children,
  submitMcpAction,
}: {
  children: React.ReactNode
  submitMcpAction: SubmitMcpAction
}) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const [isRefreshing, startTransition] = React.useTransition()
  const [submitState, submitAction, isSubmitting] = React.useActionState(
    submitMcpAction,
    initialSubmitState
  )
  const form = useForm<McpFormInput, undefined, McpFormValues>({
    resolver: zodResolver(mcpFormSchema),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: defaultFormValues,
  })
  const { errors, isValid } = form.formState
  const headerFields = useFieldArray({
    control: form.control,
    name: "extra_headers",
  })
  const authMode = useWatch({
    control: form.control,
    name: "auth_mode",
    defaultValue: defaultFormValues.auth_mode,
  })
  const oauthDiscoveryState = useWatch({
    control: form.control,
    name: "oauth_discovery_state",
    defaultValue: defaultFormValues.oauth_discovery_state,
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
    oauthClientID = defaultFormValues.oauth_client_id,
    oauthClientSecret = defaultFormValues.oauth_client_secret,
    oauthRegistrationEndpoint = defaultFormValues.oauth_registration_endpoint,
    oauthIssuer = defaultFormValues.oauth_issuer,
    oauthAuthorizationEndpoint = defaultFormValues.oauth_authorization_endpoint,
    oauthTokenEndpoint = defaultFormValues.oauth_token_endpoint,
  ] = oauthFields
  const [clientSubmitError, setClientSubmitError] = React.useState<string>()
  const {
    cleanup: cleanupPopupFlow,
    flowId: oauthPopupFlowId,
    open: openOAuthPopup,
  } = useOAuthPopup("mcp-oauth")
  const [userExpandedAccordions, dispatchAccordion] = React.useReducer(accordionReducer, [])
  const [dismissedDiscoveryWarningKey, setDismissedDiscoveryWarningKey] = React.useState<string>()
  const [discoveryURLOverride, setDiscoveryURLOverride] = React.useState<string>()
  const [hasTriggeredDiscovery, setHasTriggeredDiscovery] = React.useState(true)
  const shouldResetSubmitStateRef = React.useRef(false)
  const endpointURL = useWatch({
    control: form.control,
    name: "endpoint_url",
    defaultValue: defaultFormValues.endpoint_url,
  })
  const trimmedEndpointURL = endpointURL.trim()
  const debouncedEndpointURL = useDebouncedValue(trimmedEndpointURL, discoveryDebounceMs)
  const validEndpointURL = discoveryURLSchema.safeParse(trimmedEndpointURL).success
  const discoveryURL = discoveryURLOverride ?? debouncedEndpointURL
  const oauthQuery = useQuery({
    ...oauthDiscoveryQueryOptions(discoveryURL),
    enabled:
      authMode === "oauth" &&
      hasTriggeredDiscovery &&
      discoveryURLSchema.safeParse(discoveryURL).success,
  })
  const { refetch: refetchOAuthDiscovery } = oauthQuery
  const oauthDiscoveryData = oauthQuery.data?.oauth
  const discoveredDefaultScopes = oauthQuery.data?.default_scopes
  const discoveredSupportedScopes = oauthQuery.data?.supported_scopes
  const discoveredAdditionalScopes = React.useMemo(() => {
    if (!discoveredSupportedScopes?.length) {
      return undefined
    }

    const defaultScopeSet = new Set(discoveredDefaultScopes ?? [])
    const additionalScopes = discoveredSupportedScopes.filter(
      (scope) => !defaultScopeSet.has(scope)
    )
    if (additionalScopes.length === 0) {
      return undefined
    }
    return additionalScopes
  }, [discoveredDefaultScopes, discoveredSupportedScopes])
  const isCurrentDiscoveryTarget = discoveryURL === trimmedEndpointURL
  const isCurrentDiscoveryResult = oauthQuery.data?.endpointURL === trimmedEndpointURL
  const discoveryWarningMessage =
    oauthQuery.error instanceof Error ? oauthQuery.error.message : undefined
  const discoveryWarningURL =
    authMode === "oauth" &&
    hasTriggeredDiscovery &&
    isCurrentDiscoveryTarget &&
    discoveryURLSchema.safeParse(discoveryURL).success
      ? discoveryURL
      : undefined
  const discoveryWarningKey =
    discoveryWarningURL && discoveryWarningMessage
      ? `${discoveryWarningURL}:${discoveryWarningMessage}`
      : undefined
  const isDiscoveryPendingForCurrentURL =
    authMode === "oauth" &&
    hasTriggeredDiscovery &&
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
    authMode !== "oauth" || !validEndpointURL || !isCurrentDiscoveryTarget || !hasTriggeredDiscovery
      ? "idle"
      : oauthQuery.fetchStatus === "fetching"
        ? "loading"
        : oauthQuery.isError
          ? "error"
          : isCurrentDiscoveryResult && oauthQuery.isSuccess
            ? "success"
            : "idle"

  const resetSubmitState = React.useCallback(() => {
    shouldResetSubmitStateRef.current = false
    startTransition(() => {
      submitAction({
        type: "reset",
      })
    })
  }, [startTransition, submitAction])

  React.useLayoutEffect(() => {
    return () => {
      if (!shouldResetSubmitStateRef.current) {
        return
      }

      resetSubmitState()
    }
  }, [resetSubmitState])

  React.useEffect(() => {
    if (open) {
      form.reset(defaultFormValues)
    }
  }, [form, open])

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

    const discoveredValues = {
      oauth_issuer: oauthDiscoveryData.issuer ?? "",
      oauth_authorization_endpoint: oauthDiscoveryData.authorization_endpoint ?? "",
      oauth_token_endpoint: oauthDiscoveryData.token_endpoint ?? "",
      oauth_registration_endpoint: oauthDiscoveryData.registration_endpoint ?? "",
      oauth_resource: oauthDiscoveryData.resource ?? "",
      oauth_scopes: discoveredDefaultScopes?.join("\n") ?? "",
      oauth_location_header_name: oauthDiscoveryData.location?.header?.name ?? "Authorization",
      oauth_location_header_prefix: oauthDiscoveryData.location?.header?.prefix ?? "Bearer",
    } satisfies Record<OauthAdvancedFieldName, string>

    for (const fieldName of oauthAdvancedFields.map((field) => field.name)) {
      form.setValue(fieldName, discoveredValues[fieldName], {
        shouldValidate: true,
      })
    }
  }, [
    authMode,
    form,
    isCurrentDiscoveryTarget,
    discoveredDefaultScopes,
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

  React.useEffect(() => {
    if (!open) {
      return
    }

    applyServerErrors(form, submitState)

    if (submitState.error) {
      shouldResetSubmitStateRef.current = true
      return
    }

    if (submitState.oauth) {
      shouldResetSubmitStateRef.current = true
      openOAuthPopup(submitState.oauth, {
        onError: setClientSubmitError,
        onSuccess() {
          toast.success("MCP connection created")
          setClientSubmitError(undefined)
          form.reset(defaultFormValues)
          setOpen(false)
          startTransition(() => {
            router.refresh()
          })
        },
      })
      return
    }

    if (!submitState.success) {
      return
    }

    toast.success("MCP connection created")
    shouldResetSubmitStateRef.current = true
    queueMicrotask(() => {
      setClientSubmitError(undefined)
      form.reset(defaultFormValues)
      setOpen(false)
      startTransition(() => {
        router.refresh()
      })
    })
  }, [form, open, openOAuthPopup, router, startTransition, submitState])

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
  const submitError =
    clientSubmitError ??
    (submitState.error
      ? (generalErrorMessage(submitState.error) ?? submitState.error.message)
      : undefined)
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
      shouldResetSubmitStateRef.current = true
      cleanupPopupFlow({
        closePopup: true,
        cancelPending: Boolean(oauthPopupFlowId),
      })
      form.reset(defaultFormValues)
      setClientSubmitError(undefined)
      dispatchAccordion({
        type: "reset",
      })
      setDismissedDiscoveryWarningKey(undefined)
      setDiscoveryURLOverride(undefined)
      setHasTriggeredDiscovery(true)
      previousAccordionAttentionRef.current = {
        clientCredentials: false,
        advanced: false,
      }
      previousRequiredConditionalFieldsRef.current = ""
      resetSubmitState()
    }

    setOpen(nextOpen)
  }

  async function refreshDiscovery() {
    const valid = await form.trigger("endpoint_url")
    if (!valid) {
      return
    }

    const nextURL = trimmedEndpointURL
    if (!discoveryURLSchema.safeParse(nextURL).success) {
      return
    }

    setHasTriggeredDiscovery(true)
    if (nextURL === discoveryURL) {
      await refetchOAuthDiscovery()
      return
    }

    setDiscoveryURLOverride(nextURL)
  }

  function submitFormAction(values: McpFormValues) {
    const formData = new FormData()
    for (const fieldName of scalarFormDataFields) {
      if (fieldName === "oauth_scopes") {
        formData.set(fieldName, values.oauth_scopes.join("\n"))
        continue
      }

      formData.set(fieldName, values[fieldName] ?? "")
    }
    for (const header of values.extra_headers) {
      formData.append("extra_header_key", header.key)
      formData.append("extra_header_value", header.value)
    }
    React.startTransition(() => {
      submitAction({
        type: "submit",
        formData,
      })
    })
  }

  function invalidSubmitAction() {
    setClientSubmitError(undefined)
  }

  const title = "Add MCP connection"
  const submitLabel = "Add connection"
  const submitPending =
    isSubmitting ||
    isRefreshing ||
    oauthPopupFlowId !== undefined ||
    isDiscoveryPendingForCurrentURL
  const authenticationIncomplete =
    authMode === "bearer"
      ? !form.getValues("bearer_token")?.trim()
      : requiredConditionalFields.some((fieldName) => !form.getValues(fieldName)?.trim())
  const submitDisabledReason =
    submitPending || isValid
      ? undefined
      : !trimmedEndpointURL
        ? "Enter the MCP endpoint URL."
        : !validEndpointURL
          ? "Enter a valid HTTP(S) endpoint URL."
          : authenticationIncomplete
            ? "Complete the required authentication fields."
            : authMode === "oauth" &&
                (oauthDiscoveryState === "idle" || oauthDiscoveryState === "discovering")
              ? "Complete OAuth discovery for this endpoint or enter the required fields manually."
              : authMode === "oauth" && oauthQuery.isError
                ? "OAuth discovery failed for this endpoint. Refresh discovery or enter the required fields manually."
                : !form.getValues("name").trim()
                  ? "Enter a connection name."
                  : "Fix the invalid header or provider fields before adding the connection."
  const submitButton = (
    <Button type="submit" disabled={!isValid || submitPending} aria-busy={submitPending}>
      {submitPending ? <Spinner /> : <Save data-icon="inline-start" />}
      {oauthPopupFlowId
        ? "Waiting for OAuth…"
        : isDiscoveryPendingForCurrentURL
          ? "Discovering OAuth…"
          : isSubmitting || isRefreshing
            ? "Adding connection…"
            : submitLabel}
    </Button>
  )

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      {children}
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
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setClientSubmitError(undefined)
            form.clearErrors()
            void form.handleSubmit(submitFormAction, invalidSubmitAction)()
          }}
          className="flex flex-1 flex-col gap-5 px-4 pb-2"
        >
          <FieldGroup>
            <Field data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="mcp-name" required>
                Name
              </FieldLabel>
              <Input
                id="mcp-name"
                placeholder="my-mcp"
                aria-invalid={Boolean(errors.name)}
                aria-required="true"
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
                        <FieldLabel required={oauthClientCredentialsRequired}>Client ID</FieldLabel>
                        <Input
                          placeholder="Client ID"
                          aria-invalid={Boolean(errors.oauth_client_id)}
                          aria-required={oauthClientCredentialsRequired}
                          {...form.register("oauth_client_id")}
                        />
                        {errors.oauth_client_id ? (
                          <FieldError errors={[errors.oauth_client_id]} />
                        ) : null}
                      </Field>
                      <Field data-invalid={Boolean(errors.oauth_client_secret)}>
                        <FieldLabel required={oauthClientCredentialsRequired}>
                          Client secret
                        </FieldLabel>
                        <Input
                          type="password"
                          placeholder="Client secret"
                          aria-invalid={Boolean(errors.oauth_client_secret)}
                          aria-required={oauthClientCredentialsRequired}
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
                            <FieldLabel required={required}>{config.label}</FieldLabel>
                            {"kind" in config && config.kind === "textarea" ? (
                              <Textarea
                                rows={3}
                                placeholder={config.placeholder}
                                aria-invalid={Boolean(error)}
                                aria-required={required}
                                {...form.register(config.name)}
                              />
                            ) : (
                              <Input
                                placeholder={config.placeholder}
                                aria-invalid={Boolean(error)}
                                aria-required={required}
                                {...form.register(config.name)}
                              />
                            )}
                            {config.name === "oauth_scopes" ? (
                              <FieldDescription>
                                {discoveredAdditionalScopes?.length
                                  ? `Additional allowed scopes: ${discoveredAdditionalScopes.join(", ")}`
                                  : ""}
                              </FieldDescription>
                            ) : null}
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
                  <FieldLabel htmlFor="mcp-bearer-token" required>
                    Token
                  </FieldLabel>
                  <Input
                    id="mcp-bearer-token"
                    type="password"
                    placeholder="API key or personal access token"
                    aria-invalid={Boolean(errors.bearer_token)}
                    aria-required="true"
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
                      variant="destructive"
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
            {submitDisabledReason ? (
              <DisabledReason reason={submitDisabledReason}>{submitButton}</DisabledReason>
            ) : (
              submitButton
            )}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
