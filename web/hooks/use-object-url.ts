"use client"

import { useEffect, useState } from "react"

type ObjectURL = {
  blob: Blob
  value: string
}

export function useObjectURL(blob: Blob | null | undefined) {
  const [url, setURL] = useState<ObjectURL>()

  useEffect(() => {
    if (!blob) {
      let active = true
      // Deferral lets Strict Mode invalidate a discarded effect before its URL
      // state becomes visible to an image or iframe.
      queueMicrotask(() => {
        if (active) setURL(undefined)
      })
      return () => {
        active = false
      }
    }

    let active = true
    const nextURL = URL.createObjectURL(blob)
    // The active guard prevents Strict Mode's discarded effect from exposing
    // an object URL that its cleanup has already revoked.
    queueMicrotask(() => {
      if (active) setURL({ blob, value: nextURL })
    })

    return () => {
      active = false
      URL.revokeObjectURL(nextURL)
    }
  }, [blob])

  if (!url || url.blob !== blob) return undefined
  return url.value
}
