"use client"

import * as React from "react"
import { toast } from "sonner"
import Fuse from "fuse.js"
import { zodResolver } from "@hookform/resolvers/zod"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import * as z from "zod"
import {
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
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
import { oauthSecretFormInputSchema } from "@/data/schema"
import type { PutSecretFormAction, PutSecretFormState } from "@/data/types"
import {
  oauthBroadcastChannelName,
  oauthWindowMessageSource,
  parseOAuthPopupMessage,
  type OAuthPopupMessage,
} from "@/lib/mcp-oauth-shared"
import {
  findOAuthSecretCatalogByServerURL,
  oauthSecretCatalog,
  type OAuthSecretCatalogItem,
} from "./catalog"
import { SecretHostsField } from "./secret-hosts-field"

type OAuthSecretFormInput = z.input<typeof oauthSecretFormInputSchema>
type OAuthSecretFormValues = z.output<typeof oauthSecretFormInputSchema>

const oauthDiscoveryResponseSchema = z.object({
  oauth: z
    .object({
      issuer: z.string().optional(),
      authorization_endpoint: z.string().optional(),
      token_endpoint: z.string().optional(),
      registration_endpoint: z.string().optional(),
      resource: z.string().optional(),
    })
    .optional(),
  default_scopes: z.array(z.string()).optional(),
  supported_scopes: z.array(z.string()).optional(),
})

const oauthDiscoveryErrorSchema = z.object({
  message: z.string().optional(),
})

type OAuthDiscoveryPayload = z.infer<typeof oauthDiscoveryResponseSchema> & {
  endpointURL: string
}

const clientCredentialsAccordionItem = "client-credentials"
const advancedAccordionItem = "advanced"
const discoveryDebounceMs = 500
const discoveryURLSchema = z
  .url({ protocol: /^https$/, error: "OAuth server URL must be a valid HTTPS URL" })
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false
    }

    const url = new URL(value)
    return !url.username && !url.password
  }, "OAuth server URL must not include credentials")
const initialFormValues: OAuthSecretFormInput = {
  key: "",
  endpoint_url: "",
  hosts: "",
  provider: "",
  oauth_discovery_state: "idle",
  client_id: "",
  client_secret: "",
  issuer: "",
  authorization_endpoint: "",
  token_endpoint: "",
  registration_endpoint: "",
  resource: "",
  scopes: "",
}
const oauthSecretSearch = new Fuse(oauthSecretCatalog, {
  keys: ["name", "description", "key", "serverUrl", "scopes"],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
})

