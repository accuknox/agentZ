import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  [
    "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 text-left text-sm leading-5 wrap-anywhere has-data-[slot=alert-action]:grid-cols-[auto_minmax(0,1fr)_auto]",
    "[&>svg]:col-start-1 [&>svg]:row-span-2 [&>svg]:row-start-1 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-current",
    "[&>:not(svg)]:min-w-0 [&>:not(svg,[data-slot=alert-action])]:col-start-2 [&>[data-slot=button]]:justify-self-start",
    "[&_[data-slot=button]:not([data-size^=icon])]:h-auto [&_[data-slot=button]:not([data-size^=icon])]:min-h-7 [&_[data-slot=button]:not([data-size^=icon])]:max-w-full [&_[data-slot=button]:not([data-size^=icon])]:min-w-0 [&_[data-slot=button]:not([data-size^=icon])]:whitespace-normal",
  ],
  {
    variants: {
      variant: {
        default: "text-foreground",
        destructive: "text-destructive",
        warning: "text-warning-foreground",
        info: "text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium [&_a]:underline [&_a]:underline-offset-3", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "[&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-2",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-3 row-span-2 row-start-1", className)}
      {...props}
    />
  )
}

export { Alert, AlertAction, AlertDescription, AlertTitle }
