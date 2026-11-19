type Frame = { left: number; top: number; width: number; height: number }

const GAP = 12

/** Keep the floating preview in the chat area and above an overlapping composer. */
export function browserWindowLayout(area: Frame, requested: Frame, composer?: Frame) {
  const maxWidth = Math.max(1, area.width - GAP * 2)
  const minWidth = Math.min(240, maxWidth)
  const width = Math.max(minWidth, Math.min(requested.width, maxWidth))
  const left = Math.max(
    area.left + GAP,
    Math.min(requested.left, area.left + area.width - width - GAP)
  )
  const crossesComposer =
    composer &&
    composer.width > 0 &&
    left < composer.left + composer.width + GAP &&
    left + width + GAP > composer.left
  const ceiling = area.top + GAP
  const floor = crossesComposer
    ? Math.min(composer.top, area.top + area.height) - GAP
    : area.top + area.height - GAP
  const maxHeight = Math.max(1, floor - ceiling)
  const minHeight = Math.min(150, maxHeight)
  const height = Math.max(minHeight, Math.min(requested.height, maxHeight))
  const top = Math.max(ceiling, Math.min(requested.top, floor - height))
  return { left, top, width, height, minWidth, minHeight }
}
