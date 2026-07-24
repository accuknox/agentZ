"use client"

import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { Button } from "@/components/ui/button"

type CopyButtonProps = {
  content: string
  label?: string
}

export function CopyButton({ content, label }: CopyButtonProps) {
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: content,
  })

  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "default" : "icon"}
      className={cn("relative", !label && "h-6 w-6")}
      aria-label="Copy to clipboard"
      onClick={handleCopy}
    >
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        <Check
          className={cn(
            "absolute h-4 w-4 transition-transform ease-in-out",
            isCopied ? "scale-100" : "scale-0"
          )}
        />
        <Copy
          className={cn(
            "h-4 w-4 transition-transform ease-in-out",
            isCopied ? "scale-0" : "scale-100"
          )}
        />
      </span>
      {label ? <span>{label}</span> : null}
    </Button>
  )
}
