"use client"

import { useId, useState } from "react"
import { useParams } from "next/navigation"
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import { ChevronDown, RefreshCw } from "lucide-react"
import type {
  GuardrailCheck,
  GuardrailConnection,
  GuardrailDiscoveredResource,
  GuardrailResourceDiscoveryInput,
} from "@/lib/gateway/client"
import {
  discoverGuardrailResourcesAction,
  type GuardrailActionScope,
} from "@/data/guardrail.actions"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { authClient } from "@/lib/auth-client"

type GuardrailProviderResourcesProps = {
  check: GuardrailCheck
  connection: GuardrailConnection
  disabled: boolean
  scope: GuardrailActionScope
  validationVisible: boolean
  onChange: (check: GuardrailCheck) => void
}

export function GuardrailProviderResources(props: GuardrailProviderResourcesProps) {
  const { check, connection, disabled, scope, validationVisible, onChange } = props

  const [project, setProject] = useState(() =>
    check.template ? check.template.split("/").slice(0, 2).join("/") : ""
  )
  const [location, setLocation] = useState(() =>
    check.template ? check.template.split("/").slice(0, 4).join("/") : ""
  )

  if (connection.provider === "Bedrock")
    return (
      <FieldGroup className="gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ResourcePicker
            connection={connection}
            disabled={disabled}
            kind="guardrails"
            label="AWS guardrail"
            onSelect={(resource) => {
              if (resource.id === check.guardrailId) return
              onChange({
                ...check,
                name: check.name || resource.label,
                guardrailId: resource.id,
                guardrailVersion: undefined,
              })
            }}
            scope={scope}
            validationVisible={validationVisible}
            value={check.guardrailId ?? ""}
          />
          <ResourcePicker
            connection={connection}
            disabled={disabled || !check.guardrailId}
            kind="versions"
            label="Version"
            onSelect={(resource) => onChange({ ...check, guardrailVersion: resource.id })}
            parent={check.guardrailId}
            scope={scope}
            validationVisible={validationVisible}
            value={check.guardrailVersion ?? ""}
          />
        </div>
        <FieldDescription className="text-xs">
          Region: {connection.region}.{" "}
          <a
            href="https://console.aws.amazon.com/bedrock/home#/guardrails"
            target="_blank"
            rel="noreferrer"
          >
            Manage in AWS
          </a>
        </FieldDescription>
      </FieldGroup>
    )

  if (connection.provider === "ModelArmor")
    return (
      <FieldGroup className="gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <ResourcePicker
            connection={connection}
            disabled={disabled}
            kind="projects"
            label="Google Cloud project"
            onSelect={(resource) => {
              if (resource.id === project) return
              setProject(resource.id)
              setLocation("")
              onChange({ ...check, template: undefined })
            }}
            scope={scope}
            validationVisible={validationVisible}
            value={project}
          />
          <ResourcePicker
            connection={connection}
            disabled={disabled || !project}
            kind="locations"
            label="Location"
            onSelect={(resource) => {
              if (resource.id === location) return
              setLocation(resource.id)
              onChange({ ...check, template: undefined })
            }}
            parent={project}
            scope={scope}
            validationVisible={validationVisible}
            value={location}
          />
        </div>
        <ResourcePicker
          connection={connection}
          disabled={disabled || !location}
          kind="templates"
          label="Model Armor template"
          onSelect={(resource) =>
            onChange({ ...check, name: check.name || resource.label, template: resource.id })
          }
          parent={location}
          scope={scope}
          validationVisible={validationVisible}
          value={check.template ?? ""}
        />
        <FieldDescription className="text-xs">
          <a
            href="https://console.cloud.google.com/security/model-armor"
            target="_blank"
            rel="noreferrer"
          >
            Manage in Google Cloud
          </a>
        </FieldDescription>
      </FieldGroup>
    )

  if (connection.provider === "OpenAI")
    return <FieldDescription className="text-xs">omni-moderation-latest</FieldDescription>

  return null
}

