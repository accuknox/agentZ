"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { Globe, Plus, Trash2 } from "lucide-react"
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
  oauthMaskedPlaceholder,
  type OAuthPopupMessage,
  oauthWindowMessageSource,
} from "@/lib/mcp-oauth-shared"
import type { McpFormState } from "@/data/mcp.actions"
import { mcpFormSchema, type McpFormInput } from "@/data/mcp.schema"

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
}

function formDefaults(connection?: McpConnection): McpFormInput {
  if (!connection) {
    return defaultFormValues
  }

  const authMode = authModeOf(connection)
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
    bearer_token: authMode === "bearer" ? oauthMaskedPlaceholder : "",
    oauth_scopes: connection.auth?.oauth?.scopes?.join("\n") ?? "",
    oauth_client_id: authMode === "oauth" ? oauthMaskedPlaceholder : "",
    oauth_client_secret: authMode === "oauth" ? oauthMaskedPlaceholder : "",
  }
}

function applyServerErrors(form: ReturnType<typeof useForm<McpFormInput>>, state: McpFormState) {
  if (!state.error?.errors) {
    return
  }

  for (const error of state.error.errors) {
    const field = error.field
    if (field === "name" || field === "endpoint_url" || field === "bearer_token") {
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
      form.setError(field as `extra_headers.${number}.key` | `extra_headers.${number}.value`, {
        type: "server",
        message: error.message,
      })
    }
  }
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

  const [expandedAccordions, setExpandedAccordions] = React.useState<string[]>([
    "client-credentials",
  ])
  const [oauthPopupFlowId, setOauthPopupFlowId] = React.useState<string>()
  const [oauthFlowError, setOauthFlowError] = React.useState<string>()
  const [submitted, setSubmitted] = React.useState(false)
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    return () => {
      mountedRef.current = false
      if (popupPollRef.current !== null) {
        window.clearInterval(popupPollRef.current)
        popupPollRef.current = null
      }
      broadcastChannelRef.current?.close()
      broadcastChannelRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!open) {
      return
    }
    form.reset(formDefaults(connection))
  }, [connection, form, open])

  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen && oauthPopupFlowId) {
      return
    }
    if (nextOpen) {
      setSubmitted(false)
    }
    if (!nextOpen) {
      form.reset(formDefaults(connection))
      setOauthFlowError(undefined)
      setSubmitted(false)
    }
    onOpenChangeAction(nextOpen)
  }

  function openOAuthPopup(oauth: { flowId: string; url: string }) {
    setOauthFlowError(undefined)
    let completed = false

    function finishPopupFlow() {
      window.removeEventListener("message", onWindowMessage)
      broadcastChannelRef.current?.close()
      broadcastChannelRef.current = null
      if (popupPollRef.current !== null) {
        window.clearInterval(popupPollRef.current)
        popupPollRef.current = null
      }
      popupRef.current = null
      setOauthPopupFlowId(undefined)
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
      if (typeof data !== "object" || data === null) {
        return
      }
      if (!("source" in data) || data.source !== oauthWindowMessageSource) {
        return
      }
      if (!("kind" in data) || data.kind !== "result") {
        return
      }
      if (!("flowId" in data) || data.flowId !== oauth.flowId) {
        return
      }

      completed = true
      acknowledgePopup(data.flowId)
      finishPopupFlow()

      if ("success" in data && data.success) {
        setOauthFlowError(undefined)
        setSubmitted(true)
        startTransition(() => {
          router.refresh()
        })
        return
      }

      setOauthFlowError(
        "message" in data && typeof data.message === "string"
          ? data.message
          : "OAuth flow could not be completed."
      )
    }

    function onWindowMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin) {
        return
      }
      handlePopupMessage(event.data)
    }

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
      setOauthFlowError("OAuth popup was closed before authentication completed.")
    }, 400)
  }

  async function submitAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    setOauthFlowError(undefined)
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
          return
        }

        if ("oauth" in nextState && nextState.oauth) {
          openOAuthPopup(nextState.oauth)
          return
        }

        if (nextState.success) {
          setSubmitted(true)
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
              MCP server connection has been {mode === "create" ? "created" : "updated"}{" "}
              successfully.
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
            <input
              type="hidden"
              name="oauth_scopes"
              value={connection?.auth?.oauth?.scopes?.join("\n") ?? ""}
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
                        className="pr-10 pl-9"
                        aria-invalid={fieldState.invalid}
                      />
                    </div>
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
              {authMode === "oauth" ? (
                <Accordion
                  type="multiple"
                  className="rounded-lg border px-4"
                  value={expandedAccordions}
                  onValueChange={setExpandedAccordions}
                >
                  <AccordionItem value="client-credentials" className="border-none">
                    <AccordionTrigger className="py-4 hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span>OAuth client credentials</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          Optional
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
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
                </Accordion>
              ) : (
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
                    <Plus />
                    Add item
                  </Button>
                </div>
              </Field>
            </FieldGroup>
            {oauthFlowError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {oauthFlowError}
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
