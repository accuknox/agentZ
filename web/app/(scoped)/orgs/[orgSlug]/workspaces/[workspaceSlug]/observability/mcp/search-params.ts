import { dayjs } from "@/lib/format"

export type McpDateRange = {
  from: string
  to: string
}

/**
 * mcpDateRange resolves the URL date filters to API-ready day bounds.
 */
export function mcpDateRange(from?: string, to?: string): McpDateRange {
  const parsedFrom = dayjs(from, "YYYY-MM-DD", true)
  const parsedTo = dayjs(to, "YYYY-MM-DD", true)
  if (parsedFrom.isValid() && parsedTo.isValid()) {
    return {
      from: parsedFrom.format("YYYY-MM-DD"),
      to: parsedTo.format("YYYY-MM-DD"),
    }
  }

  const now = dayjs()
  const yesterday = now.subtract(24, "hour")

  return {
    from: yesterday.startOf("day").format("YYYY-MM-DD"),
    to: now.endOf("day").format("YYYY-MM-DD"),
  }
}
