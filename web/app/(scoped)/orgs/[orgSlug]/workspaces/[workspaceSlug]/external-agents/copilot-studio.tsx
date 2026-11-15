"use client"

import type { TransitionStartFunction } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { zCopilotStudioIntegrationInput } from "@/lib/gateway/client/zod.gen"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import type { CopilotStudioIntegration, CopilotStudioIntegrationInput } from "@/lib/gateway/client"
import { loadCopilotStudioAction, saveCopilotStudioAction } from "./actions"
import { RequestError } from "@/components/request-error"
import { SubjectGuardrails } from "@/components/guardrails/subject-guardrails"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { CopyButton } from "@/components/interior/copy-button"
import { LoadingButton } from "@/components/interior/loading-button"

type CopilotStudioProps = {
  orgSlug: string
  workspaceSlug: string
  pending: boolean
  startTransition: TransitionStartFunction
}
type CopilotStudioData = Awaited<ReturnType<typeof loadCopilotStudioAction>>

export function copilotStudioOptions(
  orgSlug: string,
  workspaceSlug: string,
  integrationId?: string
) {
  return queryOptions({
    queryKey: ["copilotStudio", orgSlug, workspaceSlug, integrationId],
    meta: { externalAgentScope: `${orgSlug}/${workspaceSlug}` },
    queryFn: () => loadCopilotStudioAction(orgSlug, workspaceSlug, integrationId),
    retry: false,
  })
}

export function CopilotStudio({
  integrationId,
  onSaved,
  ...scope
}: CopilotStudioProps & { integrationId?: string; onSaved: () => void }) {
  const queryClient = useQueryClient()
  const query = useQuery(copilotStudioOptions(scope.orgSlug, scope.workspaceSlug, integrationId))
  if (query.isPending && !integrationId)
    return (
      <Alert>
        <Spinner aria-hidden="true" />
        <AlertDescription>Checking Copilot Studio availability…</AlertDescription>
      </Alert>
    )
  if (query.isPending)
    return (
      <Tabs defaultValue="setup" className="gap-4" aria-busy>
        <TabsList className="w-full">
          <TabsTrigger value="setup" disabled>
            Setup
          </TabsTrigger>
          <TabsTrigger value="policies" disabled>
            Policies
          </TabsTrigger>
        </TabsList>
        <FieldGroup role="status" aria-label="Loading setup" className="pb-1">
          {[
            "AgentZ provider application ID",
            "Public gateway origin",
            "Connection name",
            "Directory tenant ID",
            "Application client ID",
            "Power Platform environment ID",
            "Failure mode",
          ].map((label) => (
            <Field key={label} aria-hidden>
              <FieldLabel
                required={
                  label !== "AgentZ provider application ID" && label !== "Public gateway origin"
                }
              >
                {label}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 flex-1" />
                {label === "AgentZ provider application ID" || label === "Public gateway origin" ? (
                  <Skeleton className="size-6 shrink-0" />
                ) : null}
              </div>
            </Field>
          ))}
        </FieldGroup>
      </Tabs>
    )
  if (query.isError)
    return (
      <RequestError
        compact
        title="Connection unavailable"
        description={query.error.message}
        onRetry={async () => {
          await query.refetch()
        }}
      />
    )
  if (!query.data.enabled)
    return (
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Copilot Studio unavailable</AlertTitle>
        <AlertDescription>Contact your platform administrator to enable it.</AlertDescription>
      </Alert>
    )
  const integration = query.data.integration
  if (integrationId && !integration)
    return (
      <Alert variant="destructive">
        <AlertTitle>Connection unavailable</AlertTitle>
      </Alert>
    )
  return (
    <CopilotStudioConnection
      key={integration?.id ?? "new"}
      {...scope}
      data={query.data}
      onSaved={(saved) => {
        queryClient.setQueryData(
          copilotStudioOptions(scope.orgSlug, scope.workspaceSlug, saved.id).queryKey,
          { ...query.data, integration: saved }
        )
        onSaved()
      }}
    />
  )
}

