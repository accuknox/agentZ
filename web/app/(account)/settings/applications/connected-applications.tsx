"use client"

import { useState, useTransition } from "react"
import { AppWindow, Unplug } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { disconnectApplicationAction } from "./actions"
import type { DelegationCatalog } from "@/lib/gateway/client"

type ConnectedApplication = {
  clientId: string
  name: string
  owner: string | null
  scopes: string[]
  grants: { organization: string | null; selection: DelegationCatalog }[]
  createdAt: string
}

export function ConnectedApplications({
  applications,
  workspaces,
}: {
  applications: ConnectedApplication[]
  workspaces: Record<string, string>
}) {
  const [selected, setSelected] = useState<ConnectedApplication>()
  const [pending, startTransition] = useTransition()
  return (
    <div className="px-4 pb-8 md:px-6">
      {applications.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <AppWindow aria-hidden="true" className="size-8 text-muted-foreground" />
          <h2 className="font-semibold">No connected applications</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Applications appear here after you allow them to sign in with AgentZ.
          </p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {applications.map((application) => (
            <article className="space-y-3 p-4" key={application.clientId}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{application.name}</h2>
                  <p className="text-sm text-muted-foreground">{application.owner}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelected(application)}>
                  <Unplug aria-hidden="true" />
                  Disconnect
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {application.scopes.map((scope) => (
                  <Badge variant="outline" key={scope}>
                    {scope}
                  </Badge>
                ))}
              </div>
              {application.grants.map((grant, index) =>
                grant.selection.models.length || grant.selection.mcp.length ? (
                  <details className="rounded-lg border px-3 py-2 text-sm" key={index}>
                    <summary className="cursor-pointer font-medium">
                      {grant.organization ?? "Resource access"} · {grant.selection.models.length}{" "}
                      {grant.selection.models.length === 1 ? "model" : "models"} ·{" "}
                      {grant.selection.mcp.length} MCP{" "}
                      {grant.selection.mcp.length === 1 ? "connection" : "connections"}
                    </summary>
                    <div className="mt-3 space-y-4">
                      {[
                        ...new Set(
                          [...grant.selection.models, ...grant.selection.mcp].map(
                            (item) => item.workspace_id
                          )
                        ),
                      ].map((workspaceId) => (
                        <section key={workspaceId} className="space-y-2">
                          <h3 className="font-medium">{workspaces[workspaceId] ?? workspaceId}</h3>
                          {grant.selection.models
                            .filter((model) => model.workspace_id === workspaceId)
                            .map((model) => (
                              <p key={model.id} className="break-all text-muted-foreground">
                                {model.provider} / {model.model}
                              </p>
                            ))}
                          {grant.selection.mcp
                            .filter((connection) => connection.workspace_id === workspaceId)
                            .map((connection) => (
                              <div
                                key={connection.id}
                                className="space-y-1 rounded-md bg-muted/30 p-3"
                              >
                                <h4 className="font-medium">{connection.connection}</h4>
                                {(["tools", "prompts", "resources"] as const).map((capability) =>
                                  connection[capability].length ? (
                                    <p key={capability} className="break-all text-muted-foreground">
                                      <span className="capitalize">{capability}</span>:{" "}
                                      {connection[capability].join(", ")}
                                    </p>
                                  ) : null
                                )}
                              </div>
                            ))}
                        </section>
                      ))}
                    </div>
                  </details>
                ) : null
              )}
              <p className="text-xs text-muted-foreground">
                Connected {new Date(application.createdAt).toLocaleDateString()}
              </p>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!pending && !open) setSelected(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {selected?.name}?</DialogTitle>
            <DialogDescription>
              This revokes every authorization for this application. It cannot start new requests or
              refresh access. Work already dispatched may finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setSelected(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!selected) return
                  const result = await disconnectApplicationAction(selected.clientId)
                  if ("error" in result) {
                    toast.error(result.error)
                    return
                  }
                  setSelected(undefined)
                  toast.success("Application disconnected")
                })
              }
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
