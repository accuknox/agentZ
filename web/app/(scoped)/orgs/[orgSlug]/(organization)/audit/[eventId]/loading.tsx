import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-label="Loading audit event" role="status">
      <Skeleton className="min-h-96 w-full" />
      <span className="sr-only">Loading audit event…</span>
    </div>
  )
}
