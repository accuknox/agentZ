"use client"

import * as React from "react"
import Fuse from "fuse.js"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { Check, ChevronDown, RefreshCw, Settings2, Trash2, X } from "lucide-react"
import { findMcpServerByURL, mcpFallbackIcon, mcpServers, type McpServer } from "@/app/mcps/catalog"
import type { McpConnection } from "@/lib/gateway/client"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Separator } from "@/components/ui/separator"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { authModeOf } from "@/lib/mcp"
import {
  oauthBroadcastChannelName,
  parseOAuthPopupMessage,
  type OAuthPopupMessage,
  oauthWindowMessageSource,
} from "@/lib/mcp-oauth-shared"
import type { McpFormState } from "@/data/mcp.actions"
import {
  formBearerDefaults,
  formOAuthDefaults,
  mcpFormSchema,
  type McpFormInput,
} from "@/data/mcp.schema"

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
const oauthAdvancedFieldNames = [
  "oauth_issuer",
  "oauth_authorization_endpoint",
  "oauth_token_endpoint",
  "oauth_registration_endpoint",
  "oauth_resource",
  "oauth_scopes",
  "oauth_location_header_name",
  "oauth_location_header_prefix",
] as const
const directServerErrorFields = [
  "name",
  "endpoint_url",
  "bearer_token",
  "oauth_client_id",
  "oauth_client_secret",
  ...oauthAdvancedFieldNames,
  "bearer_location_header_name",
  "bearer_location_header_prefix",
] as const
const generalErrorFields = [
  "name",
  "endpoint_url",
  "bearer_token",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_issuer",
  "oauth_authorization_endpoint",
  "oauth_token_endpoint",
  "oauth_registration_endpoint",
  "oauth_resource",
  "oauth_scopes",
  "oauth_location_header_name",
  "oauth_location_header_prefix",
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

type OauthAdvancedFieldName = (typeof oauthAdvancedFieldNames)[number]
type DirectServerErrorField = (typeof directServerErrorFields)[number]

type DiscoveryIconState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success" }
  | { status: "error" }

type DiscoveryResultState = {
  endpointURL: string
  message?: string
} & DiscoveryIconState

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
    const field = error.field

    if (directServerErrorFields.includes(field as DirectServerErrorField)) {
      const directServerErrorField = field as DirectServerErrorField
      form.setError(directServerErrorField, {
        type: "server",
        message: error.message,
      })
      continue
    }

    if (field.startsWith("extra_headers.")) {
      const path = parseExtraHeaderFieldPath(field)
      if (!path) {
        continue
      }
      form.setError(path, {
        type: "server",
        message: error.message,
      })
    }
  }
}

function parseExtraHeaderFieldPath(field: string) {
  const match = /^extra_headers\.(\d+)\.(key|value)$/.exec(field)
  if (!match) {
    return undefined
  }

  const [, indexText, key] = match
  const index = Number(indexText)
  if (!Number.isInteger(index)) {
    return undefined
  }

  if (key === "key") {
    return `extra_headers.${index}.key` as const
  }

  return `extra_headers.${index}.value` as const
}