function CopilotStudioConnection({
  data,
  onSaved,
  pending,
  startTransition,
  ...scope
}: CopilotStudioProps & {
  data: CopilotStudioData
  onSaved: (integration: CopilotStudioIntegration) => void
}) {
  const integration = data.integration
  const form = useForm<CopilotStudioIntegrationInput>({
    resolver: zodResolver(zCopilotStudioIntegrationInput),
    reValidateMode: "onBlur",
    defaultValues: {
      name: integration?.name ?? "Copilot Studio",
      tenant_id: integration?.tenant_id ?? "",
      application_id: integration?.application_id ?? "",
      environment_id: integration?.environment_id ?? "",
      enabled: integration?.enabled ?? true,
      failure_mode: integration?.failure_mode ?? "closed",
      assignment: integration?.assignment ?? { policies: [] },
    },
  })
  const credentialCommand = integration
    ? `az ad app federated-credential create --id ${integration.application_id} --parameters '${JSON.stringify(
        {
          name: `agentz-${integration.id}`,
          issuer: integration.federated_credential.issuer,
          subject: integration.federated_credential.subject,
          audiences: [integration.federated_credential.audience],
        },
        null,
        2
      )}'`
    : ""

  return (
    <Tabs defaultValue="setup" className="gap-4" aria-busy={pending || undefined}>
      <TabsList className="w-full">
        <TabsTrigger value="setup">Setup</TabsTrigger>
        <TabsTrigger value="policies" disabled={!integration}>
          Policies
        </TabsTrigger>
      </TabsList>
      <div className="pb-1">
        <FieldError errors={[form.formState.errors.root]} />
        <form
          autoComplete="off"
          noValidate
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit((input) => {
            form.clearErrors("root")
            startTransition(async () => {
              const result = await saveCopilotStudioAction(
                scope.orgSlug,
                scope.workspaceSlug,
                input,
                integration?.id
              )
              if (result.data === undefined) {
                form.setError("root", { message: result.error })
                return
              }
              toast.success("Copilot Studio connection saved")
              onSaved(result.data)
            })
          })}
        >
          <TabsContent value="setup" className="mt-0 flex flex-col gap-5">
            <FieldGroup className="gap-4">
              {[
                { label: "AgentZ provider application ID", value: data.audience },
                { label: "Public gateway origin", value: data.baseURL },
              ].map(({ label, value }) => (
                <Field key={label}>
                  <FieldLabel>{label}</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={value}
                      aria-label={`${label} to copy`}
                      className="font-mono text-xs md:text-xs"
                    />
                    <CopyButton content={value} label={`Copy ${label.toLowerCase()}`} />
                  </div>
                </Field>
              ))}
            </FieldGroup>
            <Accordion
              type="single"
              collapsible
              defaultValue={integration ? undefined : "azure"}
              className="mb-5 border-b"
            >
              <AccordionItem value="azure">
                <AccordionTrigger className="items-center gap-2 py-3 hover:no-underline">
                  <span className="shrink-0 font-mono text-xs text-primary">1</span>
                  <span className="flex-1">Set up Azure</span>
                </AccordionTrigger>
                <AccordionContent className="flex flex-col gap-4 pb-4">
                  <FieldDescription>
                    Requires Cloud Application Administrator and Power Platform Administrator role.
                  </FieldDescription>
                  {[
                    {
                      label: "Sign in",
                      command:
                        "az login --tenant YOUR_TENANT_ID --allow-no-subscriptions\naz account show --query tenantId -o tsv",
                      description: "Use your tenant ID from Azure → Microsoft Entra ID → Overview.",
                    },
                    {
                      label: "Create an app",
                      command:
                        'CALLER_APP_ID=$(az ad app create --display-name "AgentZ Microsoft Copilot Studio" --sign-in-audience AzureADMyOrg --query appId -o tsv)\naz ad sp create --id "$CALLER_APP_ID" --query appId -o tsv',
                      description: "Paste the result into Application client ID.",
                    },
                    {
                      label: "Add AgentZ",
                      command: `az ad sp create --id ${data.audience}`,
                      description: "",
                    },
                  ].map(({ label, command, description }) => (
                    <Field key={label}>
                      <FieldLabel>
                        <Terminal aria-hidden className="size-3.5 text-primary" />
                        {label}
                      </FieldLabel>
                      <div className="flex items-start gap-2">
                        <Textarea
                          readOnly
                          value={command}
                          aria-label={label}
                          className="field-sizing-content min-h-0 resize-none border-primary/15 bg-muted/40 font-mono text-xs leading-5 text-foreground shadow-none md:text-xs"
                        />
                        <CopyButton
                          content={command}
                          label={`Copy ${label.toLowerCase()} command`}
                        />
                      </div>
                      {description ? <FieldDescription>{description}</FieldDescription> : null}
                    </Field>
                  ))}
                  <FieldDescription>
                    Copy Environment ID from{" "}
                    <a
                      className="underline"
                      href="https://admin.powerplatform.microsoft.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Power Platform admin center
                    </a>
                    → Manage → Environments → your environment → Details. Fill in the form and save.
                  </FieldDescription>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <FieldSet disabled={pending}>
              <FieldGroup>
                <Field data-invalid={!!form.formState.errors.name}>
                  <FieldLabel htmlFor="copilot-studio-name" required>
                    Connection name
                  </FieldLabel>
                  <Input
                    id="copilot-studio-name"
                    required
                    maxLength={120}
                    aria-invalid={!!form.formState.errors.name}
                    {...form.register("name")}
                  />
                  <FieldError errors={[form.formState.errors.name]} />
                </Field>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={!!form.formState.errors.tenant_id}>
                    <FieldLabel htmlFor="copilot-studio-tenant" required>
                      Directory tenant ID
                    </FieldLabel>
                    <Input
                      id="copilot-studio-tenant"
                      required
                      readOnly={!!integration}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      aria-invalid={!!form.formState.errors.tenant_id}
                      {...form.register("tenant_id")}
                    />
                    <FieldError errors={[form.formState.errors.tenant_id]} />
                  </Field>
                  <Field data-invalid={!!form.formState.errors.application_id}>
                    <FieldLabel htmlFor="copilot-studio-application" required>
                      Application client ID
                    </FieldLabel>
                    <Input
                      id="copilot-studio-application"
                      required
                      readOnly={!!integration}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      aria-invalid={!!form.formState.errors.application_id}
                      {...form.register("application_id")}
                    />
                    <FieldError errors={[form.formState.errors.application_id]} />
                  </Field>
                </FieldGroup>
                <Field data-invalid={!!form.formState.errors.environment_id}>
                  <FieldLabel htmlFor="copilot-studio-environment" required>
                    Power Platform environment ID
                  </FieldLabel>
                  <Input
                    id="copilot-studio-environment"
                    required
                    readOnly={!!integration}
                    aria-invalid={!!form.formState.errors.environment_id}
                    {...form.register("environment_id")}
                  />
                  <FieldError errors={[form.formState.errors.environment_id]} />
                </Field>
                <FieldDescription>
                  Enable Settings → Generative AI → Generative orchestration in Microsoft Copilot
                  Studio.
                </FieldDescription>
                <Controller
                  name="failure_mode"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="copilot-studio-failure" required>
                        Failure mode
                      </FieldLabel>
                      <Select
                        name={field.name}
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={pending}
                      >
                        <SelectTrigger
                          id="copilot-studio-failure"
                          ref={field.ref}
                          onBlur={field.onBlur}
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="closed">Fail closed</SelectItem>
                            <SelectItem value="open">Fail open</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </FieldGroup>
            </FieldSet>
            <LoadingButton pending={pending} type="submit">
              {integration ? "Save changes" : "Add connection"}
            </LoadingButton>
            {integration ? (
              <FieldGroup className="gap-5">
                <Separator />
                {!integration.enabled ? (
                  <Alert>
                    <AlertTitle>Connection paused</AlertTitle>
                    <AlertDescription>
                      Enable this connection before saving in Power Platform.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {integration.runtime_error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Protection needs attention</AlertTitle>
                    <AlertDescription>{integration.runtime_error}</AlertDescription>
                  </Alert>
                ) : null}
                <Field>
                  <FieldLabel className="gap-2 text-sm font-medium">
                    <span className="shrink-0 font-mono text-xs text-primary">2</span>
                    Connect Microsoft Copilot Studio
                  </FieldLabel>

                  <div className="flex items-start gap-2">
                    <Textarea
                      readOnly
                      value={credentialCommand}
                      aria-label="Federated credential command"
                      className="field-sizing-content min-h-0 resize-none border-primary/15 bg-muted/40 font-mono text-xs leading-5 text-foreground shadow-none md:text-xs"
                    />
                    <CopyButton
                      content={credentialCommand}
                      label="Copy federated credential command"
                    />
                  </div>
                </Field>
                <Separator />
                <Field>
                  <FieldLabel className="gap-2 text-sm font-medium">
                    <span className="shrink-0 font-mono text-xs text-primary">3</span>
                    Connect Power Platform
                  </FieldLabel>
                  <FieldDescription>
                    In the{" "}
                    <a
                      className="underline"
                      href="https://admin.powerplatform.microsoft.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Power Platform admin center
                    </a>
                    , open:
                  </FieldDescription>
                  <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground marker:text-primary">
                    <li>Security → Threat detection → Additional threat detection.</li>
                    <li>Your environment → Set up.</li>
                    <li>Turn on data sharing and paste these values.</li>
                  </ol>
                </Field>
                <Field>
                  <FieldLabel>Azure Entra App ID</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={integration.application_id}
                      aria-label="Application ID to copy"
                    />
                    <CopyButton
                      content={integration.application_id}
                      label="Copy caller application ID"
                    />
                  </div>
                </Field>
                <Field>
                  <FieldLabel>Endpoint</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={integration.endpoint}
                      aria-label="Webhook endpoint to copy"
                    />
                    <CopyButton content={integration.endpoint} label="Copy webhook endpoint" />
                  </div>
                </Field>
                <Alert className="rounded-none border-0 bg-transparent p-0 [&>svg]:text-primary">
                  <ShieldCheck />
                  <AlertDescription>
                    Set error behavior to{" "}
                    <strong>
                      {integration.failure_mode === "closed"
                        ? "Block the query"
                        : "Allow the agent to respond"}
                    </strong>
                    , then save.
                  </AlertDescription>
                </Alert>
                <Separator />
                <Field>
                  <FieldLabel className="gap-2 text-sm font-medium">
                    <span className="shrink-0 font-mono text-xs text-primary">4</span>
                    Try it
                  </FieldLabel>
                  <FieldDescription>
                    Run a tool in Microsoft Copilot Studio. See it in Lens → Traces and MCP
                    activity.
                  </FieldDescription>
                </Field>
                <div className="flex items-start gap-3">
                  <Link2 className="mt-0.5 size-4 text-muted-foreground" />
                  <div className="text-sm">
                    <p>
                      {integration.validated_at
                        ? "Validated by Microsoft"
                        : "Waiting for validation"}
                    </p>
                  </div>
                </div>
              </FieldGroup>
            ) : null}
          </TabsContent>
          <TabsContent value="policies" className="mt-0 flex flex-col gap-5">
            <Controller
              name="assignment"
              control={form.control}
              render={({ field }) => (
                <SubjectGuardrails
                  assignment={field.value}
                  disabled={pending}
                  policies={data.policies}
                  settings={data.settings}
                  onChange={field.onChange}
                />
              )}
            />
            <FieldDescription>
              Tool-call checks only. Response checks and masking aren&apos;t supported.
            </FieldDescription>
            <LoadingButton pending={pending} type="submit">
              Save guardrails
            </LoadingButton>
          </TabsContent>
        </form>
      </div>
    </Tabs>
  )
}
