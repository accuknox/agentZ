"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { defineStepper } from "@stepperize/react"
import { Box, Globe2, PackageSearch as PackageSearchIcon, Plus, X } from "lucide-react"
import * as React from "react"
import { useActionState, useState } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { WizardShell } from "@/components/blocks/wizard"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  createEnvironmentFormAction,
  updateEnvironmentFormAction,
} from "@/data/environment.actions"
import * as z from "zod"
import { environmentAllowedHostSchema, environmentNameSchema } from "@/data/schema"
import { PackageSearch } from "./package-search"

type EnvironmentWizardMode = "create" | "update"

type EnvironmentIdentity = {
  name: string
}

type EnvironmentWizardData = {
  identity?: EnvironmentIdentity
  packages?: string[]
}

type EnvironmentWizardProps = {
  initialName?: string
  initialAllowedHosts?: string[]
  initialPackages?: string[]
  mode: EnvironmentWizardMode
}

type PackageStepProps = {
  initialPackages: string[]
  onPrev: () => void
  onNext: (packages: string[]) => void
}

type AllowedHostsStepProps = {
  identity: EnvironmentIdentity
  initialAllowedHosts: string[]
  packages: string[]
  mode: EnvironmentWizardMode
  onPrev: () => void
}

const identitySchema = z.object({
  name: environmentNameSchema,
})

