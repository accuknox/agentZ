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
  "--toast-close-button-start": "auto",
  "--toast-close-button-end": "0",
  "--toast-close-button-transform": "translate(35%, -35%)",
} satisfies CSSProperties & Record<`--${string}`, string>

const Toaster = (props: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-chart-1" />,
        info: <InfoIcon className="size-4 text-primary" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin text-muted-foreground" />,
      }}
      richColors
      closeButton
      style={toasterStyle}
      {...props}
    />
  )
}

export { Toaster }
