"use client"

import { useActionState } from "react"
import type { OrganizationSummary } from "@/data/organizations"
import {
  renameOrganizationAction,
  type RenameOrganizationFormState,
} from "@/app/(scoped)/orgs/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function OrganizationForm({ organization }: { organization: OrganizationSummary }) {
  const initialState: RenameOrganizationFormState = {
    values: {
      name: organization.name,
      slug: organization.slug,
    },
  }
  const [state, action, pending] = useActionState(
    renameOrganizationAction.bind(null, organization.id),
    initialState
  )

  return (
    <form action={action} aria-label="Organisation details" className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Organisation details</h2>
          </CardTitle>
          <CardDescription>
            Update how this Organisation appears and the address used to reach it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(state.errors?.name)}>
              <FieldLabel htmlFor="organization-name" required>
                Name
              </FieldLabel>
              <Input
                aria-invalid={Boolean(state.errors?.name)}
                defaultValue={state.values.name}
                id="organization-name"
                maxLength={100}
                name="name"
                required
              />
              {state.errors?.name ? (
                <FieldError errors={state.errors.name.map((message) => ({ message }))} />
              ) : null}
            </Field>
            <Field data-invalid={Boolean(state.errors?.slug)}>
              <FieldLabel htmlFor="organization-slug" required>
                URL slug
              </FieldLabel>
              <Input
                aria-invalid={Boolean(state.errors?.slug)}
                autoCapitalize="none"
                autoCorrect="off"
                defaultValue={state.values.slug}
                id="organization-slug"
                maxLength={63}
                minLength={3}
                name="slug"
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                required
                spellCheck={false}
              />
              <FieldDescription>
                Lowercase letters, numbers, and single hyphens only.
              </FieldDescription>
              {state.errors?.slug ? (
                <FieldError errors={state.errors.slug.map((message) => ({ message }))} />
              ) : null}
            </Field>
            {state.errors?.form ? <FieldError errors={[{ message: state.errors.form }]} /> : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button aria-busy={pending} disabled={pending} type="submit">
            {pending ? <Spinner /> : null}
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
