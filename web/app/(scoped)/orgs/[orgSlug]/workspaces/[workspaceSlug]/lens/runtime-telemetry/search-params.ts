import { dayjs } from "@/lib/format"

export type TelemetryDateRange = {
  from: string
  to: string
  eventTimeAfter: string
  eventTimeBefore: string
}

export function telemetryDateRange(from?: string, to?: string): TelemetryDateRange {
  const parsedFrom = parseDateParam(from)
  const parsedTo = parseDateParam(to)
  if (parsedFrom && parsedTo) {
    return {
      from: parsedFrom.format("YYYY-MM-DD"),
      to: parsedTo.format("YYYY-MM-DD"),
      eventTimeAfter: parsedFrom.startOf("day").toISOString(),
      eventTimeBefore: parsedTo.endOf("day").toISOString(),
    }
  }

  const now = dayjs()
  const yesterday = now.subtract(24, "hour")
  const defaultFrom = yesterday.startOf("day")
  const defaultTo = now.endOf("day")

  return {
    from: defaultFrom.format("YYYY-MM-DD"),
    to: defaultTo.format("YYYY-MM-DD"),
    eventTimeAfter: defaultFrom.toISOString(),
    eventTimeBefore: defaultTo.toISOString(),
  }
}

function parseDateParam(value?: string) {
  const date = dayjs(value, "YYYY-MM-DD", true)
  return date.isValid() ? date : undefined
}
