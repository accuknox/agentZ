"use client"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/interior/progress-bar"
import { cn } from "@/lib/utils"
import type { LanguageModelUsage } from "ai"
import { useEffect, useRef, useState } from "react"

const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
})
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact" })
const circumference = 2 * Math.PI * 9.75

export function Context({
  usedTokens,
  maxTokens,
  usage,
}: {
  usedTokens: number
  maxTokens: number
  usage?: LanguageModelUsage
}) {
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverRef = useRef(false)
  const changeOpen = (next: boolean) => {
    clearTimeout(timerRef.current)
    setOpen(next)
  }
  const leave = () => {
    clearTimeout(timerRef.current)
    if (hoverRef.current) timerRef.current = setTimeout(() => changeOpen(false), 100)
  }
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const usedPercent = usedTokens / maxTokens
  const displayPct = percentFormatter.format(usedPercent)
  const progress = Math.max(0, Math.min(1, usedPercent))
  const rows = [
    ["Input", usage?.inputTokens],
    ["Output", usage?.outputTokens],
    ["Reasoning", usage?.reasoningTokens],
    ["Cache", usage?.cachedInputTokens],
  ] as const

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        asChild
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return
          clearTimeout(timerRef.current)
          if (open) return
          hoverRef.current = true
          timerRef.current = setTimeout(() => changeOpen(true), 150)
        }}
        onPointerLeave={leave}
        onPointerDown={() => {
          clearTimeout(timerRef.current)
          hoverRef.current = false
        }}
        onKeyDown={() => {
          clearTimeout(timerRef.current)
          hoverRef.current = false
        }}
      >
        <Button
          aria-label={`Context window ${displayPct} used`}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
        >
          <svg
            aria-hidden="true"
            className={cn("size-5", progress > 0.9 && "text-destructive")}
            height="20"
            viewBox="0 0 24 24"
            width="20"
          >
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.25"
              r="9.75"
              stroke="currentColor"
              strokeWidth="3"
            />
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.7"
              r="9.75"
              stroke="currentColor"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="round"
              strokeWidth="3"
              style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
              className="transition-[stroke-dashoffset] duration-150 ease-out motion-reduce:transition-none"
            />
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Context window"
        collisionPadding={16}
        align="end"
        side="top"
        sideOffset={8}
        className="w-64 max-w-[calc(100vw-2rem)] gap-0 divide-y overflow-hidden p-0"
        onPointerEnter={() => clearTimeout(timerRef.current)}
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          // Hover details must not steal the composer caret.
          if (hoverRef.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (hoverRef.current) event.preventDefault()
        }}
      >
        <div className="flex w-full flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <p className="font-medium">Context window</p>
            <p className="text-muted-foreground">{displayPct}</p>
          </div>
          <Progress className="bg-muted" value={usedPercent * 100} />
          <p className="font-mono text-xs text-muted-foreground">
            {compactFormatter.format(usedTokens)} / {compactFormatter.format(maxTokens)} tokens
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 p-3">
          {rows.map(([label, tokens]) =>
            tokens ? (
              <div key={label} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span>{compactFormatter.format(tokens)}</span>
              </div>
            ) : null
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
