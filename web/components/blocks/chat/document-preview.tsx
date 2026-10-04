"use client"

import * as React from "react"
import { renderAsync } from "docx-preview"
import { CircleAlert } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function DocumentPreview({ file }: { file: Blob }): React.JSX.Element {
  const container = React.useRef<HTMLDivElement>(null)
  const [status, setStatus] = React.useState<"error" | "loading" | "ready">("loading")

  React.useEffect(() => {
    const node = container.current
    if (!node) return

    let active = true
    void renderAsync(file, node, undefined, {
      renderAltChunks: false,
      renderComments: false,
      useBase64URL: true,
    })
      .then(() => {
        if (!active) return
        for (const link of node.querySelectorAll("a")) {
          link.removeAttribute("href")
        }
        setStatus("ready")
      })
      .catch(() => {
        if (!active) return
        node.replaceChildren()
        setStatus("error")
      })

    return () => {
      active = false
      node.replaceChildren()
    }
  }, [file])

  return (
    <div className="relative h-full overflow-auto bg-muted/40">
      <div ref={container} className="[&_.docx-wrapper]:min-h-full [&_.docx-wrapper]:p-6" />
      {status === "loading" ? (
        <div
          aria-live="polite"
          className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/80 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner /> Rendering document...
        </div>
      ) : null}
      {status === "error" ? (
        <Alert variant="destructive" className="p-6">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>This document could not be rendered</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
