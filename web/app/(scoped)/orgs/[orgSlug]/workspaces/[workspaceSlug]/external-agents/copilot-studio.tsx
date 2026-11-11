"use client"

import { useState, type TransitionStartFunction } from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { BrickWallShield, Link2, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import type { CopilotStudioIntegrationInput } from "@/lib/gateway/client"
import { loadCopilotStudioAction, saveCopilotStudioAction } from "./actions"
import { RequestError } from "@/components/request-error"
import { SubjectGuardrails } from "@/components/guardrails/subject-guardrails"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
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

export function CopilotStudio({
  integrationId,
  onSaved,
  ...scope
}: CopilotStudioProps & { integrationId?: string; onSaved: (id: string) => void }) {
  const query = useQuery(
    queryOptions({
      queryKey: ["copilotStudio", scope.orgSlug, scope.workspaceSlug, integrationId],
      meta: { externalAgentScope: `${scope.orgSlug}/${scope.workspaceSlug}` },
      queryFn: () => loadCopilotStudioAction(scope.orgSlug, scope.workspaceSlug, integrationId),
      retry: false,
    })
  )
  if (query.isPending && integrationId)
    return (
      <Tabs defaultValue="installation" className="min-h-0 gap-4" aria-busy>
        <TabsList className="w-full">
          <TabsTrigger value="connection" disabled>
            Connection
          </TabsTrigger>
          <TabsTrigger value="installation" disabled>
            Installation
          </TabsTrigger>
        </TabsList>
        <FieldGroup
          role="status"
          aria-label="Loading installation"
          className="overflow-y-auto px-1 pb-1"
        >
          <Field aria-hidden>
            <FieldLabel>1. Configure Microsoft Entra</FieldLabel>
            <Skeleton className="h-10 w-full" />
          </Field>
          {["Issuer", "Subject identifier", "Audience", "AgentZ provider application ID"].map(
            (label) => (
              <Field key={label} aria-hidden>
                <FieldLabel>{label}</FieldLabel>
                <div className="flex items-start gap-2">
                  <Skeleton className="h-9 flex-1" />
                  <Skeleton className="size-9 shrink-0" />
                </div>
              </Field>
            )
          )}
        </FieldGroup>
      </Tabs>
    )
  if (query.error)
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
  if (query.data && !query.data.enabled)
    return (
      <Alert>
        <AlertTitle>Copilot Studio unavailable</AlertTitle>
        <AlertDescription>Contact your platform administrator to enable it.</AlertDescription>
      </Alert>
    )
  const integration = query.data?.integration
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
      onSaved={(id) => {
        if (integrationId) void query.refetch()
        onSaved(id)
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
  data?: CopilotStudioData
  onSaved: (id: string) => void
}) {
  const integration = data?.integration
  const [input, setInput] = useState<CopilotStudioIntegrationInput>({
    name: integration?.name ?? "Copilot Studio",
    tenant_id: integration?.tenant_id ?? "",
    application_id: integration?.application_id ?? "",
    environment_id: integration?.environment_id ?? "",
    enabled: integration?.enabled ?? false,
    failure_mode: integration?.failure_mode ?? "closed",
    assignment: integration?.assignment ?? { policies: [] },
  })
  const [tab, setTab] = useState(integration ? "installation" : "connection")
  const [error, setError] = useState("")

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="min-h-0 gap-4"
      aria-busy={!data || undefined}
    >
      <TabsList className="w-full">
        <TabsTrigger value="connection">Connection</TabsTrigger>
        <TabsTrigger value="installation" disabled={!integration}>
          Installation
        </TabsTrigger>
      </TabsList>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-1 pb-1">
        {error ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <TabsContent value="connection" className="mt-0">
          <form
            autoComplete="off"
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              if (!data) return
              setError("")
              startTransition(async () => {
                const result = await saveCopilotStudioAction(
                  scope.orgSlug,
                  scope.workspaceSlug,
                  input,
                  integration?.id
                )
                if (result.data === undefined) {
                  setError(result.error)
                  return
                }
                onSaved(result.data.id)
                setTab("installation")
                toast.success("Copilot Studio connection saved")
              })
            }}
          >
            <FieldSet
              disabled={pending || !data}
              className={
                !data
                  ? "**:data-[slot=input]:animate-pulse **:data-[slot=input]:bg-muted **:data-[slot=input]:text-transparent **:data-[slot=input]:placeholder:text-transparent"
                  : undefined
              }
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="copilot-studio-name">Connection name</FieldLabel>
                  <Input
                    id="copilot-studio-name"
                    required
                    maxLength={120}
                    value={input.name}
                    onChange={(event) => setInput({ ...input, name: event.target.value })}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="copilot-studio-tenant">Directory tenant ID</FieldLabel>
                    <Input
                      id="copilot-studio-tenant"
                      required
                      readOnly={!!integration}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      value={input.tenant_id}
                      onChange={(event) => setInput({ ...input, tenant_id: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="copilot-studio-application">
                      Application client ID
                    </FieldLabel>
                    <Input
                      id="copilot-studio-application"
                      required
                      readOnly={!!integration}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      value={input.application_id}
                      onChange={(event) =>
                        setInput({ ...input, application_id: event.target.value })
                      }
                    />
                  </Field>
                </div>
                {!integration ? (
                  <FieldDescription>
                    In the{" "}
                    <a
                      className="underline"
                      href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Azure portal
                    </a>
                    , register a single-tenant app and enter its tenant and client IDs above.
                  </FieldDescription>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="copilot-studio-environment">
                    Power Platform environment ID
                  </FieldLabel>
                  <Input
                    id="copilot-studio-environment"
                    required
                    readOnly={!!integration}
                    value={input.environment_id}
                    onChange={(event) => setInput({ ...input, environment_id: event.target.value })}
                  />
                </Field>
                <FieldDescription>
                  Requires generative orchestration in Copilot Studio.
                </FieldDescription>
                {data ? (
                  <SubjectGuardrails
                    assignment={input.assignment}
                    disabled={pending}
                    policies={data.policies}
                    settings={data.settings}
                    onChange={(value) => setInput({ ...input, assignment: value })}
                  />
                ) : (
                  <FieldGroup className="min-w-0 gap-6" role="status" aria-label="Loading policies">
                    <Field>
                      <FieldLabel>
                        <BrickWallShield aria-hidden className="size-4 text-primary" />
                        Policies
                      </FieldLabel>
                      <Skeleton className="h-8 w-full" />
                    </Field>
                  </FieldGroup>
                )}
                <FieldDescription>
                  Tool-call checks only. Response checks and masking aren&apos;t supported.
                </FieldDescription>
                <Field orientation="horizontal">
                  <div className="flex-1">
                    <FieldLabel htmlFor="copilot-studio-failure">
                      Block when evaluation is unavailable
                    </FieldLabel>
                    <FieldDescription>Match the Power Platform error behavior.</FieldDescription>
                  </div>
                  <Switch
                    id="copilot-studio-failure"
                    checked={input.failure_mode === "closed"}
                    onCheckedChange={(checked) =>
                      setInput({ ...input, failure_mode: checked ? "closed" : "open" })
                    }
                  />
                </Field>
                <Field orientation="horizontal">
                  <div className="flex-1">
                    <FieldLabel htmlFor="copilot-studio-enabled">Enable connection</FieldLabel>
                  </div>
                  <Switch
                    id="copilot-studio-enabled"
                    checked={input.enabled}
                    onCheckedChange={(enabled) => setInput({ ...input, enabled })}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
            <LoadingButton pending={pending || !data} type="submit">
              Save connection
            </LoadingButton>
          </form>
        </TabsContent>
        <TabsContent value="installation" className="mt-0 flex flex-col gap-5">
          {integration ? (
            <>
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
                <FieldLabel>1. Configure Microsoft Entra</FieldLabel>
                <FieldDescription>
                  App registrations → your app → Certificates &amp; secrets → Federated credentials.
                  Add Other issuer, choose Explicit subject identifier, and enter these values.
                </FieldDescription>
              </Field>
              {[
                { label: "Issuer", value: integration.federated_credential.issuer },
                {
                  label: "Subject identifier",
                  value: integration.federated_credential.subject,
                },
                { label: "Audience", value: integration.federated_credential.audience },
              ].map(({ label, value }) => (
                <Field key={label}>
                  <FieldLabel>{label}</FieldLabel>
                  <div className="flex items-start gap-2">
                    <Textarea
                      readOnly
                      value={value}
                      className="field-sizing-content min-h-0 resize-none font-mono text-xs md:text-xs"
                      aria-label={`${label} to copy`}
                    />
                    <CopyButton content={value} label={`Copy ${label.toLowerCase()}`} />
                  </div>
                </Field>
              ))}
              <Field>
                <FieldLabel>AgentZ provider application ID</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={integration.audience}
                    aria-label="Provider application ID to copy"
                  />
                  <CopyButton content={integration.audience} label="Copy provider application ID" />
                </div>
                <FieldDescription>
                  Provision this enterprise application in your Entra tenant.
                </FieldDescription>
              </Field>
              <Separator />
              <Field>
                <FieldLabel>2. Connect Power Platform</FieldLabel>
                <FieldDescription>
                  Open Security → Threat detection → Additional threat detection in the{" "}
                  <a
                    className="underline"
                    href="https://admin.powerplatform.microsoft.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Power Platform admin center
                  </a>
                  . Select this environment and enable data sharing. Power Platform Administrator
                  required.
                </FieldDescription>
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
              <Alert>
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
              <div className="flex items-start gap-3">
                <Link2 className="mt-0.5 size-4 text-muted-foreground" />
                <div className="text-sm">
                  <p>
                    {integration.validated_at ? "Validated by Microsoft" : "Waiting for validation"}
                  </p>
                  {!integration.last_seen_at ? (
                    <p className="mt-1 text-muted-foreground">
                      Invoke a tool to discover the agent in AgentZ.
                    </p>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </TabsContent>
      </div>
    </Tabs>
  )
}