type ResourcePickerProps = {
  connection: GuardrailConnection
  disabled: boolean
  kind: GuardrailResourceDiscoveryInput["kind"]
  label: string
  parent?: string
  scope: GuardrailActionScope
  value: string
  validationVisible: boolean
  onSelect: (resource: GuardrailDiscoveredResource) => void
}

function ResourcePicker(props: ResourcePickerProps) {
  const { connection, disabled, kind, label, parent, scope, value, validationVisible, onSelect } =
    props

  const id = useId()
  const { orgSlug } = useParams<{ orgSlug: string }>()
  const { data: actor } = authClient.useSession()
  const [open, setOpen] = useState(false)
  const query = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: [
        "guardrail-resources",
        orgSlug,
        actor?.user.id,
        scope.workspaceId,
        connection.scope,
        connection.name,
        connection.status.revision,
        kind,
        parent,
      ],
      queryFn: async ({ pageParam }) => {
        const result = await discoverGuardrailResourcesAction(
          { workspaceId: scope.workspaceId },
          connection.name,
          {
            scope: connection.scope,
            kind,
            parent,
            pageSize: 50,
            pageToken: pageParam || undefined,
          }
        )
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      initialPageParam: "",
      getNextPageParam: (page) => page.nextPageToken || undefined,
      enabled: open && !disabled && actor?.user.id !== undefined,
      staleTime: 60_000,
      retry: false,
    })
  )
  const resources = query.data?.pages.flatMap((page) => page.items) ?? []
  const selected = resources.find((resource) => resource.id === value)
  const invalid = validationVisible && value === "" && !disabled
  const unreachable = query.data?.pages.flatMap((page) => page.unreachable ?? []) ?? []
  const missing =
    value !== "" &&
    query.isSuccess &&
    !query.hasNextPage &&
    !query.isFetching &&
    unreachable.length === 0 &&
    selected === undefined

  return (
    <Field className="min-w-0" data-invalid={invalid}>
      <FieldLabel htmlFor={id} required>
        {label}
      </FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-controls={open ? `${id}-list` : undefined}
            aria-expanded={open}
            aria-required="true"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : undefined}
            className="w-full min-w-0 justify-between font-normal"
            disabled={disabled}
            id={id}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="truncate">{selected?.label ?? (value || `Select ${label}`)}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-3rem)] p-0"
        >
          <Command>
            <CommandInput aria-label={`Search ${label}`} placeholder="Search loaded resources…" />
            <CommandList id={`${id}-list`}>
              {query.isPending ? (
                <div
                  className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
                  role="status"
                >
                  <Spinner /> Loading resources…
                </div>
              ) : null}
              {!query.isPending && !query.error ? (
                <CommandEmpty>
                  {query.hasNextPage
                    ? "No matches in loaded resources. Load more to continue."
                    : "No resources found."}
                </CommandEmpty>
              ) : null}
              <CommandGroup>
                {resources.map((resource) => (
                  <CommandItem
                    data-checked={resource.id === value}
                    key={resource.id}
                    keywords={[resource.label, resource.description ?? ""]}
                    onSelect={() => {
                      onSelect(resource)
                      setOpen(false)
                    }}
                    value={resource.id}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{resource.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {resource.description || resource.id}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          {query.error ? (
            <p className="px-3 text-xs text-destructive" role="alert">
              {query.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t p-2">
            <Button
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RefreshCw data-icon="inline-start" /> {query.error ? "Retry" : "Refresh"}
            </Button>
            {query.hasNextPage ? (
              <Button
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
                size="sm"
                type="button"
                variant="outline"
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {invalid ? <FieldError id={`${id}-error`}>Select {label}.</FieldError> : null}
      {selected && selected.id !== selected.label ? (
        <FieldDescription className="text-xs break-all">{selected.id}</FieldDescription>
      ) : null}
      {missing ? (
        <FieldDescription className="text-xs">
          The saved selection was not found. Its reference has been retained.
        </FieldDescription>
      ) : null}
      {unreachable.length ? (
        <FieldDescription className="text-xs break-words">
          Some locations could not be listed: {unreachable.join(", ")}.
        </FieldDescription>
      ) : null}
    </Field>
  )
}
