function isScrollable(element: HTMLElement) {
  const style = window.getComputedStyle(element)

  return (
    /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflowX}`) &&
    (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
  )
}

/**
 * driver.js only scrolls a target that sits outside the window viewport, so a
 * nav item hidden inside the scrolling sidebar keeps its original coordinates
 * and the highlight lands on empty space. Centre the target inside every
 * scrollable ancestor first.
 */
export function scrollAncestorsIntoView(element: HTMLElement) {
  let parent = element.parentElement

  while (parent !== null && parent !== document.body) {
    if (isScrollable(parent)) {
      const container = parent.getBoundingClientRect()
      const target = element.getBoundingClientRect()
      parent.scrollTop += target.top + target.height / 2 - (container.top + container.height / 2)
    }
    parent = parent.parentElement
  }
}

/** Elements that are in the DOM but not rendered cannot be highlighted. */
export function isVisible(selector: string) {
  const element = document.querySelector(selector)

  return element instanceof HTMLElement && element.getClientRects().length > 0
}
