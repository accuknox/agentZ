import dayjs from "dayjs"
import advancedFormat from "dayjs/plugin/advancedFormat"
import customParseFormat from "dayjs/plugin/customParseFormat"
import duration from "dayjs/plugin/duration"
import relativeTime from "dayjs/plugin/relativeTime"

dayjs.extend(advancedFormat)
dayjs.extend(customParseFormat)
dayjs.extend(duration)
dayjs.extend(relativeTime)

export { dayjs }

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
})

/** formatCompactNumber keeps counts and token displays consistent. */
export function formatCompactNumber(value: number) {
  return compactNumberFormatter.format(value)
}

/** formatByteSize keeps attachment limits readable with shared units. */
export function formatByteSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** formatTimestamp renders the shared absolute date and time display. */
export function formatTimestamp(value: Date | string) {
  const date = dayjs(value)
  if (!date.isValid()) {
    return "_"
  }

  return dateTimeFormatter.format(date.toDate())
}

/** formatTimestampWithAge renders an absolute timestamp with relative age. */
export function formatTimestampWithAge(value: Date | string | null | undefined) {
  if (!value) {
    return "_"
  }

  const date = dayjs(value)
  if (!date.isValid()) {
    return "_"
  }

  return `${dateTimeFormatter.format(date.toDate())} (${date.fromNow()})`
}

/** formatAge renders relative time labels for table age columns. */
export function formatAge(value: Date | string | null | undefined) {
  if (!value) {
    return "_"
  }

  const date = dayjs(value)
  if (!date.isValid()) {
    return "_"
  }

  return date.fromNow()
}

/**
 * formatRecentTimestamp keeps dense lens views readable by showing recent
 * timestamps relatively and older timestamps absolutely.
 */
export function formatRecentTimestamp(
  value: Date | string,
  absoluteFormat = "MMM D, YYYY, h:mm A"
) {
  const date = dayjs(value)
  if (!date.isValid()) {
    return String(value)
  }

  if (dayjs().diff(date, "hour", true) < 48) {
    return date.fromNow()
  }

  return date.format(absoluteFormat)
}

/** formatShortAge compresses age labels for narrow sidebar cells. */
export function formatShortAge(value: number) {
  const time = dayjs(value)
  const now = dayjs()
  const minute = now.diff(time, "minute")
  if (minute < 1) return "now"
  if (minute < 60) return `${minute}m`

  const hour = now.diff(time, "hour")
  if (hour < 24) return `${hour}h`

  const day = now.diff(time, "day")
  if (day < 7) return `${day}d`

  const week = now.diff(time, "week")
  if (week < 5) return `${week}w`

  const month = now.diff(time, "month")
  if (month < 12) return `${month}mo`

  return `${now.diff(time, "year")}y`
}

/**
 * formatMessageTime renders chat message times: clock time only for today,
 * otherwise a full "Monday, 5th July 14:30" style label.
 */
export function formatMessageTime(value: number) {
  const date = dayjs(value)
  if (!date.isValid()) {
    return ""
  }

  if (date.isSame(dayjs(), "day")) {
    return date.format("HH:mm")
  }

  return date.format("dddd, Do MMMM HH:mm")
}

/** formatDurationMs renders telemetry durations in milliseconds or seconds. */
export function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`
  }

  return `${dayjs.duration(durationMs).asSeconds().toFixed(2)} s`
}

/** formatDurationSeconds renders workflow run durations in compact units. */
export function formatDurationSeconds(durationSeconds: number) {
  const hours = Math.floor(durationSeconds / 3600)
  const minutes = Math.floor((durationSeconds % 3600) / 60)
  const seconds = durationSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }

  return `${seconds}s`
}

/** formatDateParam keeps route date params aligned with the shared parser. */
export function formatDateParam(date: Date) {
  return dayjs(date).format("YYYY-MM-DD")
}