const oauthDiscoveryQueryOptions = (endpointURL: string) =>
  queryOptions({
    queryKey: ["secret", "oauth-discovery", endpointURL],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${window.location.pathname}/oauth/discovery`, {
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
        const error = oauthDiscoveryErrorSchema.safeParse(payload)
        throw new Error(
          error.success
            ? (error.data.message ?? "OAuth discovery failed.")
            : "OAuth discovery failed."
        )
      }

      const parsed = oauthDiscoveryResponseSchema.parse(payload)
      return {
        endpointURL,
        oauth: parsed.oauth,
        default_scopes: parsed.default_scopes,
        supported_scopes: parsed.supported_scopes,
      } satisfies OAuthDiscoveryPayload
    },
  })

function oauthSecretFormValues(item: OAuthSecretCatalogItem): OAuthSecretFormInput {
  return {
    key: item.key,
    endpoint_url: item.serverUrl,
    hosts: item.hosts.join("\n"),
    provider: item.id,
    oauth_discovery_state: "idle",
    client_id: "",
    client_secret: "",
    issuer: item.issuer,
    authorization_endpoint: item.authorizationEndpoint,
    token_endpoint: item.tokenEndpoint,
    registration_endpoint: item.registrationEndpoint ?? "",
    resource: item.resource,
    scopes: item.scopes.join("\n"),
  }
}

type OAuthAdvancedFieldName =
  | "issuer"
  | "authorization_endpoint"
  | "token_endpoint"
  | "registration_endpoint"
  | "resource"
  | "scopes"
type OAuthRequiredFieldName = "client_id" | "client_secret" | OAuthAdvancedFieldName

const oauthAdvancedFields: Array<{
  name: OAuthAdvancedFieldName
  label: string
  placeholder: string
  kind?: "textarea"
}> = [
  {
    name: "issuer",
    label: "Issuer",
    placeholder: "https://accounts.google.com",
  },
  {
    name: "authorization_endpoint",
    label: "Authorization endpoint",
    placeholder: "https://accounts.google.com/o/oauth2/v2/auth",
  },
  {
    name: "token_endpoint",
    label: "Token endpoint",
    placeholder: "https://oauth2.googleapis.com/token",
  },
  {
    name: "registration_endpoint",
    label: "Registration endpoint",
    placeholder: "https://issuer.example.com/register",
  },
  {
    name: "resource",
    label: "Resource",
    placeholder: "https://www.googleapis.com/",
  },
  {
    name: "scopes",
    label: "Scopes",
    placeholder: "openid",
    kind: "textarea",
  },
]
const serverErrorFields = [
  "key",
  "endpoint_url",
  "hosts",
  "provider",
  "client_id",
  "client_secret",
  ...oauthAdvancedFields.map((field) => field.name),
] as const
const scalarFormDataFields = [
  "key",
  "endpoint_url",
  "hosts",
  "provider",
  "oauth_discovery_state",
  "client_id",
  "client_secret",
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
  "resource",
  "scopes",
] as const

type ServerErrorField = (typeof serverErrorFields)[number]

function isServerErrorField(value: string): value is ServerErrorField {
  return serverErrorFields.some((field) => field === value)
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value)

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value)
    }, delayMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [delayMs, value])

  return debounced
}

export function OAuthSecretSheet({
  agentName,
  open,
  onOpenChangeAction,
  startOAuthAction,
}: {
  agentName: string
  open: boolean
  onOpenChangeAction: (open: boolean) => void
  startOAuthAction: PutSecretFormAction
}) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [serverError, setServerError] = React.useState<PutSecretFormState["error"]>()
  const {
    clearErrors,
    control,
    formState: { errors },
    handleSubmit,
    register,
    reset,
    setError,
    setValue,
    trigger,
  } = useForm<OAuthSecretFormInput, undefined, OAuthSecretFormValues>({
    resolver: zodResolver(oauthSecretFormInputSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: initialFormValues,
  })
  const [clientSubmitError, setClientSubmitError] = React.useState<string>()
  const [oauthPopupFlowID, setOAuthPopupFlowID] = React.useState<string>()
  const [dismissedDiscoveryWarningKey, setDismissedDiscoveryWarningKey] = React.useState<string>()
  const [discoveryURLOverride, setDiscoveryURLOverride] = React.useState<string>()
  const [hasTriggeredDiscovery, setHasTriggeredDiscovery] = React.useState(false)
  const [catalogPickerOpen, setCatalogPickerOpen] = React.useState(false)
  const [catalogQuery, setCatalogQuery] = React.useState("")
  const deferredCatalogQuery = React.useDeferredValue(catalogQuery.trim())
  const [userExpandedAccordions, setUserExpandedAccordions] = React.useState<string[]>([])
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const messageHandlerRef = React.useRef<((event: MessageEvent<unknown>) => void) | null>(null)
  const handledPopupFlowIDRef = React.useRef<string | undefined>(undefined)
  const previousRequiredConditionalFieldsRef = React.useRef("")
  const catalogFieldRef = React.useRef<HTMLDivElement | null>(null)
  const catalogPopoverRef = React.useRef<HTMLDivElement | null>(null)
  const endpointURL = useWatch({
    control,
    name: "endpoint_url",
    defaultValue: initialFormValues.endpoint_url,
  })
  const trimmedEndpointURL = endpointURL.trim()
  const debouncedEndpointURL = useDebouncedValue(trimmedEndpointURL, discoveryDebounceMs)
  const validEndpointURL = discoveryURLSchema.safeParse(trimmedEndpointURL).success
  const discoveryURL = discoveryURLOverride ?? debouncedEndpointURL
  const oauthDiscoveryState = useWatch({
    control,
    name: "oauth_discovery_state",
    defaultValue: initialFormValues.oauth_discovery_state,
  })
  const oauthFields = useWatch({
    control,
    name: [
      "client_id",
      "client_secret",
      "registration_endpoint",
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
    ] as const,
  })
  const [
    oauthClientID = initialFormValues.client_id,
    oauthClientSecret = initialFormValues.client_secret,
    oauthRegistrationEndpoint = initialFormValues.registration_endpoint,
    oauthIssuer = initialFormValues.issuer,
    oauthAuthorizationEndpoint = initialFormValues.authorization_endpoint,
    oauthTokenEndpoint = initialFormValues.token_endpoint,
  ] = oauthFields
  const oauthQuery = useQuery({
    ...oauthDiscoveryQueryOptions(discoveryURL),
    enabled: open && hasTriggeredDiscovery && discoveryURLSchema.safeParse(discoveryURL).success,
  })
  const { refetch: refetchOAuthDiscovery } = oauthQuery
  const provider = findOAuthSecretCatalogByServerURL(trimmedEndpointURL)
  const providerNeedsClientCredentials =
    provider?.id === "gws" && oauthRegistrationEndpoint.trim().length === 0
  const catalogResults = React.useMemo(() => {
    if (deferredCatalogQuery.length < 2) {
      return oauthSecretCatalog
    }

    return oauthSecretSearch.search(deferredCatalogQuery).map((result) => result.item)
  }, [deferredCatalogQuery])
  const discoveryWarningMessage =
    oauthQuery.error instanceof Error ? oauthQuery.error.message : undefined
  const discoveryWarningURL =
    hasTriggeredDiscovery && validEndpointURL && discoveryURL === trimmedEndpointURL
      ? discoveryURL
      : undefined
  const discoveryWarningKey =
    discoveryWarningURL && discoveryWarningMessage
      ? `${discoveryWarningURL}:${discoveryWarningMessage}`
      : undefined
  const discoveryWarningVisible =
    discoveryWarningKey &&
    discoveryWarningKey !== dismissedDiscoveryWarningKey &&
    discoveryWarningMessage &&
    oauthQuery.isError
      ? {
          key: discoveryWarningKey,
          message: discoveryWarningMessage,
        }
      : undefined
  const discoveryIconState =
    !validEndpointURL || discoveryURL !== trimmedEndpointURL || !hasTriggeredDiscovery
      ? "idle"
      : oauthQuery.fetchStatus === "fetching"
        ? "loading"
        : oauthQuery.isError
          ? "error"
          : oauthQuery.data?.endpointURL === trimmedEndpointURL && oauthQuery.isSuccess
            ? "success"
            : "idle"
  const hasOnlyServerFieldErrors = Boolean(
    serverError?.errors?.length &&
    serverError.errors.every((error) => isServerErrorField(error.field))
  )
  const submitError =
    clientSubmitError ?? (hasOnlyServerFieldErrors ? undefined : serverError?.message)
  const isDiscoveryPendingForCurrentURL =
    hasTriggeredDiscovery &&
    validEndpointURL &&
    (discoveryURL !== trimmedEndpointURL || oauthQuery.fetchStatus === "fetching")
  const currentDiscoveryState = !validEndpointURL
    ? "idle"
    : isDiscoveryPendingForCurrentURL
      ? "discovering"
      : oauthQuery.isError
        ? "manual"
        : oauthQuery.data?.endpointURL === trimmedEndpointURL && oauthQuery.isSuccess
          ? "success"
          : "idle"
  const Icon = provider?.icon ?? Settings2
  const oauthClientCredentialsRequired =
    oauthClientID.trim().length > 0 ||
    oauthClientSecret.trim().length > 0 ||
    providerNeedsClientCredentials ||
    (oauthDiscoveryState === "success" && oauthRegistrationEndpoint.trim().length === 0)
  const oauthAdvancedRequiredFields = React.useMemo<OAuthAdvancedFieldName[]>(() => {
    if (oauthDiscoveryState === "manual") {
      return ["issuer", "authorization_endpoint", "token_endpoint"]
    }

    if (oauthDiscoveryState !== "success") {
      return []
    }

    return [
      ...(oauthIssuer.trim().length === 0 ? (["issuer"] as const) : []),
      ...(oauthAuthorizationEndpoint.trim().length === 0
        ? (["authorization_endpoint"] as const)
        : []),
      ...(oauthTokenEndpoint.trim().length === 0 ? (["token_endpoint"] as const) : []),
    ]
  }, [oauthAuthorizationEndpoint, oauthDiscoveryState, oauthIssuer, oauthTokenEndpoint])
  const requiredConditionalFields = React.useMemo<OAuthRequiredFieldName[]>(
    () => [
      ...(oauthClientCredentialsRequired ? (["client_id", "client_secret"] as const) : []),
      ...oauthAdvancedRequiredFields,
    ],
    [oauthAdvancedRequiredFields, oauthClientCredentialsRequired]
  )
  const hasOAuthClientCredentialsAttention =
    oauthClientCredentialsRequired || Boolean(errors.client_id) || Boolean(errors.client_secret)
  const hasOAuthAdvancedAttention =
    oauthAdvancedRequiredFields.length > 0 ||
    Boolean(discoveryWarningKey && discoveryWarningKey !== dismissedDiscoveryWarningKey) ||
    oauthAdvancedFields.some((field) => Boolean(errors[field.name]))
  const expandedAccordions = React.useMemo(
    () =>
      Array.from(
        new Set([
          ...userExpandedAccordions,
          ...(hasOAuthClientCredentialsAttention ? [clientCredentialsAccordionItem] : []),
          ...(hasOAuthAdvancedAttention ? [advancedAccordionItem] : []),
        ])
      ),
    [hasOAuthAdvancedAttention, hasOAuthClientCredentialsAttention, userExpandedAccordions]
  )

  React.useEffect(() => {
    if (oauthDiscoveryState === currentDiscoveryState) {
      return
    }

    setValue("oauth_discovery_state", currentDiscoveryState, {
      shouldValidate: true,
    })
  }, [currentDiscoveryState, oauthDiscoveryState, setValue])

  React.useEffect(() => {
    const discoveredEndpointURL = oauthQuery.data?.endpointURL
    const discoveredOAuth = oauthQuery.data?.oauth
    if (
      !discoveredOAuth ||
      !discoveredEndpointURL ||
      discoveredEndpointURL !== trimmedEndpointURL
    ) {
      return
    }

    setValue("issuer", discoveredOAuth.issuer ?? "", {
      shouldValidate: true,
    })
    setValue("authorization_endpoint", discoveredOAuth.authorization_endpoint ?? "", {
      shouldValidate: true,
    })
    setValue("token_endpoint", discoveredOAuth.token_endpoint ?? "", {
      shouldValidate: true,
    })
    setValue("registration_endpoint", discoveredOAuth.registration_endpoint ?? "", {
      shouldValidate: true,
    })
    setValue("resource", discoveredOAuth.resource ?? "", {
      shouldValidate: true,
    })
    setValue("scopes", (oauthQuery.data?.default_scopes ?? []).join("\n"), {
      shouldValidate: true,
    })
  }, [oauthQuery.data, setValue, trimmedEndpointURL])

  React.useEffect(() => {
    const nextRequiredFieldsKey = requiredConditionalFields.join("|")
    if (previousRequiredConditionalFieldsRef.current === nextRequiredFieldsKey) {
      return
    }

    previousRequiredConditionalFieldsRef.current = nextRequiredFieldsKey
    if (requiredConditionalFields.length === 0) {
      return
    }

    void trigger(requiredConditionalFields)
  }, [requiredConditionalFields, trigger])

  const cleanupPopupFlow = React.useCallback(
    (options?: { closePopup?: boolean; cancelPending?: boolean; resetState?: boolean }) => {
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

      if (options?.resetState !== false) {
        setOAuthPopupFlowID(undefined)
      }

      if (!options?.cancelPending) {
        return
      }

      void fetch("/mcps/oauth/pending", {
        method: "POST",
        keepalive: true,
      }).catch(() => {})
    },
    []
  )

  React.useEffect(() => {
    return () => {
      cleanupPopupFlow({
        closePopup: true,
        resetState: false,
      })
    }
  }, [cleanupPopupFlow])

  const openOAuthPopup = React.useCallback(
    (oauth: { flowId: string; url: string }) => {
      if (handledPopupFlowIDRef.current === oauth.flowId) {
        return
      }

      handledPopupFlowIDRef.current = oauth.flowId
      setClientSubmitError(undefined)
      setServerError(undefined)
      let completed = false

      function acknowledgePopup(flowID: string) {
        const ack: OAuthPopupMessage = {
          source: oauthWindowMessageSource,
          kind: "ack",
          flowId: flowID,
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
        cleanupPopupFlow({
          closePopup: true,
        })

        if (message.status === "success") {
          toast.success("Secret created")
          reset(initialFormValues)
          onOpenChangeAction(false)
          router.refresh()
          return
        }

        setClientSubmitError(message.message)
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
        `oauth-secret-${oauth.flowId}`,
        "popup=yes,width=520,height=760,resizable=yes,scrollbars=yes"
      )
      if (!popup) {
        cleanupPopupFlow({
          cancelPending: true,
        })
        setClientSubmitError("OAuth popup was blocked by the browser. Allow popups and try again.")
        return
      }

      popupRef.current = popup
      setOAuthPopupFlowID(oauth.flowId)

      popupPollRef.current = window.setInterval(() => {
        if (!popupRef.current?.closed) {
          return
        }
        if (completed) {
          return
        }
        cleanupPopupFlow({
          cancelPending: true,
        })
        setClientSubmitError("OAuth popup was closed before authentication completed.")
      }, 400)
    },
    [cleanupPopupFlow, onOpenChangeAction, reset, router]
  )

  function isInCatalogField(target: EventTarget | null) {
    if (!(target instanceof Node)) {
      return false
    }

    return (
      catalogFieldRef.current?.contains(target) === true ||
      catalogPopoverRef.current?.contains(target) === true
    )
  }

  function resetOAuthSheet(values: OAuthSecretFormInput = initialFormValues) {
    reset(values)
    setClientSubmitError(undefined)
    setServerError(undefined)
    setDismissedDiscoveryWarningKey(undefined)
    setDiscoveryURLOverride(undefined)
    setHasTriggeredDiscovery(false)
    setCatalogPickerOpen(false)
    setCatalogQuery("")
    setUserExpandedAccordions([])
    previousRequiredConditionalFieldsRef.current = ""
  }

  function selectCatalogItem(item: OAuthSecretCatalogItem) {
    resetOAuthSheet(item.id === "custom" ? initialFormValues : oauthSecretFormValues(item))
  }

  const refreshDiscovery = React.useCallback(async () => {
    const endpointValid = await trigger("endpoint_url")
    if (!endpointValid) {
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
  }, [discoveryURL, refetchOAuthDiscovery, trigger, trimmedEndpointURL])

  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      cleanupPopupFlow({
        closePopup: true,
        cancelPending: Boolean(oauthPopupFlowID),
      })
      setOAuthPopupFlowID(undefined)
      resetOAuthSheet()
    }
    onOpenChangeAction(nextOpen)
  }

  async function submitAction(values: OAuthSecretFormValues) {
    setClientSubmitError(undefined)
    setServerError(undefined)
    setIsSubmitting(true)

    try {
      const formData = new FormData()
      for (const field of scalarFormDataFields) {
        if (field === "hosts") {
          formData.set(field, values.hosts.join("\n"))
          continue
        }

        if (field === "scopes") {
          formData.set(field, values.scopes.join("\n"))
          continue
        }

        formData.set(field, values[field] ?? "")
      }

      const result = await startOAuthAction(agentName, {}, formData)
      if (result.error) {
        setServerError(result.error)
        for (const error of result.error.errors ?? []) {
          if (!isServerErrorField(error.field)) {
            continue
          }
          setError(error.field, {
            type: "server",
            message: error.message,
          })
        }
        return
      }

      if (result.status === "oauth_pending" && result.oauth) {
        openOAuthPopup(result.oauth)
      }
    } catch (error) {
      setClientSubmitError(
        error instanceof Error ? error.message : "OAuth secret creation could not be started."
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  function invalidSubmitAction() {
    setClientSubmitError(undefined)
    setServerError(undefined)
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    setClientSubmitError(undefined)
    setServerError(undefined)
    clearErrors()
    void handleSubmit(submitAction, invalidSubmitAction)()
  }

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      <SheetContent
        className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!"
        onPointerDownOutside={(event) => {
          if (!oauthPopupFlowID) {
            return
          }
          event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (!oauthPopupFlowID) {
            return
          }
          event.preventDefault()
        }}
        showCloseButton={oauthPopupFlowID === undefined}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>New OAuth secret</SheetTitle>
          <SheetDescription className="sr-only">New OAuth secret</SheetDescription>
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
        <form onSubmit={onSubmit} className="flex flex-1 flex-col gap-5 px-4 pb-2">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="oauth-secret-catalog">Catalog</FieldLabel>
              <Popover open={catalogPickerOpen} onOpenChange={setCatalogPickerOpen}>
                <PopoverAnchor asChild>
                  <div ref={catalogFieldRef} className="relative">
                    <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                    <Input
                      id="oauth-secret-catalog"
                      value={catalogQuery || provider?.name || ""}
                      onFocus={() => {
                        setCatalogPickerOpen(true)
                      }}
                      onBlur={(event) => {
                        if (isInCatalogField(event.relatedTarget)) {
                          return
                        }
                        setCatalogPickerOpen(false)
                        setCatalogQuery("")
                      }}
                      onChange={(event) => {
                        setCatalogQuery(event.target.value)
                        if (!catalogPickerOpen) {
                          setCatalogPickerOpen(true)
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setCatalogPickerOpen(false)
                          setCatalogQuery("")
                        }
                      }}
                      placeholder="Search catalog"
                      className="pr-10 pl-9"
                      aria-expanded={catalogPickerOpen}
                      aria-autocomplete="list"
                      aria-controls="oauth-secret-catalog-suggestions"
                      role="combobox"
                    />
                    <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2" />
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  ref={catalogPopoverRef}
                  align="start"
                  className="w-(--radix-popper-anchor-width) p-0"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                  }}
                  onFocusOutside={(event) => {
                    if (isInCatalogField(event.target)) {
                      event.preventDefault()
                    }
                  }}
                  onInteractOutside={(event) => {
                    if (isInCatalogField(event.target)) {
                      event.preventDefault()
                    }
                  }}
                  onOpenAutoFocus={(event) => {
                    event.preventDefault()
                  }}
                  sideOffset={8}
                >
                  <Command shouldFilter={false}>
                    <CommandList id="oauth-secret-catalog-suggestions">
                      <CommandEmpty>No catalog entries match.</CommandEmpty>
                      <CommandGroup>
                        {catalogResults.map((item) => {
                          const ItemIcon = item.icon
                          return (
                            <CommandItem
                              key={item.id}
                              value={item.id}
                              className="cursor-pointer"
                              onMouseDown={(event) => {
                                event.preventDefault()
                              }}
                              onSelect={() => {
                                selectCatalogItem(item)
                              }}
                            >
                              <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border">
                                <ItemIcon />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{item.name}</span>
                                <span className="text-muted-foreground block truncate text-xs">
                                  {item.serverUrl}
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
            </Field>
            <Field data-invalid={Boolean(errors.key)}>
              <FieldLabel htmlFor="oauth-secret-key" required>
                Name
              </FieldLabel>
              <Input
                id="oauth-secret-key"
                placeholder="SECRET_NAME"
                aria-invalid={Boolean(errors.key)}
                aria-required="true"
                {...register("key")}
              />
              {errors.key ? <FieldError errors={[errors.key]} /> : null}
            </Field>
            <Field data-invalid={Boolean(errors.endpoint_url)}>
              <FieldLabel htmlFor="oauth-secret-endpoint-url" required>
                OAuth Server
              </FieldLabel>
              <div className="relative">
                <Icon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Controller
                  name="endpoint_url"
                  control={control}
                  render={({ field }) => (
                    <Input
                      id="oauth-secret-endpoint-url"
                      name={field.name}
                      ref={field.ref}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => {
                        field.onChange(event)
                        const nextValue = event.target.value.trim()
                        if (findOAuthSecretCatalogByServerURL(nextValue) === undefined) {
                          setValue("provider", "", {
                            shouldDirty: true,
                          })
                        }
                        if (discoveryURLOverride && discoveryURLOverride !== nextValue) {
                          setDiscoveryURLOverride(undefined)
                        }
                      }}
                      placeholder="https://www.googleapis.com/"
                      className="pr-25 pl-9"
                      aria-invalid={Boolean(errors.endpoint_url)}
                      aria-required="true"
                    />
                  )}
                />
                <input type="hidden" {...register("provider")} />
                <input type="hidden" {...register("oauth_discovery_state")} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute inset-y-0 right-2 my-auto"
                  onClick={() => {
                    void refreshDiscovery()
                  }}
                  disabled={oauthQuery.fetchStatus === "fetching"}
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
              </div>
              {errors.endpoint_url ? <FieldError errors={[errors.endpoint_url]} /> : null}
            </Field>
            <Controller
              name="hosts"
              control={control}
              render={({ field, fieldState }) => (
                <SecretHostsField
                  name={field.name}
                  value={field.value}
                  inputRef={field.ref}
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  inputID="oauth-secret-hosts"
                />
              )}
            />
            <Accordion
              type="multiple"
              className="rounded-lg border px-4"
              value={expandedAccordions}
              onValueChange={setUserExpandedAccordions}
            >
              <AccordionItem value={clientCredentialsAccordionItem} className="border-none">
                <AccordionTrigger className="py-4 hover:no-underline">
                  <span>OAuth client credentials</span>
                </AccordionTrigger>
                <AccordionContent className="[&>div]:h-auto">
                  <FieldGroup>
                    <Field data-invalid={Boolean(errors.client_id)}>
                      <FieldLabel
                        htmlFor="oauth-secret-client-id"
                        required={oauthClientCredentialsRequired}
                      >
                        Client ID
                      </FieldLabel>
                      <Input
                        id="oauth-secret-client-id"
                        placeholder="Client ID"
                        aria-invalid={Boolean(errors.client_id)}
                        aria-required={oauthClientCredentialsRequired}
                        {...register("client_id")}
                      />
                      {errors.client_id ? <FieldError errors={[errors.client_id]} /> : null}
                    </Field>
                    <Field data-invalid={Boolean(errors.client_secret)}>
                      <FieldLabel
                        htmlFor="oauth-secret-client-secret"
                        required={oauthClientCredentialsRequired}
                      >
                        Client secret
                      </FieldLabel>
                      <Input
                        id="oauth-secret-client-secret"
                        type="password"
                        placeholder="Client secret"
                        aria-invalid={Boolean(errors.client_secret)}
                        aria-required={oauthClientCredentialsRequired}
                        {...register("client_secret")}
                      />
                      {errors.client_secret ? <FieldError errors={[errors.client_secret]} /> : null}
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
                    {oauthAdvancedFields.map((field) => {
                      const error = errors[field.name]
                      const required =
                        field.name === "scopes" || oauthAdvancedRequiredFields.includes(field.name)
                      return (
                        <Field key={field.name} data-invalid={Boolean(error)}>
                          <FieldLabel
                            htmlFor={`oauth-secret-${field.name.replaceAll("_", "-")}`}
                            required={required}
                          >
                            {field.label}
                          </FieldLabel>
                          {field.kind === "textarea" ? (
                            <Textarea
                              id={`oauth-secret-${field.name.replaceAll("_", "-")}`}
                              rows={8}
                              placeholder={field.placeholder}
                              className="font-mono"
                              aria-invalid={Boolean(error)}
                              aria-required={required}
                              {...register(field.name)}
                            />
                          ) : (
                            <Input
                              id={`oauth-secret-${field.name.replaceAll("_", "-")}`}
                              placeholder={field.placeholder}
                              aria-invalid={Boolean(error)}
                              aria-required={required}
                              {...register(field.name)}
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
          </FieldGroup>
          {submitError ? (
            <Alert variant="destructive">
              <CircleAlert className="size-4" />
              <AlertTitle>Secret creation failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={
                isSubmitting || oauthPopupFlowID !== undefined || isDiscoveryPendingForCurrentURL
              }
            >
              {isSubmitting || oauthPopupFlowID ? <Spinner /> : <Cable data-icon="inline-start" />}
              {oauthPopupFlowID ? "Waiting for OAuth" : isSubmitting ? "Connecting" : "Connect"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
