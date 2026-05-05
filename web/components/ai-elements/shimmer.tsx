"use client"

import { cn } from "@/lib/utils"
import { motion } from "motion/react"
import { memo } from "react"

export interface TextShimmerProps {
  children: string
  active?: boolean
  className?: string
  duration?: number
}

const snakeLength = 5

const ShimmerComponent = ({
  children,
  active = true,
  className,
  duration = 1,
}: TextShimmerProps) => {
  if (!active) {
    return <span className={className}>{children}</span>
  }

  const text = children ?? ""
  const charCount = text.length

  return (
    <span
      className={cn("relative inline-block leading-none", className)}
      style={{ width: `${charCount}ch` }}
    >
      <span className="text-[0.65em] text-muted-foreground/25">{text}</span>

      {Array.from({ length: snakeLength }).map((_, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-[0.6em] w-[0.6em] -translate-y-1/2 rounded-[2px] bg-current"
          initial={{ left: "0ch" }}
          animate={{
            left: ["0ch", `${charCount - 1}ch`],
          }}
          transition={{
            duration: duration / 2,
            ease: "easeInOut",
            repeat: Infinity,
            repeatType: "reverse",
            delay: i * 0.08,
          }}
          style={{
            opacity: 1 - i * 0.18,
          }}
        />
      ))}
    </span>
  )
}

export const Shimmer = memo(ShimmerComponent)
