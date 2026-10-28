"use client"

import { customAlphabet } from "nanoid"
import { useId, useState, useTransition } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, CircleAlert, Save } from "lucide-react"
import { toast } from "sonner"
import { GuardrailProviderIcon, guardrailProviderLabels } from "./provider-shared"
import type { GuardrailConnection, CreateGuardrailConnectionData } from "@/lib/gateway/client"
import { saveGuardrailConnectionAction, type GuardrailActionScope } from "@/data/guardrail.actions"
import { zGuardrailConnectionInputWritable } from "@/lib/gateway/client/zod.gen"
import { LoadingButton } from "@/components/interior/loading-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

// Bedrock control-plane regions: https://docs.aws.amazon.com/general/latest/gr/bedrock.html
const awsRegions = [
  ["us-east-1", "US East (N. Virginia)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-west-1", "US West (N. California)"],
  ["us-west-2", "US West (Oregon)"],
  ["af-south-1", "Africa (Cape Town)"],
  ["ap-east-2", "Asia Pacific (Taipei)"],
  ["ap-south-1", "Asia Pacific (Mumbai)"],
  ["ap-south-2", "Asia Pacific (Hyderabad)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
  ["ap-northeast-2", "Asia Pacific (Seoul)"],
  ["ap-northeast-3", "Asia Pacific (Osaka)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-southeast-2", "Asia Pacific (Sydney)"],
  ["ap-southeast-3", "Asia Pacific (Jakarta)"],
  ["ap-southeast-4", "Asia Pacific (Melbourne)"],
  ["ap-southeast-5", "Asia Pacific (Malaysia)"],
  ["ap-southeast-6", "Asia Pacific (New Zealand)"],
  ["ap-southeast-7", "Asia Pacific (Thailand)"],
  ["ca-central-1", "Canada (Central)"],
  ["ca-west-1", "Canada West (Calgary)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["eu-central-2", "Europe (Zurich)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-2", "Europe (London)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-south-1", "Europe (Milan)"],
  ["eu-south-2", "Europe (Spain)"],
  ["eu-north-1", "Europe (Stockholm)"],
  ["il-central-1", "Israel (Tel Aviv)"],
  ["mx-central-1", "Mexico (Central)"],
  ["me-south-1", "Middle East (Bahrain)"],
  ["me-central-1", "Middle East (UAE)"],
  ["sa-east-1", "South America (São Paulo)"],
  ["us-gov-east-1", "AWS GovCloud (US-East)"],
  ["us-gov-west-1", "AWS GovCloud (US-West)"],
] as const

type ConnectionSheetProps = {
  connection?: GuardrailConnection
  scope: GuardrailActionScope
  onClose: () => void
  onSaved?: (connection: GuardrailConnection) => void
}

export function ConnectionSheet(props: ConnectionSheetProps) {
  const { connection, scope, onClose, onSaved } = props

  const idPrefix = useId()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<CreateGuardrailConnectionData["body"]["provider"]>(
    connection?.provider ?? "Bedrock"
  )
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState("")
  const [connectionID, setConnectionID] = useState(connection?.name)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [region, setRegion] = useState(connection?.region || "us-east-1")
  const [regionOpen, setRegionOpen] = useState(false)
  const readOnly = connection !== undefined && !connection.canModify
  let title = "Add guardrail provider"
  if (connection) title = "Edit guardrail provider"
  if (readOnly) title = "Guardrail provider"
  const providerDescriptions = {
    Bedrock: "Choose an existing guardrail after connecting. Detection rules stay in AWS.",
    ModelArmor:
      "Browse your Google Cloud projects and choose a Model Armor template after connecting.",
    OpenAI: "Uses OpenAI moderation. No cloud policy or resource ID is needed.",
    Webhook: "",
  }
  const credentialLabels = {
    ModelArmor: "Google credential JSON",
    Webhook: "Bearer token",
    OpenAI: "API key",
    Bedrock: "",
  }
  let credentialStatus = ""
  if (connection?.credentialsConfigured) {
    credentialStatus = "Leave credentials blank to keep the saved values."
    if (readOnly) credentialStatus = "Credentials configured."
  }
  if (readOnly && !connection?.credentialsConfigured)
    credentialStatus = "No credentials configured."

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <SheetContent size="half" className="h-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <GuardrailProviderIcon provider={provider} />
            {title}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Connect a checker service to use in policies.
          </SheetDescription>
          {readOnly ? (
            <Badge className="w-fit" variant="secondary">
              Read only
            </Badge>
          ) : null}
        </SheetHeader>
        <form
          className="flex flex-1 flex-col gap-5 px-4 pb-2"
          onSubmit={(event) => {
            event.preventDefault()
            const formData = new FormData(event.currentTarget)
            setError("")
            const credentialFields = [
              "apiKey",
              "accessKeyId",
              "secretAccessKey",
              "sessionToken",
              "googleCredentialsJson",
            ] as const
            const parsedCredentials = zGuardrailConnectionInputWritable.shape.credentials
              .unwrap()
              .safeParse(
                Object.fromEntries(
                  credentialFields.map((field) => [field, formData.get(field) || undefined])
                )
              )
            if (!parsedCredentials.success) {
              setError(parsedCredentials.error.issues[0]?.message ?? "Check provider credentials")
              return
            }
            const credentials = parsedCredentials.data
            const replacingCredentials = Object.values(credentials).some(
              (value) => value !== undefined
            )
            const incompleteAWSKeys = !credentials.accessKeyId || !credentials.secretAccessKey
            if (provider === "Bedrock" && replacingCredentials && incompleteAWSKeys) {
              setError(
                "Provide both the AWS access key ID and secret access key when replacing credentials."
              )
              return
            }
            const parsed = zGuardrailConnectionInputWritable.safeParse({
              name: connectionID,
              displayName: formData.get("displayName"),
              description: formData.get("description"),
              provider,
              endpoint: formData.get("endpoint") ?? undefined,
              region: formData.get("region") ?? undefined,
              credentials: replacingCredentials ? credentials : undefined,
            })
            if (!parsed.success) {
              setError(parsed.error.issues[0]?.message ?? "Check provider fields")
              return
            }
            startTransition(async () => {
              const result = await saveGuardrailConnectionAction(
                scope,
                parsed.data,
                connection !== undefined
              )
              if (result.error) {
                setError(result.error.message)
                return
              }
              await queryClient.cancelQueries({
                predicate: (query) => query.queryKey[0] === "guardrail-resources",
              })
              void queryClient.invalidateQueries({
                predicate: (query) => query.queryKey[0] === "guardrail-resources",
              })
              toast.success(connection ? "Provider saved" : "Provider created")
              onSaved?.(result.data)
              router.refresh()
              onClose()
            })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-guardrail-provider-display`} required={!readOnly}>
                Name
              </FieldLabel>
              <Input
                defaultValue={connection?.displayName}
                disabled={readOnly || pending}
                id={`${idPrefix}-guardrail-provider-display`}
                maxLength={128}
                name="displayName"
                onChange={() => {
                  if (connectionID === undefined)
                    setConnectionID(
                      `provider-${customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789")(16)}`
                    )
                }}
                required
                placeholder="Company guardrail service"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-guardrail-provider-provider`} required={!readOnly}>
                Service
              </FieldLabel>
              <Select
                disabled={readOnly || pending || connection !== undefined}
                value={provider}
                onValueChange={(value) => {
                  switch (value) {
                    case "OpenAI":
                    case "Bedrock":
                    case "ModelArmor":
                    case "Webhook":
                      setProvider(value)
                  }
                }}
              >
                <SelectTrigger id={`${idPrefix}-guardrail-provider-provider`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="Bedrock">
                      <GuardrailProviderIcon provider="Bedrock" />
                      {guardrailProviderLabels.Bedrock}
                    </SelectItem>
                    <SelectItem value="OpenAI">
                      <GuardrailProviderIcon provider="OpenAI" />
                      {guardrailProviderLabels.OpenAI}
                    </SelectItem>
                    <SelectItem value="ModelArmor">
                      <GuardrailProviderIcon provider="ModelArmor" />
                      {guardrailProviderLabels.ModelArmor}
                    </SelectItem>
                    <SelectItem value="Webhook">
                      <GuardrailProviderIcon provider="Webhook" />
                      {guardrailProviderLabels.Webhook}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {!connection && provider !== "Webhook" ? (
                <FieldDescription>{providerDescriptions[provider]}</FieldDescription>
              ) : null}
            </Field>
            {provider === "Webhook" ? (
              <Field>
                <FieldLabel
                  htmlFor={`${idPrefix}-guardrail-provider-endpoint`}
                  required={!readOnly}
                >
                  Webhook service URL
                </FieldLabel>
                <Input
                  defaultValue={connection?.endpoint}
                  disabled={readOnly || pending}
                  id={`${idPrefix}-guardrail-provider-endpoint`}
                  name="endpoint"
                  placeholder="https://guardrails.example.com"
                  required
                  type="url"
                />
                {!readOnly ? (
                  <FieldDescription>
                    Root URL without a path or query. Uses /request and /response.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
            {provider === "Bedrock" ? (
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-guardrail-provider-region`} required={!readOnly}>
                  AWS region
                </FieldLabel>
                <input name="region" type="hidden" value={region} />
                <Popover open={regionOpen} onOpenChange={setRegionOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      aria-expanded={regionOpen}
                      className="w-full justify-between font-normal"
                      disabled={readOnly || pending}
                      id={`${idPrefix}-guardrail-provider-region`}
                      role="combobox"
                      type="button"
                      variant="outline"
                    >
                      <span className="truncate">
                        {awsRegions.find(([value]) => value === region)?.[1] ?? region}
                        <span className="ml-2 text-muted-foreground">{region}</span>
                      </span>
                      <ChevronsUpDown className="shrink-0 text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
                    <Command>
                      <CommandInput placeholder="Search AWS regions..." />
                      <CommandList>
                        <CommandEmpty>No matching regions.</CommandEmpty>
                        <CommandGroup>
                          {awsRegions.map(([value, label]) => (
                            <CommandItem
                              data-checked={region === value}
                              key={value}
                              onSelect={() => {
                                setRegion(value)
                                setRegionOpen(false)
                              }}
                              value={`${label} ${value}`}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block">{label}</span>
                                <span className="text-xs text-muted-foreground">{value}</span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {!readOnly ? (
                  <FieldDescription>
                    We list the guardrails available in this region.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
            <div className="flex flex-col gap-4" key={provider}>
              {credentialStatus ? (
                <p className="text-xs text-muted-foreground">{credentialStatus}</p>
              ) : null}
              {!readOnly ? (
                <>
                  {provider === "Bedrock" ? (
                    <>
                      <Field>
                        <FieldLabel
                          htmlFor={`${idPrefix}-guardrail-aws-key`}
                          required={!connection?.credentialsConfigured}
                        >
                          AWS access key ID
                        </FieldLabel>
                        <Input
                          autoComplete="off"
                          disabled={pending}
                          id={`${idPrefix}-guardrail-aws-key`}
                          name="accessKeyId"
                          type="password"
                          required={!connection?.credentialsConfigured}
                        />
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`${idPrefix}-guardrail-aws-secret`}
                          required={!connection?.credentialsConfigured}
                        >
                          AWS secret access key
                        </FieldLabel>
                        <Input
                          autoComplete="new-password"
                          disabled={pending}
                          id={`${idPrefix}-guardrail-aws-secret`}
                          name="secretAccessKey"
                          type="password"
                          required={!connection?.credentialsConfigured}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`${idPrefix}-guardrail-aws-session`}>
                          AWS session token
                        </FieldLabel>
                        <Input
                          autoComplete="new-password"
                          disabled={pending}
                          id={`${idPrefix}-guardrail-aws-session`}
                          name="sessionToken"
                          type="password"
                        />
                        <FieldDescription>Optional for temporary credentials.</FieldDescription>
                      </Field>
                    </>
                  ) : (
                    <Field>
                      <FieldLabel
                        htmlFor={`${idPrefix}-guardrail-provider-secret`}
                        required={provider !== "Webhook" && !connection?.credentialsConfigured}
                      >
                        {credentialLabels[provider]}
                      </FieldLabel>
                      {provider === "ModelArmor" ? (
                        <Textarea
                          autoComplete="off"
                          className="min-h-40 font-mono"
                          disabled={pending}
                          id={`${idPrefix}-guardrail-provider-secret`}
                          name="googleCredentialsJson"
                          placeholder="Paste supported Google ADC credential JSON"
                          required={!connection?.credentialsConfigured}
                          spellCheck={false}
                        />
                      ) : (
                        <Input
                          autoComplete="new-password"
                          disabled={pending}
                          id={`${idPrefix}-guardrail-provider-secret`}
                          name="apiKey"
                          type="password"
                          required={provider !== "Webhook" && !connection?.credentialsConfigured}
                        />
                      )}
                      {provider !== "OpenAI" ? (
                        <FieldDescription>
                          {provider === "Webhook"
                            ? "Optional. Sent only to this checker. Caller authorization is not forwarded."
                            : "Use supported Google ADC credential JSON."}
                        </FieldDescription>
                      ) : null}
                    </Field>
                  )}
                </>
              ) : null}
            </div>
            {provider === "Webhook" && !readOnly ? (
              <FieldDescription>
                Implement the{" "}
                <a
                  className="underline underline-offset-4"
                  href="https://agentgateway.dev/docs/standalone/latest/documentation/llm/prompt-guards/webhooks/"
                  rel="noreferrer"
                  target="_blank"
                >
                  AgentGateway webhook contract
                </a>
                .
              </FieldDescription>
            ) : null}
            <Accordion
              collapsible
              type="single"
              value={detailsOpen ? "details" : ""}
              onValueChange={(value) => setDetailsOpen(value === "details")}
            >
              <AccordionItem value="details">
                <AccordionTrigger>Details</AccordionTrigger>
                <AccordionContent forceMount hidden={!detailsOpen}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor={`${idPrefix}-guardrail-provider-description`}>
                        Description
                      </FieldLabel>
                      <Textarea
                        defaultValue={connection?.description}
                        disabled={readOnly || pending}
                        id={`${idPrefix}-guardrail-provider-description`}
                        maxLength={2048}
                        name="description"
                      />
                    </Field>
                  </FieldGroup>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            {connection?.status.state === "Error" && connection.status.message ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden />
                <AlertTitle>Provider error</AlertTitle>
                <AlertDescription>{connection.status.message}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden />
                <AlertTitle>Provider not saved</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
          {!readOnly ? (
            <div className="flex justify-end">
              <LoadingButton pending={pending} pendingLabel="Saving..." type="submit">
                <Save data-icon="inline-start" />
                {connection ? "Save changes" : "Add provider"}
              </LoadingButton>
            </div>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  )
}
