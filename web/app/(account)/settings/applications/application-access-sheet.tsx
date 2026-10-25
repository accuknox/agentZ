"use client"

import type { ReactNode } from "react"
import { Building2, Check, ChevronDown, Cpu, Plug } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { TruncatedText } from "@/components/ui/tooltip"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { formatTimestamp } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ConnectedApplication } from "./connected-applications"

const permissions: Record<string, string> = {
  openid: "Sign in with your account",
  profile: "Read your name and profile image",
  email: "Read your email address and verification status",
  offline_access: "Keep access when you are away, until you disconnect",
  "inference:use": "Send requests to approved models",
  "mcp:use": "Use approved MCP tools, prompts, and resources",
}

export function ApplicationAccessSheet({
  application,
  workspaces,
  onClose,
}: {
  application: ConnectedApplication
  workspaces: Record<string, string>
  onClose: () => void
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle className="break-all">{application.name}</SheetTitle>
          <SheetDescription className="sr-only">
            Application permissions and resource access
          </SheetDescription>
        </SheetHeader>
        <ApplicationAccessDetails application={application} workspaces={workspaces} />
      </SheetContent>
    </Sheet>
  )
}

export function ApplicationAccessDetails({
  application,
  workspaces,
  identity,
  workspaceScoped = false,
}: {
  application: ConnectedApplication
  workspaces: Record<string, string>
  identity?: ReactNode
  workspaceScoped?: boolean
}) {
  const accountScopes = application.scopes.filter(
    (scope) => scope !== "inference:use" && scope !== "mcp:use"
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 px-4">
        {identity ? (
          <>
            <dt className="text-muted-foreground">User</dt>
            <dd className="min-w-0">{identity}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Owned by</dt>
        <dd className="flex min-w-0 items-center gap-2">
          {application.owner ? (
            <Building2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="break-words">{application.owner ?? "Unknown owner"}</span>
        </dd>
        <dt className="text-muted-foreground">Connected</dt>
        <dd>
          <time dateTime={application.createdAt}>{formatTimestamp(application.createdAt)}</time>
        </dd>
      </dl>
      <Separator />
      <section className="flex flex-col gap-3 px-4" aria-labelledby="application-permissions">
        <h3 id="application-permissions" className="font-medium">
          Permissions
        </h3>
        {application.scopes.length ? (
          <div className="flex flex-col gap-3">
            {accountScopes.length ? (
              <details className="group" open>
                <summary className="flex cursor-pointer list-none items-center gap-3 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
                  Your account information
                  <ChevronDown
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-muted-foreground group-open:rotate-180"
                  />
                </summary>
                <ul className="mt-2 flex list-disc flex-col gap-2 pl-8 leading-relaxed text-muted-foreground">
                  {accountScopes.map((scope) => (
                    <li key={scope} className="break-words">
                      {permissions[scope] ?? scope}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {application.scopes.includes("inference:use") ? (
              <div className="flex items-center gap-3 py-2">
                <Cpu aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                {permissions["inference:use"]}
              </div>
            ) : null}
            {application.scopes.includes("mcp:use") ? (
              <div className="flex items-center gap-3 py-2">
                <Plug aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                {permissions["mcp:use"]}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground">No permissions granted.</p>
        )}
      </section>
      {application.scopes.includes("inference:use") ? (
        <p className="px-4 text-sm text-muted-foreground">
          Model requests follow required organization guardrails and any policies assigned to this
          application&apos;s authorized workspace access. Workspace administrators manage these
          policies.
        </p>
      ) : null}
      <Separator />
      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="application-resources">
        <h3 id="application-resources" className="px-4 font-medium">
          Resource access
        </h3>
        {application.access.length ? (
          application.access.map((access) => (
            <section key={access.organizationId} className="flex min-w-0 flex-col gap-2">
              {!workspaceScoped ? (
                <h4 className="flex items-center gap-2 px-4 text-xs font-medium break-words text-muted-foreground">
                  <Building2 aria-hidden="true" className="size-4 shrink-0" />
                  {access.organization ?? "Organization unavailable"}
                </h4>
              ) : null}
              {access.selection.models.length ? (
                <Table
                  aria-label={`Resource access in ${access.organization ?? "unavailable organization"}`}
                  className="w-full table-fixed"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead className={cn("px-4", workspaceScoped ? "w-1/2" : "w-1/3")}>
                        Resource
                      </TableHead>
                      {!workspaceScoped ? (
                        <TableHead className="w-1/4 px-4">Workspace</TableHead>
                      ) : null}
                      <TableHead className="px-4">Access</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {access.selection.models.map((model) => (
                      <TableRow key={model.id}>
                        <TableCell className="px-4 py-3 align-top whitespace-normal">
                          <div className="break-words">
                            {model.model_display_name || model.model}
                          </div>
                          <div className="text-xs break-all text-muted-foreground">
                            {model.provider_display_name || model.provider} / {model.model}
                          </div>
                        </TableCell>
                        {!workspaceScoped ? (
                          <TableCell className="px-4 py-3 align-top break-all whitespace-normal text-muted-foreground">
                            {workspaces[model.workspace_id] ?? model.workspace_id}
                          </TableCell>
                        ) : null}
                        <TableCell className="px-4 py-3 align-top whitespace-normal text-muted-foreground">
                          Model inference
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
              {access.selection.mcp.map((connection) => (
                <section key={connection.id} className="flex min-w-0 flex-col gap-4 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Plug aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <TruncatedText className="min-w-0 font-medium" value={connection.connection} />
                    {!workspaceScoped ? (
                      <span className="ml-auto min-w-0 text-xs text-muted-foreground">
                        <TruncatedText
                          className="block"
                          value={workspaces[connection.workspace_id] ?? connection.workspace_id}
                        />
                      </span>
                    ) : null}
                  </div>
                  <dl className="flex min-w-0 flex-col gap-4">
                    {(["tools", "prompts", "resources"] as const).map((capability) =>
                      connection[capability].length ? (
                        <div key={capability} className="flex min-w-0 flex-col gap-2">
                          <dt className="text-sm font-medium capitalize">{capability}</dt>
                          <dd className="flex min-w-0 flex-wrap gap-2">
                            {connection[capability].map((name) => (
                              <Badge key={name} variant="secondary" className="max-w-full min-w-0">
                                <TruncatedText value={name} />
                              </Badge>
                            ))}
                          </dd>
                        </div>
                      ) : null
                    )}
                  </dl>
                  {!connection.tools.length &&
                  !connection.prompts.length &&
                  !connection.resources.length ? (
                    <p className="text-sm text-muted-foreground">No capabilities approved.</p>
                  ) : null}
                </section>
              ))}
            </section>
          ))
        ) : (
          <p className="px-4 text-muted-foreground">No models or MCP connections approved.</p>
        )}
      </section>
    </div>
  )
}