const allowedHostsStepSchema = z.object({
  allowedHosts: z
    .array(environmentAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})

type PackageStepValues = {
  packages: string[]
}

type AllowedHostsStepValues = z.infer<typeof allowedHostsStepSchema>

const steps = [
  {
    id: "identity",
    title: "Identity",
    icon: Box,
  },
  {
    id: "packages",
    title: "Packages",
    icon: PackageSearchIcon,
  },
  {
    id: "allowedHosts",
    title: "Allowed hosts",
    icon: Globe2,
  },
] as const

const { Stepper } = defineStepper(...steps)

const canVisitStep = (index: number, currentIndex: number, data: EnvironmentWizardData) => {
  if (index <= currentIndex) return true
  return Boolean(data.identity)
}

function IdentityForm({
  defaultValues,
  lockName,
  onNext,
}: {
  defaultValues: EnvironmentIdentity
  lockName: boolean
  onNext: (data: EnvironmentIdentity) => void
}) {
  const form = useForm<EnvironmentIdentity>({
    resolver: zodResolver(identitySchema),
    defaultValues,
  })

  return (
    <form id="environment-form-identity" onSubmit={form.handleSubmit(onNext)} className="space-y-5">
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid} data-disabled={lockName}>
              <FieldLabel htmlFor="environment-form-name">Name</FieldLabel>
              <Input
                id="environment-form-name"
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={field.onChange}
                disabled={lockName}
                readOnly={lockName}
                autoComplete="off"
                placeholder="my-environment"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                {lockName
                  ? "Environment name cannot be changed."
                  : "Lowercase letters, numbers, and hyphens only. Max 32 characters."}
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <StepActions>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function PackageStep({ initialPackages, onNext, onPrev }: PackageStepProps) {
  const form = useForm<PackageStepValues>({
    defaultValues: {
      packages: initialPackages,
    },
  })
  const selected = useWatch({
    control: form.control,
    name: "packages",
    defaultValue: initialPackages,
  })

  return (
    <form
      onSubmit={form.handleSubmit((data) => onNext(data.packages))}
      className="flex flex-col gap-5"
    >
      <PackageSearch
        installed={initialPackages}
        selected={selected}
        onSelectedChangeAction={(packages) =>
          form.setValue("packages", packages, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
      />
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          Previous
        </Button>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function AllowedHostsStep({
  identity,
  initialAllowedHosts,
  packages,
  mode,
  onPrev,
}: AllowedHostsStepProps) {
  const [draft, setDraft] = React.useState("")
  const [draftError, setDraftError] = React.useState<string>()
  const formAction =
    mode === "update"
      ? updateEnvironmentFormAction.bind(null, identity.name)
      : createEnvironmentFormAction
  const [state, action, pending] = useActionState(formAction, {})
  const form = useForm<AllowedHostsStepValues>({
    resolver: zodResolver(allowedHostsStepSchema),
    defaultValues: {
      allowedHosts: initialAllowedHosts,
    },
  })
  const submitLabel = mode === "update" ? "Update environment" : "Create environment"
  const pendingLabel = mode === "update" ? "Updating..." : "Creating..."
  const hosts = useWatch({
    control: form.control,
    name: "allowedHosts",
    defaultValue: initialAllowedHosts,
  })
  const allowedHostsError = form.formState.errors.allowedHosts
  const hostFieldInvalid = Boolean(allowedHostsError) || Boolean(draftError)
  const generalError =
    state.error && !state.error.errors?.some((error) => error.field === "allowedHosts")
      ? state.error
      : undefined

  React.useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const error of state.error.errors) {
      if (error.field === "allowedHosts") {
        form.setError("allowedHosts", {
          type: "server",
          message: error.message,
        })
      }
    }
  }, [form, state.error])

  function setHosts(hosts: string[]) {
    form.setValue("allowedHosts", hosts, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  function addHost() {
    const parsed = environmentAllowedHostSchema.safeParse(draft)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? "Host is invalid")
      return
    }

    const nextHosts = Array.from(new Set([...hosts, parsed.data])).sort()
    setHosts(nextHosts)
    setDraft("")
    setDraftError(undefined)
    form.clearErrors("allowedHosts")
  }

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    if (draft.trim() !== "") {
      setDraftError("Add or clear the host before submitting")
      return
    }

    await action(formData)
  }

  return (
    <form action={submitAction} className="flex flex-col gap-5">
      <input type="hidden" name="name" value={identity.name} />
      {packages.map((pkg) => (
        <input key={pkg} type="hidden" name="packages" value={pkg} />
      ))}
      {hosts.map((host) => (
        <input key={host} type="hidden" name="allowedHosts" value={host} />
      ))}
      <FieldSet>
        <FieldLegend>Allowed hosts</FieldLegend>
        <FieldDescription>
          Exact domains, leading wildcard domains, and IPv4 or IPv6 CIDR ranges.
        </FieldDescription>
        <FieldGroup>
          <Field data-invalid={hostFieldInvalid}>
            <FieldLabel htmlFor="environment-form-allowed-host">Host</FieldLabel>
            <InputGroup className="h-9">
              <InputGroupInput
                id="environment-form-allowed-host"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setDraftError(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addHost()
                }}
                placeholder="api.github.com"
                autoComplete="off"
                aria-invalid={hostFieldInvalid}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={addHost} aria-label="Add allowed host">
                  <Plus />
                  Add
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          {hosts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {hosts.map((host) => (
                <Button
                  key={host}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setHosts(hosts.filter((item) => item !== host))}
                >
                  {host}
                  <X data-icon="inline-end" />
                </Button>
              ))}
            </div>
          ) : null}
          {draftError ? <FieldError errors={[{ message: draftError }]} /> : null}
          {allowedHostsError ? <FieldError errors={[allowedHostsError]} /> : null}
        </FieldGroup>
      </FieldSet>
      {generalError ? (
        <div
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <p className="font-medium">{generalError.message}</p>
          {generalError.errors && generalError.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {generalError.errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  {error.field}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev} disabled={pending}>
          Previous
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </StepActions>
    </form>
  )
}

function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-3">{children}</div>
}

export function EnvironmentWizard({
  initialAllowedHosts = [],
  initialName = "",
  initialPackages = [],
  mode,
}: EnvironmentWizardProps) {
  const [direction, setDirection] = useState(1)
  const initialIdentity = { name: initialName }

  return (
    <Stepper.Root
      className="flex min-h-0 w-full flex-1"
      initialMetadata={{
        identity: initialName ? initialIdentity : undefined,
        packages: initialPackages,
      }}
      orientation="horizontal"
    >
      {({ stepper }) => {
        const data: EnvironmentWizardData = {
          identity: stepper.metadata.get("identity") as EnvironmentIdentity | undefined,
          packages: stepper.metadata.get("packages") as string[] | undefined,
        }
        const goPrev = () => {
          setDirection(-1)
          stepper.navigation.prev()
        }
        const goNext = () => {
          setDirection(1)
          stepper.navigation.next()
        }

        return (
          <WizardShell
            steps={steps}
            currentIndex={stepper.state.current.index}
            currentStepId={stepper.state.current.data.id}
            direction={direction}
            layout="horizontal"
            canVisitStepAction={(_, index) =>
              canVisitStep(index, stepper.state.current.index, data)
            }
            onStepSelectAction={(step, index) => {
              setDirection(index >= stepper.state.current.index ? 1 : -1)
              stepper.navigation.goTo(step.id)
            }}
          >
            {stepper.flow.switch({
              identity: () => (
                <IdentityForm
                  defaultValues={data.identity ?? initialIdentity}
                  lockName={mode === "update"}
                  onNext={(identity) => {
                    stepper.metadata.set("identity", identity)
                    goNext()
                  }}
                />
              ),
              packages: () => (
                <PackageStep
                  initialPackages={data.packages ?? initialPackages}
                  onPrev={goPrev}
                  onNext={(packages) => {
                    stepper.metadata.set("packages", packages)
                    goNext()
                  }}
                />
              ),
              allowedHosts: () => (
                <AllowedHostsStep
                  identity={data.identity!}
                  initialAllowedHosts={initialAllowedHosts}
                  packages={data.packages ?? initialPackages}
                  mode={mode}
                  onPrev={goPrev}
                />
              ),
            })}
          </WizardShell>
        )
      }}
    </Stepper.Root>
  )
}
