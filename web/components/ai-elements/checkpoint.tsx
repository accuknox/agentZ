import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { LucideProps } from "lucide-react"
import { BookmarkIcon } from "lucide-react"
import type { HTMLAttributes } from "react"

export type CheckpointProps = HTMLAttributes<HTMLDivElement>

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <div
    className={cn("text-muted-foreground flex items-center gap-0.5 overflow-hidden", className)}
    {...props}
  >
    {children}
    <Separator />
  </div>
)

export type CheckpointIconProps = LucideProps

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) =>
  children ?? <BookmarkIcon className={cn("size-4 shrink-0", className)} {...props} />
