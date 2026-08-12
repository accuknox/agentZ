"use client"

import { ArrowLeft, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination"
import { useTokenPagination } from "@/lib/use-token-pagination"

export function EventTrailPagination({ nextPageToken }: { nextPageToken: string }) {
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination({
    pageTokenKey: "page_token",
    tokenStackKey: "token_stack",
  })

  if (!canGoPrevious && !nextPageToken) {
    return null
  }

  return (
    <Pagination className="justify-end" data-pending={pending}>
      <PaginationContent>
        <PaginationItem>
          <Button
            disabled={!canGoPrevious || pending}
            onClick={goPrevious}
            type="button"
            variant="ghost"
          >
            <ArrowLeft data-icon="inline-start" /> Previous
          </Button>
        </PaginationItem>
        <PaginationItem>
          <Button
            disabled={!nextPageToken || pending}
            onClick={() => goNext(nextPageToken)}
            type="button"
            variant="ghost"
          >
            Next <ArrowRight data-icon="inline-end" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}
