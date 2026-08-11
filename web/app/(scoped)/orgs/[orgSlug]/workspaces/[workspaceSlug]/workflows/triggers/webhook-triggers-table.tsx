"use client"

import { useRouter } from "@bprogress/next/app"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { useTokenPagination } from "@/lib/use-token-pagination"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatAge } from "@/lib/format"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type WebhookTriggerRow = {
  apiKeyID: string
  apiKeyDisplay: string
  apiKeyName?: string
  deleted: boolean
  lastTriggeredAt: string
  workflowName: string
}

const columnClassName: Record<string, string> = {
  api_key: "min-w-64",
  last_triggered: "w-40",
  workflow_name: "min-w-48",
}

export function WebhookTriggersTable({
  agentName,
  basePath,
  hasNextPage,
  nextPageToken,
  rows,
}: {
  agentName: string
  basePath: string
  hasNextPage: boolean
  nextPageToken: string
  rows: WebhookTriggerRow[]
}) {
  const router = useRouter()
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination({
    pageTokenKey: "page_token",
    tokenStackKey: "token_stack",
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead className={`h-8 px-4 ${columnClassName.api_key}`}>API Key</TableHead>
              <TableHead className={`h-8 px-4 ${columnClassName.workflow_name}`}>
                Workflow
              </TableHead>
              <TableHead className={`h-8 px-4 ${columnClassName.last_triggered}`}>
                Last Triggered
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow
                  key={`${row.workflowName}:${row.apiKeyID}`}
                  className="cursor-pointer"
                  role="link"
                  tabIndex={0}
                  onClick={() => {
                    router.push(
                      `${basePath}/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=webhook&workflow_name=${encodeURIComponent(row.workflowName)}&webhook_api_key_id=${encodeURIComponent(row.apiKeyID)}`
                    )
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") {
                      return
                    }

                    event.preventDefault()
                    router.push(
                      `${basePath}/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=webhook&workflow_name=${encodeURIComponent(row.workflowName)}&webhook_api_key_id=${encodeURIComponent(row.apiKeyID)}`
                    )
                  }}
                >
                  <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.api_key}`}>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.apiKeyName || "Deleted key"}</span>
                        {row.deleted ? <Badge variant="destructivePlain">Deleted</Badge> : null}
                      </div>
                      <code className="text-muted-foreground text-xs">{row.apiKeyDisplay}</code>
                    </div>
                  </TableCell>
                  <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.workflow_name}`}>
                    <span className="font-mono text-sm">{row.workflowName}</span>
                  </TableCell>
                  <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.last_triggered}`}>
                    <span>{formatAge(row.lastTriggeredAt)}</span>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center">
                  No webhook triggers have been used yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {canGoPrevious || hasNextPage ? (
        <div className="flex items-center justify-end gap-2 px-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={goPrevious}
            disabled={!canGoPrevious || pending}
          >
            <ArrowLeft data-icon="inline-start" />
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goNext(nextPageToken)}
            disabled={!hasNextPage || pending}
          >
            Next
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
