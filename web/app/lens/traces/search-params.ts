import { dayjs } from "@/lib/dayjs"
export { firstSearchParam } from "@/lib/search-params"

export const defaultLimit = 25

export function parseLimitParam(value?: string) {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return defaultLimit
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

  return {
    from: yesterday.format("YYYY-MM-DD"),
    to: now.format("YYYY-MM-DD"),
    startedAfter: yesterday.toISOString(),
    startedBefore: now.toISOString(),
  }
}

function parseDateParam(value?: string) {
  const date = dayjs(value, "YYYY-MM-DD", true)
  return date.isValid() ? date : undefined
}
