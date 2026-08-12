"use client"

import Link from "next/link"
import { useActionState, useMemo, useState } from "react"
import { CircleAlert } from "lucide-react"
import {
  replaceWorkspaceInheritanceAction,
  type WorkspaceInheritanceFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { InheritedResourceType, WorkspaceInheritedResource } from "@/lib/gateway/client"

export function InheritedResourceForm({
  label,
  orgSlug,
  resourceType,
  resources,
  workspaceSlug,
}: {
  label: string
  orgSlug: string
  resourceType: InheritedResourceType
  resources: WorkspaceInheritedResource[]
  workspaceSlug: string
}) {
  const serverSelected = useMemo(
    () => resources.filter((resource) => resource.selected).map((resource) => resource.name),
    [resources]
  )
  const [selected, setSelected] = useState(() =>
    resources.filter((resource) => resource.selected).map((resource) => resource.name)
  )
  const serverSelectedKey = serverSelected.join("\0")
  const [selectedBaselineKey, setSelectedBaselineKey] = useState(serverSelectedKey)
  if (selectedBaselineKey !== serverSelectedKey) {
    setSelectedBaselineKey(serverSelectedKey)
    setSelected(serverSelected)
  }
  const action = replaceWorkspaceInheritanceAction.bind(null, orgSlug, workspaceSlug, resourceType)
  const [state, formAction, pending] = useActionState<WorkspaceInheritanceFormState, FormData>(
    action,
    {}
  )

  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-4">
      {selected.map((name) => (
        <input key={name} name="names" type="hidden" value={name} />
      ))}
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Selection could not be saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="w-full min-w-0 border-b">
        <Table aria-label={`Inherited Organisation ${label}`} className="min-w-3xl">
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Use</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead>Consumers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resources.length === 0 ? (
              <TableRow>
                <TableCell className="text-muted-foreground py-10 text-center" colSpan={5}>
                  No Organisation {label.toLowerCase()} are available.
                </TableCell>
              </TableRow>
            ) : (
              resources.map((resource) => {
                const checked = selected.includes(resource.name)
                const locked =
                  checked && (resource.consumers.length > 0 || Boolean(resource.disabled_reason))
                const description =
                  resource.disabled_reason ??
                  (locked ? "Remove all consumers before unselecting this resource." : undefined)
                return (
                  <TableRow key={resource.name}>
                    <TableCell>
                      <Checkbox
                        aria-label={`${checked ? "Unselect" : "Select"} ${resource.name}`}
                        checked={checked}
                        disabled={pending || locked}
                        onCheckedChange={(next) =>
                          setSelected((current) =>
                            next
                              ? [...current, resource.name]
                              : current.filter((name) => name !== resource.name)
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium break-all">{resource.name}</div>
                      {description ? (
                        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">Organization</span>
                    </TableCell>
                    <TableCell>
                      <span className={resource.ready ? "text-primary" : "text-warning"}>
                        {resource.ready ? "Ready" : "Not ready"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {resource.consumers.length === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {resource.consumers.map((consumer) => {
                            let pathname: string
                            switch (consumer.kind) {
                              case "Agent":
                                pathname = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/agents/${encodeURIComponent(consumer.name)}/sessions/new`
                                break
                              case "Sandbox":
                                pathname = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/sandboxes/update/${encodeURIComponent(consumer.name)}`
                                break
                              case "Inference Pool":
                                pathname = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/inference/pools`
                                break
                              default:
                                pathname = `/orgs/${orgSlug}/workspaces/${workspaceSlug}`
                            }
                            return (
                              <li key={`${consumer.kind}:${consumer.name}`}>
                                <Link className="hover:underline" href={{ pathname }}>
                                  {consumer.kind} / {consumer.name}
                                </Link>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end px-4 pb-6 md:px-6">
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Save selection"}
        </Button>
      </div>
    </form>
  )
}
