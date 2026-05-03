"use client"

import { cn } from "@/lib/utils"
import { motion } from "motion/react"
import type { CSSProperties } from "react"
import { memo, useMemo } from "react"

export interface TextShimmerProps {
  children: string
  active?: boolean
  className?: string
  duration?: number
  spread?: number
}

const ShimmerComponent = ({
  children,
  active = true,
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread])

  return (
    <motion.span
      animate={{ backgroundPosition: active ? "0% center" : "100% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: active ? Number.POSITIVE_INFINITY : 0,
      }}
    >
      {children}
    </motion.span>
  )
}

export const Shimmer = memo(ShimmerComponent)
