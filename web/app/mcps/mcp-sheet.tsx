"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { Check, Globe, RefreshCw, Trash2, X } from "lucide-react"
import type { McpConnection } from "@/lib/gateway/client"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  oauth_location_header_name: "",
  oauth_location_header_prefix: "Bearer",
  bearer_location_header_name: "",
  bearer_location_header_prefix: "Bearer",
}

const clientCredentialsAccordionItem = "client-credentials"
const advancedAccordionItem = "advanced"

type DiscoveryIconState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success" }
  | { status: "error" }

type DiscoveryResultState = {
  endpointURL: string
  message?: string
} & DiscoveryIconState

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
    extra_headers:
      Object.entries(connection.endpoint.headers).map(([key, value]) => ({ key, value })) || [],
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
    if (
      field === "name" ||
      field === "endpoint_url" ||
      field === "bearer_token" ||
      field === "oauth_location_header_name" ||
      field === "oauth_location_header_prefix" ||
      field === "bearer_location_header_name" ||
      field === "bearer_location_header_prefix"
    ) {
      form.setError(field, {
        type: "server",
        message: error.message,
      })
      continue
    }

    if (field === "oauth_client_id" || field === "oauth_client_secret") {
      form.setError(field, {
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
        [
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
        ].includes(item.field) || item.field.startsWith("extra_headers.")
      )
    }) ?? []
  const hasGeneralError = !error.errors || error.errors.length > fieldErrors.length

  return hasGeneralError ? error.message : undefined
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
  const form = useForm<McpFormInput>({
    resolver: zodResolver(mcpFormSchema),
    mode: "onBlur",
    defaultValues: formDefaults(connection),
  })
  const headerFields = useFieldArray({
    control: form.control,
    name: "extra_headers",
  })
  const authMode = useWatch({
    control: form.control,
    name: "auth_mode",
    defaultValue: formDefaults(connection).auth_mode,
  })
  const endpointURL = useWatch({
    control: form.control,
    name: "endpoint_url",
    defaultValue: formDefaults(connection).endpoint_url,
  })
  const { errors } = form.formState

  const [oauthPopupFlowId, setOauthPopupFlowId] = React.useState<string>()
  const [oauthFlowError, setOauthFlowError] = React.useState<string>()
  const [discoveryResult, setDiscoveryResult] = React.useState<DiscoveryResultState>({
    endpointURL: "",
    status: "idle",
  })
  const discoveryState =
    discoveryResult.endpointURL === endpointURL
      ? { status: discoveryResult.status }
      : { status: "idle" as const }
  const discoveryError =
    discoveryResult.endpointURL === endpointURL ? discoveryResult.message : undefined

  // track which accordion items the user has manually toggled.
  const [userExpandedAccordions, setUserExpandedAccordions] = React.useState<string[]>([])

  // derive the effective accordion state during render. Auto-expand the client
  // credentials section when there are validation errors for OAuth
  // client-id/secret fields.
  const expandedAccordions = React.useMemo(() => {
    if (authMode !== "oauth") {
      return userExpandedAccordions
    }

    const hasClientCredentialError =
      Boolean(errors.oauth_client_id) ||
      Boolean(errors.oauth_client_secret) ||
      oauthFlowError?.includes("client credentials") === true

    if (!hasClientCredentialError) {
      return userExpandedAccordions
    }

    return userExpandedAccordions.includes(clientCredentialsAccordionItem)
      ? userExpandedAccordions
      : [...userExpandedAccordions, clientCredentialsAccordionItem]
  }, [
    userExpandedAccordions,
    authMode,
    errors.oauth_client_id,
    errors.oauth_client_secret,
    oauthFlowError,
  ])
  const [submitError, setSubmitError] = React.useState<string>()
  const [successMessage, setSuccessMessage] = React.useState<string>()
  const [submitted, setSubmitted] = React.useState(false)
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const mountedRef = React.useRef(true)
  const messageHandlerRef = React.useRef<((event: MessageEvent<unknown>) => void) | null>(null)

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
    form.reset(formDefaults(connection))
  }, [connection, form, open])

  function onSheetOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setSubmitted(false)
    }
    if (!nextOpen) {
      cleanupPopupFlow({
        closePopup: true,
        cancelPending: Boolean(oauthPopupFlowId),
      })
      form.reset(formDefaults(connection))
      setOauthFlowError(undefined)
      setDiscoveryResult({
        endpointURL: "",
        status: "idle",
      })
      setSubmitError(undefined)
      setSuccessMessage(undefined)
      setSubmitted(false)
    }
    onOpenChangeAction(nextOpen)
  }

  function openOAuthPopup(oauth: { flowId: string; url: string }) {
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
      channel.onmessage = (event: MessageEvent<OAuthPopupMessage>) => handlePopupMessage(event.data)
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
  }

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

  async function submitAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    setOauthFlowError(undefined)
    setSubmitError(undefined)
    form.clearErrors()

    const formData = new FormData(formElement)
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
            <input type="hidden" name="mode" value={mode} />
            <input type="hidden" name="current_name" value={connection?.name ?? ""} />
            <input
              type="hidden"
              name="current_auth_mode"
              value={connection ? authModeOf(connection) : "none"}
            />
            <input
              type="hidden"
              name="endpoint_timeout"
              value={connection?.endpoint.timeout ?? ""}
            />
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
                    <>
                      <input type="hidden" name={field.name} value={field.value} />
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
                    </>
                  )}
                />
              </Field>
              <Controller
                name="endpoint_url"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="mcp-endpoint-url">MCP Server</FieldLabel>
                    <div className="relative">
                      <Globe className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="mcp-endpoint-url"
                        name={field.name}
                        ref={field.ref}
                        value={field.value}
                        onBlur={field.onBlur}
                        onChange={field.onChange}
                        placeholder="https://example.com/mcp"
                        className="pr-19 pl-9"
                        aria-invalid={fieldState.invalid}
                      />
                      {authMode === "oauth" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="absolute inset-y-0 right-1.5 my-auto"
                          onClick={() => {
                            void refreshOAuthDiscovery()
                          }}
                          disabled={discoveryState.status === "loading"}
                          aria-label="Discover OAuth metadata"
                        >
                          {discoveryState.status === "loading" ? (
                            <Spinner aria-hidden="true" />
                          ) : discoveryState.status === "success" ? (
                            <Check />
                          ) : discoveryState.status === "error" ? (
                            <X />
                          ) : (
                            <RefreshCw />
                          )}
                        </Button>
                      ) : null}
                    </div>
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
                            Optional
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
                    <AccordionItem value={advancedAccordionItem} className="border-none">
                      <AccordionTrigger className="py-4 hover:no-underline">
                        <div className="flex items-center gap-2">
                          <span>Advanced</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            Optional
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
              <Button type="submit" disabled={isPending || oauthPopupFlowId !== undefined}>
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
