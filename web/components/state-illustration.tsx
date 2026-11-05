import type { ReactNode } from "react"
import { CircleAlert, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** StateIllustration shares the decorative frame across status and invitation artwork. */
export function StateIllustration({
  icon: Icon = CircleAlert,
  badge = "!",
  children,
  className,
}: {
  icon?: LucideIcon
  badge?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("relative mb-2 grid h-32 w-40 shrink-0 place-items-center", className)}
    >
      <div className="absolute inset-x-4 inset-y-3 -rotate-6 rounded-3xl bg-warning/10" />
      <div className="absolute right-3 bottom-3 h-14 w-14 rotate-12 rounded-2xl bg-primary/5" />
      {children ?? (
        <div className="relative grid size-20 rotate-6 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border">
          <Icon className="size-10 stroke-[1.5] text-muted-foreground" />
        </div>
      )}
      <span className="absolute top-1 right-5 grid size-7 rotate-12 place-items-center rounded-full bg-warning/20 text-lg font-medium text-warning-foreground">
        {badge}
      </span>
      <span className="absolute bottom-1 left-5 size-2 rounded-full bg-primary/20" />
    </div>
  )
}
