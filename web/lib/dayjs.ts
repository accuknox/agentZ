import dayjs from "dayjs"
import customParseFormat from "dayjs/plugin/customParseFormat"
import duration from "dayjs/plugin/duration"

dayjs.extend(customParseFormat)
dayjs.extend(duration)

export { dayjs }
