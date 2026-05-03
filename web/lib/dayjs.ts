import dayjs from "dayjs"
import customParseFormat from "dayjs/plugin/customParseFormat"
import duration from "dayjs/plugin/duration"
import relativeTime from "dayjs/plugin/relativeTime"

dayjs.extend(customParseFormat)
dayjs.extend(duration)
dayjs.extend(relativeTime)

export { dayjs }
