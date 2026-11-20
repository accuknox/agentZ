type Size = { width: number; height: number }
type BrowserFrame = Size & { left: number; top: number }
export type BrowserWindowRequest = Omit<BrowserFrame, "height"> & {
  anchorRight?: number
  anchorBottom?: number
}
const PREFERRED_CHAT_WIDTH = 640
const MIN_CHAT_WIDTH = 360

export function browserWindowLayout(
  area: BrowserFrame,
  page: Size,
  requested?: BrowserWindowRequest
) {
  const gap = 8
  const aspect = page.width / page.height
  const defaultScale = 320 / Math.max(page.width, page.height)
  const defaultWidth = page.width * defaultScale
  const minSideWidth = Math.min(240, defaultWidth)
  const availableWidth = area.width - 2 * gap
  const beside = availableWidth >= PREFERRED_CHAT_WIDTH + minSideWidth

  const minTop = area.top + gap + (beside ? 0 : area.height / 2)
  const right = area.left + area.width - gap
  const bottom = area.top + area.height - gap
  const maxWidth = Math.max(
    1,
    Math.min(availableWidth - (beside ? MIN_CHAT_WIDTH : 0), (bottom - minTop) * aspect)
  )
  const width = Math.min(maxWidth, Math.max(minSideWidth, requested?.width ?? defaultWidth))
  const height = width / aspect
  // Yield width gradually during resize without switching the chat to a different axis.
  const chatWidth = beside ? Math.min(PREFERRED_CHAT_WIDTH, availableWidth - width) : 0
  const minLeft = area.left + gap + chatWidth
  const maxLeft = right - width
  const maxTop = bottom - height
  const defaultLeft = beside ? maxLeft : area.left + (area.width - width) / 2
  const requestedLeft =
    requested?.anchorRight === undefined ? requested?.left : requested.anchorRight - width
  const requestedTop =
    requested?.anchorBottom === undefined ? requested?.top : requested.anchorBottom - height
  const left = Math.max(minLeft, Math.min(requestedLeft ?? defaultLeft, maxLeft))
  const top = Math.max(minTop, Math.min(requestedTop ?? maxTop, maxTop))
  return {
    left,
    top,
    width,
    height,
    insetRight: beside ? area.left + area.width - left + gap : 0,
    insetBottom: beside ? 0 : area.top + area.height - top + gap,
  }
}

export function resizeBrowserWindow(
  frame: BrowserFrame,
  x: number,
  y: number,
  dx: number,
  dy: number
): BrowserWindowRequest {
  const aspect = frame.width / frame.height
  // Use both axes at corners so reversing one axis does not jump the size.
  const dw = (x * dx + (y * dy) / aspect) / (x * x + (y / aspect) ** 2)
  const width = Math.max(1, frame.width + dw)
  return {
    left: frame.left,
    top: frame.top,
    anchorRight: x < 0 ? frame.left + frame.width : undefined,
    anchorBottom: y < 0 ? frame.top + frame.height : undefined,
    width,
  }
}
