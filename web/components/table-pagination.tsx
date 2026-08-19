"use client"

import { ArrowLeft, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTokenPagination } from "@/lib/use-token-pagination"

export function TablePagination({
  canGoNext,
  canGoPrevious,
  goNext,
  goPrevious,
  pending = false,
}: {
  canGoNext: boolean
  canGoPrevious: boolean
  goNext: () => void
  goPrevious: () => void
  pending?: boolean
}) {
  if (!canGoNext && !canGoPrevious) return null

  return (
    <nav aria-label="Table pagination" className="flex items-center justify-end gap-2 px-2">
      <Button variant="ghost" size="sm" onClick={goPrevious} disabled={!canGoPrevious || pending}>
        <ArrowLeft data-icon="inline-start" />
        Previous
      </Button>
      <Button variant="ghost" size="sm" onClick={goNext} disabled={!canGoNext || pending}>
        Next
        <ArrowRight data-icon="inline-end" />
      </Button>
    </nav>
  )
}

export function TokenTablePagination({
  hasNextPage,
  nextPageToken,
  pageTokenKey = "page_token",
  tokenStackKey = "token_stack",
}: {
  hasNextPage: boolean
  nextPageToken: string
  pageTokenKey?: string
  tokenStackKey?: string
}) {
  const pagination = useTokenPagination({ pageTokenKey, tokenStackKey })

  return (
    <TablePagination
      canGoNext={hasNextPage}
      canGoPrevious={pagination.canGoPrevious}
      goNext={() => pagination.goNext(nextPageToken)}
      goPrevious={pagination.goPrevious}
      pending={pagination.pending}
    />
  )
}
