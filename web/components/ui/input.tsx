"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

import { cn } from "@/lib/utils"

const inputClassName =
  "border-input file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input(
  { className, disabled, type, ...props },
  ref
) {
  const [revealed, setRevealed] = React.useState(false)

  if (type !== "password") {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(inputClassName, className)}
        disabled={disabled}
        {...props}
      />
    )
  }

  return (
    <div className="relative">
      <input
        ref={ref}
        type={revealed ? "text" : "password"}
        data-slot="input"
        className={cn(inputClassName, "pr-9", className)}
        disabled={disabled}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
        disabled={disabled}
        className="text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 hover:text-foreground absolute top-1/2 right-0 flex size-8 -translate-y-1/2 items-center justify-center rounded-r-lg transition-colors outline-none focus-visible:ring-3 disabled:pointer-events-none"
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        onClick={() => {
          setRevealed((value) => !value)
        }}
      >
        {revealed ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  )
})

Input.displayName = "Input"

export { Input }
