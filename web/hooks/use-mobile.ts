import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribeToMobileQuery(onChange: () => void): () => void {
  const mediaQueryList = window.matchMedia(MOBILE_QUERY)
  const listener = () => onChange()

  mediaQueryList.addEventListener("change", listener)
  return () => mediaQueryList.removeEventListener("change", listener)
}

function getMobileSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

function getServerMobileSnapshot(): boolean {
  return false
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribeToMobileQuery,
    getMobileSnapshot,
    getServerMobileSnapshot
  )
}
