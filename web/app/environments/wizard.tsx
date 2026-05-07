"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { defineStepper } from "@stepperize/react"
import { Box, PackageSearch as PackageSearchIcon } from "lucide-react"
import * as React from "react"
import { useActionState, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { WizardShell } from "@/components/blocks/wizard"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  createEnvironmentFormAction,
  updateEnvironmentFormAction,
} from "@/data/environment.actions"
import * as z from "zod"
import { environmentNameSchema } from "@/data/schema"
import { PackageSearch } from "./package-search"

type EnvironmentWizardMode = "create" | "update"

type EnvironmentIdentity = {
  name: string
}

type EnvironmentWizardData = {
  identity?: EnvironmentIdentity
}

type EnvironmentWizardProps = {
  initialName?: string
  initialPackages?: string[]
  mode: EnvironmentWizardMode
}

type PackageStepProps = {
  identity: EnvironmentIdentity
  initialPackages: string[]
  mode: EnvironmentWizardMode
  onPrev: () => void
}

const identitySchema = z.object({
  name: environmentNameSchema,
})

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

function PackageStep({ identity, initialPackages, mode, onPrev }: PackageStepProps) {
  const [selected, setSelected] = React.useState<string[]>(initialPackages)
  const formAction =
    mode === "update"
      ? updateEnvironmentFormAction.bind(null, identity.name)
      : createEnvironmentFormAction
  const [state, action, pending] = useActionState(formAction, {})
  const submitLabel = mode === "update" ? "Update environment" : "Create environment"
  const pendingLabel = mode === "update" ? "Updating..." : "Creating..."

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="name" value={identity.name} />
      {selected.map((pkg) => (
        <input key={pkg} type="hidden" name="packages" value={pkg} />
      ))}
      <PackageSearch
        installed={initialPackages}
        selected={selected}
        onSelectedChangeAction={setSelected}
      />
      {state.error ? (
        <div
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <p className="font-medium">{state.error.message}</p>
          {state.error.errors && state.error.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {state.error.errors.map((error) => (
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
  initialName = "",
  initialPackages = [],
  mode,
}: EnvironmentWizardProps) {
  const [direction, setDirection] = useState(1)
  const initialIdentity = { name: initialName }

  return (
    <Stepper.Root
      className="flex min-h-0 w-full flex-1"
      initialMetadata={{ identity: initialName ? initialIdentity : undefined }}
      orientation="horizontal"
    >
      {({ stepper }) => {
        const data: EnvironmentWizardData = {
          identity: stepper.metadata.get("identity") as EnvironmentIdentity | undefined,
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
              packages: () =>
                data.identity ? (
                  <PackageStep
                    identity={data.identity}
                    initialPackages={initialPackages}
                    mode={mode}
                    onPrev={goPrev}
                  />
                ) : (
                  <div className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                      Complete the identity step before selecting packages.
                    </p>
                    <Button type="button" variant="secondary" onClick={goPrev}>
                      Previous
                    </Button>
                  </div>
                ),
            })}
          </WizardShell>
        )
      }}
    </Stepper.Root>
  )
}
