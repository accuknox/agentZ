"use client"

import { motion } from "motion/react"
import type { HTMLAttributes } from "react"

interface BotIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

/**
 * BotIcon shows the agent identity with a subtle animated face.
 *
 * The component keeps the animation client-side so server-rendered pages can
 * import it without making the surrounding page interactive.
 */
export function BotIcon({ className, size = 28, ...props }: BotIconProps) {
  return (
    <div className={className} {...props}>
      <svg
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M12 8V4H8" />
        <rect height="12" rx="2" width="16" x="4" y="8" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />

        <motion.line
          animate="animate"
          initial="normal"
          variants={{
            normal: { y1: 13, y2: 15 },
            animate: {
              y1: [13, 14, 13],
              y2: [15, 14, 15],
              transition: {
                duration: 1.8,
                ease: "easeInOut",
                repeat: Infinity,
                repeatDelay: 1.2,
              },
            },
          }}
          x1={15}
          x2={15}
        />

        <motion.line
          animate="animate"
          initial="normal"
          variants={{
            normal: { y1: 13, y2: 15 },
            animate: {
              y1: [13, 14, 13],
              y2: [15, 14, 15],
              transition: {
                duration: 1.8,
                ease: "easeInOut",
                repeat: Infinity,
                repeatDelay: 1.2,
              },
            },
          }}
          x1={9}
          x2={9}
        />
      </svg>
    </div>
  )
}
