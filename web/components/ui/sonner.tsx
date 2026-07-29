"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import type { CSSProperties } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"

const toasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--success-bg": "color-mix(in oklab, var(--chart-1) 12%, var(--popover))",
  "--success-text": "var(--foreground)",
  "--success-border": "color-mix(in oklab, var(--chart-1) 35%, var(--border))",
  "--info-bg": "color-mix(in oklab, var(--primary) 12%, var(--popover))",
  "--info-text": "var(--foreground)",
  "--info-border": "color-mix(in oklab, var(--primary) 35%, var(--border))",
  "--warning-bg": "color-mix(in oklab, var(--warning) 12%, var(--popover))",
  "--warning-text": "var(--foreground)",
  "--warning-border": "color-mix(in oklab, var(--warning) 35%, var(--border))",
  "--error-bg": "color-mix(in oklab, var(--destructive) 12%, var(--popover))",
  "--error-text": "var(--foreground)",
  "--error-border": "color-mix(in oklab, var(--destructive) 35%, var(--border))",
  "--border-radius": "var(--radius)",
} satisfies CSSProperties & Record<`--${string}`, string>

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="text-chart-1 size-4" />,
        info: <InfoIcon className="text-primary size-4" />,
        warning: <TriangleAlertIcon className="text-warning size-4" />,
        error: <OctagonXIcon className="text-destructive size-4" />,
        loading: <Loader2Icon className="text-muted-foreground size-4 animate-spin" />,
      }}
      richColors
      style={toasterStyle}
      {...props}
    />
  )
}

export { Toaster }
