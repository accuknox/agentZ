import { useCallback, useRef, useState } from "react"

type UseCopyToClipboardProps = {
  text: string
}

export function useCopyToClipboard({ text }: UseCopyToClipboardProps) {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setIsCopied(true)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        timeoutRef.current = setTimeout(() => {
          setIsCopied(false)
        }, 2000)
      })
      .catch(() => {
        setIsCopied(false)
      })
  }, [text])

  return { isCopied, handleCopy }
}
