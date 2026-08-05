import { Skeleton } from "@/components/ui/skeleton"
import { AuditDrawer } from "../../audit-drawer"

export default function Loading() {
  return (
    <AuditDrawer>
      <div aria-label="Loading audit event" role="status">
        <Skeleton className="min-h-96 w-full" />
        <span className="sr-only">Loading audit event…</span>
      </div>
    </AuditDrawer>
  )
}
