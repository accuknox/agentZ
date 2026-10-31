import { cn } from "@/lib/utils"

export function Shimmer({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("activity-shimmer", className)} title={children}>
      {children}
    </span>
  )
}
