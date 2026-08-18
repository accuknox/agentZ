import { dayjs } from "@/lib/format"

export type LensDateRange = {
  after: string
  before: string
  from: string
  to: string
}

export function lensDateRange(from?: string, to?: string): LensDateRange {
  const parsedFrom = parseDateParam(from)
  const parsedTo = parseDateParam(to)
  if (parsedFrom && parsedTo) {
    return {
      after: parsedFrom.startOf("day").toISOString(),
      before: parsedTo.endOf("day").toISOString(),
      from: parsedFrom.format("YYYY-MM-DD"),
      to: parsedTo.format("YYYY-MM-DD"),
    }
  }

  const now = dayjs()
  const defaultFrom = now.subtract(24, "hour").startOf("day")
  const defaultTo = now.endOf("day")
  return {
    after: defaultFrom.toISOString(),
    before: defaultTo.toISOString(),
    from: defaultFrom.format("YYYY-MM-DD"),
    to: defaultTo.format("YYYY-MM-DD"),
  }
}

function parseDateParam(value?: string) {
  const date = dayjs(value, "YYYY-MM-DD", true)
  return date.isValid() ? date : undefined
}
