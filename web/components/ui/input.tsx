"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

import { cn } from "@/lib/utils"

const inputClassName =
  "form-control file:text-foreground placeholder:text-muted-foreground h-8 w-full min-w-0 rounded-lg border px-2.5 py-1 text-base outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"

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
        aria-label={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
        disabled={disabled}
        className="absolute top-1/2 right-0 flex size-8 -translate-y-1/2 items-center justify-center rounded-r-lg text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/20 disabled:pointer-events-none"
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
