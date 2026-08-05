"use client"

import * as React from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { getMcpConnection } from "@/lib/gateway/client"
import type { McpConnectionAuthLocation } from "@/lib/gateway/client"

function locationLabel(location?: McpConnectionAuthLocation) {
  if (location?.header) {
    return location.header.prefix
      ? `${location.header.name} (${location.header.prefix})`
      : location.header.name
  }
  if (location?.query_parameter) {
    return `Query: ${location.query_parameter.name}`
  }
  if (location?.cookie) {
    return `Cookie: ${location.cookie.name}`
  }
  return "Default"
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="break-anywhere min-w-0 text-sm">{value}</dd>
    </div>
  )
}

export function McpViewSheet({
  name,
  open,
  onOpenChangeAction,
  workspaceId,
}: {
  name: string
  open: boolean
  onOpenChangeAction: (open: boolean) => void
  workspaceId?: string
}) {
  const query = useQuery(
    queryOptions({
      enabled: open,
      queryKey: ["mcp-connection", workspaceId, name],
      queryFn: async () => {
        const result = await getMcpConnection({
          baseUrl: await getGatewayBaseURL(),
          path: { name },
          headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
        })
        if (result.error) {
          throw new Error(result.error.message)
        }

        return result.data
      },
      retry: false,
      staleTime: 30_000,
    })
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChangeAction}>
      <SheetContent className="h-full overflow-y-auto sm:w-[45rem]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle>MCP connection</SheetTitle>
          <SheetDescription className="sr-only">View MCP connection</SheetDescription>
        </SheetHeader>
        {query.isPending ? (
          <div className="flex flex-1 items-center justify-center px-4 pb-2">
            <Spinner />
          </div>
        ) : query.error instanceof Error ? (
          <div className="px-4 pb-2">
            <Alert variant="destructive">
              <CircleAlert className="size-4" />
              <AlertTitle>Connection could not be loaded</AlertTitle>
              <AlertDescription>{query.error.message}</AlertDescription>
            </Alert>
          </div>
        ) : query.data ? (
          <div className="space-y-6 px-4 pb-4">
            <section className="space-y-3">
              <dl className="space-y-3">
                <DetailRow label="Name" value={query.data.name} />
                <DetailRow label="Endpoint" value={query.data.endpoint.url} />
              </dl>
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium">Headers</h2>
              {Object.entries(query.data.endpoint.headers).length > 0 ? (
                <dl className="space-y-3">
                  {Object.entries(query.data.endpoint.headers).map(([name, value]) => (
                    <DetailRow key={name} label={name} value={value} />
                  ))}
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">No custom endpoint headers.</p>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium">Authentication</h2>
              {query.data.auth.oauth ? (
                <dl className="space-y-3">
                  <DetailRow label="Mode" value="OAuth" />
                  <DetailRow label="Issuer" value={query.data.auth.oauth.issuer ?? "Not set"} />
                  <DetailRow
                    label="Authorization endpoint"
                    value={query.data.auth.oauth.authorization_endpoint ?? "Not set"}
                  />
                  <DetailRow
                    label="Token endpoint"
                    value={query.data.auth.oauth.token_endpoint ?? "Not set"}
                  />
                  <DetailRow
                    label="Registration endpoint"
                    value={query.data.auth.oauth.registration_endpoint ?? "Not set"}
                  />
                  <DetailRow label="Resource" value={query.data.auth.oauth.resource ?? "Not set"} />
                  <DetailRow
                    label="Scopes"
                    value={
                      query.data.auth.oauth.scopes?.length
                        ? query.data.auth.oauth.scopes.join(", ")
                        : "Not set"
                    }
                  />
                  <DetailRow
                    label="Token injection"
                    value={locationLabel(query.data.auth.oauth.location)}
                  />
                </dl>
              ) : query.data.auth.bearer ? (
                <dl className="space-y-3">
                  <DetailRow label="Mode" value="Bearer token" />
                  <DetailRow
                    label="Token injection"
                    value={locationLabel(query.data.auth.bearer.location)}
                  />
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">No authentication metadata.</p>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium">Discovered tools</h2>
              {query.data.tools.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {query.data.tools.map((tool) => (
                    <span
                      key={tool.name}
                      className="bg-secondary text-secondary-foreground inline-flex items-center rounded-md px-2 py-1 text-xs"
                    >
                      {tool.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No tools discovered yet.</p>
              )}
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
