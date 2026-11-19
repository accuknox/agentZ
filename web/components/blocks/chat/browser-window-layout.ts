type Frame = { left: number; top: number; width: number; height: number }

const GAP = 12
const MIN_CHAT_WIDTH = 320
const MIN_PREVIEW_WIDTH = 240

/** Keep the preview beside the working area, or below it on narrow screens. */
export function browserWindowLayout(area: Frame, requested: Frame) {
  const beside = area.width >= MIN_CHAT_WIDTH + MIN_PREVIEW_WIDTH + GAP * 2
  const maxWidth = beside ? area.width - MIN_CHAT_WIDTH - GAP * 2 : area.width - GAP * 2
  const maxHeight = beside ? area.height - 76 : Math.min(320, area.height / 2 - GAP * 2)
  const minWidth = Math.max(1, Math.min(MIN_PREVIEW_WIDTH, maxWidth))
  const minHeight = Math.max(1, Math.min(150, maxHeight))
  const width = Math.max(minWidth, Math.min(requested.width, maxWidth))
  const height = Math.max(minHeight, Math.min(requested.height, maxHeight))
  const left = Math.max(
    area.left + (beside ? MIN_CHAT_WIDTH + GAP : GAP),
    Math.min(requested.left, area.left + area.width - width - GAP)
  )
  const top = Math.max(
    area.top + (beside ? 56 : area.height / 2),
    Math.min(requested.top, area.top + area.height - height - GAP)
  )
  return {
    left,
    top,
    width,
    height,
    minWidth,
    minHeight,
    insetRight: beside ? area.left + area.width - left + GAP : 0,
    insetBottom: beside ? 0 : area.top + area.height - top + GAP,
  }
}
