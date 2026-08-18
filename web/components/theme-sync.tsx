"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import type { ThemePreference } from "@/data/user-preferences"

/** ThemeSync applies the signed-in user's saved theme inside the app shell. */
export function ThemeSync({ theme }: { theme: ThemePreference }): null {
  const { setTheme } = useTheme()
  const synced = React.useRef(false)

  React.useEffect(() => {
    if (synced.current) {
      return
    }

    synced.current = true
    setTheme(theme)
  }, [setTheme, theme])

  return null
}