function generalErrorMessage(error: McpFormState["error"]) {
  if (!error) {
    return undefined
  }

  const fieldErrors =
    error.errors?.filter((item) => {
      if (!item.field) {
        return false
      }

      return (
        generalErrorFields.includes(item.field as (typeof generalErrorFields)[number]) ||
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
    defaultValues,
  })
  const headerFields = useFieldArray({
    control: form.control,
    name: "extra_headers",
  })
  const authMode = useWatch({
    control: form.control,
    name: "auth_mode",
    defaultValue: defaultValues.auth_mode,
  })
  const endpointURL = useWatch({
    control: form.control,
    name: "endpoint_url",
    defaultValue: defaultValues.endpoint_url,
  })
  const nameValue = useWatch({
    control: form.control,
    name: "name",
    defaultValue: defaultValues.name,
  })
  const bearerTokenValue = useWatch({
    control: form.control,
    name: "bearer_token",
    defaultValue: defaultValues.bearer_token,
  })
  const oauthClientIDValue = useWatch({
    control: form.control,
    name: "oauth_client_id",
    defaultValue: defaultValues.oauth_client_id,
  })
  const oauthClientSecretValue = useWatch({
    control: form.control,
    name: "oauth_client_secret",
    defaultValue: defaultValues.oauth_client_secret,
  })
  const { errors } = form.formState

  const [oauthPopupFlowId, setOauthPopupFlowId] = React.useState<string>()
  const [oauthFlowError, setOauthFlowError] = React.useState<string>()
  const [discoveryResult, setDiscoveryResult] = React.useState<DiscoveryResultState>({
    endpointURL: "",
    status: "idle",
  })
  const discoveryState =
    discoveryResult.endpointURL === endpointURL ? discoveryResult.status : "idle"
  const discoveryError =
    discoveryResult.endpointURL === endpointURL ? discoveryResult.message : undefined

  // track which accordion items the user has manually toggled.
  const [userExpandedAccordions, setUserExpandedAccordions] = React.useState<string[]>([])

  // derive the effective accordion state during render. Auto-expand the client
  // credentials section when there are validation errors for OAuth
  // client-id/secret fields.
  const expandedAccordions = (() => {
    if (authMode !== "oauth") {
      return userExpandedAccordions
    }

    const hasClientCredentialError =
      Boolean(errors.oauth_client_id) ||
      Boolean(errors.oauth_client_secret) ||
      oauthFlowError?.includes("client credentials") === true
    const hasAdvancedError = oauthAdvancedFieldNames.some((fieldName) => Boolean(errors[fieldName]))
    const nextExpandedAccordions = new Set(userExpandedAccordions)

    if (hasClientCredentialError) {
      nextExpandedAccordions.add(clientCredentialsAccordionItem)
    }

    if (hasAdvancedError) {
      nextExpandedAccordions.add(advancedAccordionItem)
    }

    return [...nextExpandedAccordions]
  })()
  const oauthRequiresClientCredentials =
    Boolean(oauthClientIDValue?.trim()) || Boolean(oauthClientSecretValue?.trim())
  const oauthHasAdvancedError = oauthAdvancedFieldNames.some((fieldName) =>
    Boolean(errors[fieldName])
  )
  const canSubmit =
    nameValue.trim() &&
    endpointURL.trim() &&
    (authMode === "bearer"
      ? Boolean(bearerTokenValue?.trim())
      : oauthRequiresClientCredentials
        ? Boolean(oauthClientIDValue?.trim()) &&
          Boolean(oauthClientSecretValue?.trim()) &&
          !oauthHasAdvancedError
        : !oauthHasAdvancedError)
  const [submitError, setSubmitError] = React.useState<string>()
  const [successMessage, setSuccessMessage] = React.useState<string>()
  const [submitted, setSubmitted] = React.useState(false)
  const [serverPickerOpen, setServerPickerOpen] = React.useState(false)
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const mountedRef = React.useRef(true)
  const messageHandlerRef = React.useRef<((event: MessageEvent<unknown>) => void) | null>(null)
  const serverFieldRef = React.useRef<HTMLDivElement | null>(null)
  const serverInputRef = React.useRef<HTMLInputElement | null>(null)
  const serverPopoverRef = React.useRef<HTMLDivElement | null>(null)

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

  const deferredEndpointURL = React.useDeferredValue(endpointURL)
  const selectedServer = React.useMemo(() => findMcpServerByURL(endpointURL), [endpointURL])
  const SelectedServerIcon = selectedServer?.icon ?? mcpFallbackIcon
  const serverResults = React.useMemo(() => {
    const query = deferredEndpointURL.trim()
    const catalogResults = query
      ? mcpServerSearch.search(query).map((result) => result.item)
      : mcpServers.slice(0, initialServerResults)
    const results: McpCatalogResult[] = catalogResults.map((server) => ({
      kind: "catalog",
      server,
    }))
    const hasExactCatalogURL = findMcpServerByURL(query) !== undefined

    if (query) {
      let customURL: URL | undefined
      try {
        customURL = new URL(query)
      } catch {
        customURL = undefined
      }

      if (customURL?.protocol === "https:" && !hasExactCatalogURL) {
        results.push({
          kind: "custom",
          mcpUrl: query,
        })
      }
    }

    return results
  }, [deferredEndpointURL])

  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      cleanupPopupFlow({
        closePopup: true,
        cancelPending: Boolean(oauthPopupFlowId),
      })
      form.reset(defaultValues)
      setOauthFlowError(undefined)
      setDiscoveryResult({
        endpointURL: "",
        status: "idle",
      })
      setSubmitError(undefined)
      setSuccessMessage(undefined)
      setSubmitted(false)
      setServerPickerOpen(false)
      setUserExpandedAccordions([])
    }
    onOpenChangeAction(nextOpen)
  }

  const openOAuthPopup = React.useCallback(
    (oauth: { flowId: string; url: string }) => {
      setOauthFlowError(undefined)
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
          setOauthFlowError(undefined)
          setSuccessMessage(message.message)
          setSubmitted(true)
          startTransition(() => {
            router.refresh()
          })
          return
        }

        setOauthFlowError(message.message)
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
        channel.onmessage = (event: MessageEvent<OAuthPopupMessage>) =>
          handlePopupMessage(event.data)
        broadcastChannelRef.current = channel
      }

      const popup = window.open(
        oauth.url,
        `mcp-oauth-${oauth.flowId}`,
        "popup=yes,width=520,height=760,resizable=yes,scrollbars=yes"
      )
      if (!popup) {
        finishPopupFlow()
        setOauthFlowError("OAuth popup was blocked by the browser. Allow popups and try again.")
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
        setOauthFlowError("OAuth popup was closed before authentication completed.")
      }, 400)
    },
    [cancelPendingOAuthFlow, cleanupPopupFlow, router]
  )

  async function refreshOAuthDiscovery() {
    const isValid = await form.trigger("endpoint_url")
    if (!isValid) {
      return
    }

    const nextEndpointURL = form.getValues("endpoint_url")
    setDiscoveryResult({
      endpointURL: nextEndpointURL,
      status: "loading",
    })

    try {
      const response = await fetch("/mcps/oauth/discovery", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          endpointUrl: nextEndpointURL,
        }),
      })
      const payload = (await response.json()) as {
        oauth?: {
          issuer?: string
          authorization_endpoint?: string
          token_endpoint?: string
          registration_endpoint?: string
          resource?: string
          scopes?: string[]
          location?: {
            header?: {
              name?: string
              prefix?: string
            }
          }
        }
        message?: string
      }

      if (payload.oauth) {
        form.setValue("oauth_issuer", payload.oauth.issuer ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_authorization_endpoint", payload.oauth.authorization_endpoint ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_token_endpoint", payload.oauth.token_endpoint ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_registration_endpoint", payload.oauth.registration_endpoint ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_resource", payload.oauth.resource ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_scopes", payload.oauth.scopes?.join("\n") ?? "", {
          shouldDirty: true,
        })
        form.setValue("oauth_location_header_name", payload.oauth.location?.header?.name ?? "", {
          shouldDirty: true,
        })
        form.setValue(
          "oauth_location_header_prefix",
          payload.oauth.location?.header?.prefix ?? "",
          { shouldDirty: true }
        )
      }

      if (!response.ok) {
        setDiscoveryResult({
          endpointURL: nextEndpointURL,
          status: "error",
          message: payload.message ?? "OAuth metadata could not be discovered.",
        })
        return
      }

      setDiscoveryResult({
        endpointURL: nextEndpointURL,
        status: payload.message ? "error" : "success",
        message: payload.message,
      })
    } catch (error) {
      setDiscoveryResult({
        endpointURL: nextEndpointURL,
        status: "error",
        message: error instanceof Error ? error.message : "OAuth metadata could not be discovered.",
      })
    }
  }

  const submitValues = React.useCallback(
    async (values: McpFormInput) => {
      setOauthFlowError(undefined)
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
            setSubmitError(generalErrorMessage(nextState.error))
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
            form.reset()
            router.refresh()
          }
        })()
      })
    },
    [form, openOAuthPopup, router, submitMcpAction]
  )
  const submitAction = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void form.handleSubmit(submitValues)(event)
    },
    [form, submitValues]
  )

  const title = "Connect MCP server"
  const submitLabel =
    mode === "create" ? "Connect" : authMode === "oauth" ? "Save changes" : "Update credential"

  function selectServer(result: McpCatalogResult, onChange: (value: string) => void) {
    const nextURL = result.kind === "catalog" ? result.server.mcpUrl : result.mcpUrl
    onChange(nextURL)
    form.clearErrors("endpoint_url")
    setServerPickerOpen(false)
    serverInputRef.current?.focus()
  }

  function isInServerField(target: EventTarget | null) {
    if (!(target instanceof Node)) {
      return false
    }

    return (
      serverFieldRef.current?.contains(target) === true ||
      serverPopoverRef.current?.contains(target) === true
    )
  }

  const oauthAdvancedRequiredFields = new Set<OauthAdvancedFieldName>(
    oauthAdvancedFieldNames.filter((fieldName) => Boolean(errors[fieldName]))
  )

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
        {submitted ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-2">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-primary"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {successMessage ??
                `MCP server connection has been ${mode === "create" ? "created" : "updated"} successfully.`}
            </p>
          </div>
        ) : (
          <form onSubmit={submitAction} className="flex flex-1 flex-col gap-5 px-4 pb-2">
            <FieldGroup>
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                    <Input
                      id="mcp-name"
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      placeholder="Example MCP"
                      disabled={mode === "update"}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
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
                        onClick={() => field.onChange("oauth")}
                      >
                        OAuth
                      </Button>
                      <Button
                        type="button"
                        variant={field.value === "bearer" ? "secondary" : "ghost"}
                        onClick={() => field.onChange("bearer")}
                      >
                        Bearer token
                      </Button>
                    </ButtonGroup>
                  )}
                />
              </Field>
              <Controller
                name="endpoint_url"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
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
                            className="pr-25 pl-9"
                            aria-invalid={fieldState.invalid}
                            aria-expanded={serverPickerOpen}
                            aria-autocomplete="list"
                            aria-controls="mcp-endpoint-url-suggestions"
                            role="combobox"
                          />
                          <ChevronDown className="pointer-events-none absolute top-1/2 right-10 size-4 -translate-y-1/2 text-muted-foreground" />
                          {authMode === "oauth" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="absolute inset-y-0 right-1.5 my-auto"
                              onClick={() => {
                                void refreshOAuthDiscovery()
                              }}
                              disabled={discoveryState === "loading"}
                              aria-label="Discover OAuth metadata"
                            >
                              {discoveryState === "loading" ? (
                                <Spinner aria-hidden="true" />
                              ) : discoveryState === "success" ? (
                                <Check />
                              ) : discoveryState === "error" ? (
                                <X />
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
                        className="w-[var(--radix-popper-anchor-width)] p-0"
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
                                        selectServer(result, field.onChange)
                                      }}
                                    >
                                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                                        <Icon />
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium">
                                          {result.server.name}
                                        </span>
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
                                      selectServer(result, field.onChange)
                                    }}
                                  >
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                                      <Settings2 />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate font-medium">
                                        Custom Server
                                      </span>
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
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
              {authMode === "oauth" ? (
                <>
                  <Accordion
                    type="multiple"
                    className="rounded-lg border px-4"
                    value={expandedAccordions}
                    onValueChange={setUserExpandedAccordions}
                  >
                    <AccordionItem value={clientCredentialsAccordionItem} className="border-none">
                      <AccordionTrigger className="py-4 hover:no-underline">
                        <div className="flex items-center gap-2">
                          <span>OAuth client credentials</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {oauthRequiresClientCredentials ? "Required" : "Optional"}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="[&>div]:h-auto">
                        <FieldGroup>
                          <Controller
                            name="oauth_client_id"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Client ID</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="Client ID"
                                  required={oauthRequiresClientCredentials}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_client_secret"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Client secret</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  type="password"
                                  placeholder="Client secret"
                                  required={oauthRequiresClientCredentials}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                        </FieldGroup>
                      </AccordionContent>
                    </AccordionItem>
                    <div className="-mx-[calc(1rem+1px)]">
                      <Separator />
                    </div>
                    <AccordionItem value={advancedAccordionItem} className="border-none">
                      <AccordionTrigger className="py-4 hover:no-underline">
                        <div className="flex items-center gap-2">
                          <span>Advanced</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {oauthHasAdvancedError ? "Required" : "Optional"}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="[&>div]:h-auto">
                        <FieldGroup>
                          <Controller
                            name="oauth_issuer"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Issuer</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="https://issuer.example.com"
                                  required={oauthAdvancedRequiredFields.has("oauth_issuer")}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_authorization_endpoint"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Authorization endpoint</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="https://issuer.example.com/authorize"
                                  required={oauthAdvancedRequiredFields.has(
                                    "oauth_authorization_endpoint"
                                  )}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_token_endpoint"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Token endpoint</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="https://issuer.example.com/token"
                                  required={oauthAdvancedRequiredFields.has("oauth_token_endpoint")}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_registration_endpoint"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Registration endpoint</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="https://issuer.example.com/register"
                                  required={oauthAdvancedRequiredFields.has(
                                    "oauth_registration_endpoint"
                                  )}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_resource"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Resource</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="https://example.com/mcp"
                                  required={oauthAdvancedRequiredFields.has("oauth_resource")}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_scopes"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Scopes</FieldLabel>
                                <Textarea
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  rows={3}
                                  placeholder={"scope:read\nscope:write"}
                                  required={oauthAdvancedRequiredFields.has("oauth_scopes")}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_location_header_name"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Bearer token header name</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="Authorization"
                                  required={oauthAdvancedRequiredFields.has(
                                    "oauth_location_header_name"
                                  )}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="oauth_location_header_prefix"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Bearer token prefix</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="Bearer"
                                  required={oauthAdvancedRequiredFields.has(
                                    "oauth_location_header_prefix"
                                  )}
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                        </FieldGroup>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </>
              ) : (
                <>
                  <Controller
                    name="bearer_token"
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="mcp-bearer-token">Token</FieldLabel>
                        <Input
                          id="mcp-bearer-token"
                          name={field.name}
                          ref={field.ref}
                          value={field.value ?? ""}
                          onBlur={field.onBlur}
                          onChange={field.onChange}
                          placeholder="API key or personal access token"
                          aria-invalid={fieldState.invalid}
                        />
                        {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                      </Field>
                    )}
                  />
                  <Accordion
                    type="multiple"
                    className="rounded-lg border px-4"
                    value={userExpandedAccordions}
                    onValueChange={setUserExpandedAccordions}
                  >
                    <AccordionItem value={advancedAccordionItem} className="border-none">
                      <AccordionTrigger className="py-4 hover:no-underline">
                        <div className="flex items-center gap-2">
                          <span>Advanced</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            Optional
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="[&>div]:h-auto" style={{ animation: "none" }}>
                        <FieldGroup>
                          <Controller
                            name="bearer_location_header_name"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Bearer token header name</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="Authorization"
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
                          <Controller
                            name="bearer_location_header_prefix"
                            control={form.control}
                            render={({ field, fieldState }) => (
                              <Field data-invalid={fieldState.invalid}>
                                <FieldLabel>Bearer token prefix</FieldLabel>
                                <Input
                                  name={field.name}
                                  ref={field.ref}
                                  value={field.value ?? ""}
                                  onBlur={field.onBlur}
                                  onChange={field.onChange}
                                  placeholder="Bearer"
                                  aria-invalid={fieldState.invalid}
                                />
                                {fieldState.invalid ? (
                                  <FieldError errors={[fieldState.error]} />
                                ) : null}
                              </Field>
                            )}
                          />
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
                      <Controller
                        name={`extra_headers.${index}.key`}
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field className="flex-1" data-invalid={fieldState.invalid}>
                            <Input
                              name="extra_header_key"
                              ref={field.ref}
                              value={field.value}
                              onBlur={field.onBlur}
                              onChange={field.onChange}
                              placeholder={`Key ${index + 1}`}
                              aria-invalid={fieldState.invalid}
                            />
                            {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                          </Field>
                        )}
                      />
                      <Controller
                        name={`extra_headers.${index}.value`}
                        control={form.control}
                        render={({ field, fieldState }) => (
                          <Field className="flex-1" data-invalid={fieldState.invalid}>
                            <Textarea
                              name="extra_header_value"
                              ref={field.ref}
                              value={field.value}
                              onBlur={field.onBlur}
                              onChange={field.onChange}
                              rows={2}
                              placeholder={`Value ${index + 1}`}
                              aria-invalid={fieldState.invalid}
                            />
                            {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                          </Field>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-1"
                        onClick={() => headerFields.remove(index)}
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
                    Add item
                  </Button>
                </div>
              </Field>
            </FieldGroup>
            {submitError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {submitError}
              </p>
            ) : null}
            {oauthFlowError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {oauthFlowError}
              </p>
            ) : null}
            {discoveryError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {discoveryError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!canSubmit || isPending || oauthPopupFlowId !== undefined}
              >
                {isPending || oauthPopupFlowId ? <Spinner /> : null}
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
