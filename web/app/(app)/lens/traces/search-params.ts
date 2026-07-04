import { dayjs } from "@/lib/format"

const defaultTraceLimit = 25

export function parseLimitParam(value?: string) {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return defaultTraceLimit
  }

  return limit
}

export type TraceDateRange = {
  from: string
  to: string
  startedAfter: string
  startedBefore: string
}

export function traceDateRange(from?: string, to?: string): TraceDateRange {
  const parsedFrom = parseDateParam(from)
  const parsedTo = parseDateParam(to)
  if (parsedFrom && parsedTo) {
    return {
      from: parsedFrom.format("YYYY-MM-DD"),
      to: parsedTo.format("YYYY-MM-DD"),
      startedAfter: parsedFrom.startOf("day").toISOString(),
      startedBefore: parsedTo.endOf("day").toISOString(),
    }
  }

  const now = dayjs()
  const yesterday = now.subtract(24, "hour")
  const defaultFrom = yesterday.startOf("day")
  const defaultTo = now.endOf("day")

  return {
    from: defaultFrom.format("YYYY-MM-DD"),
    to: defaultTo.format("YYYY-MM-DD"),
    startedAfter: defaultFrom.toISOString(),
    startedBefore: defaultTo.toISOString(),
  }
}

function parseDateParam(value?: string) {
  const date = dayjs(value, "YYYY-MM-DD", true)
  return date.isValid() ? date : undefined
}
