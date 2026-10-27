import { Badge } from "@/components/ui/badge"
import type { EventTrailResult, EventTrailTargetType } from "@/lib/gateway/client"

export const targetLabels: Partial<Record<EventTrailTargetType, string>> = {
  guardrail_connection: "Guardrail provider",
}

export function ResultBadge({ result }: { result: EventTrailResult }) {
  if (result === "succeeded") return <Badge variant="success">Succeeded</Badge>
  if (result === "denied") return <Badge variant="warning">Denied</Badge>
  return <Badge variant="destructive">Failed</Badge>
}
