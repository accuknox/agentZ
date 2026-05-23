"use client"

import { cn } from "@/lib/utils"
import { motion } from "motion/react"
import type { CSSProperties } from "react"
import { memo, useMemo } from "react"

const MotionP = motion.p

export interface TextShimmerProps {
  children: string
  className?: string
  duration?: number
  spread?: number
}

const ShimmerComponent = ({ children, className, duration = 2, spread = 2 }: TextShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread])

  return (
    <MotionP
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-size-[250%_100%,auto] bg-clip-text text-transparent",
        "[background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "linear-gradient(90deg,transparent calc(50% - var(--spread)),var(--color-background),transparent calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionP>
  )
}

export const Shimmer = memo(ShimmerComponent)
