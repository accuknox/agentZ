import { dayjs } from "@/lib/format"
import type { Error } from "@/lib/gateway/client"

export type LensDateRange = {
  from: string
  to: string
  error?: Error
}

export function lensDateRange(from?: string, to?: string): LensDateRange {
  const now = dayjs()
  const start = from === undefined ? now.subtract(24, "hour") : dayjs(from)
  const end = to === undefined ? now : dayjs(to)
  if (!start.isValid() || !end.isValid()) {
    return {
      from: now.subtract(24, "hour").toISOString(),
      to: now.toISOString(),
      error: { code: "invalid_time_range", message: "Select a valid start and end date." },
    }
  }

  const invalid = !end.isAfter(start) || end.diff(start) > 30 * 24 * 60 * 60 * 1000
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    error: invalid
      ? {
          code: "invalid_time_range",
          message: "Select a time range of up to 30 days, with the start before the end.",
        }
      : undefined,
  }
}
