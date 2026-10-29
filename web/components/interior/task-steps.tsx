"use client"

import type { Todo } from "@opencode-ai/sdk/v2"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

export function TaskSteps({ todos }: { todos: Todo[] }) {
  const reduced = useReducedMotion()
  return (
    <div className="mt-1 flex flex-col gap-1">
      {todos.map((todo, index) => {
        const terminal = todo.status === "completed" || todo.status === "cancelled"
        return (
          <motion.div
            className="flex items-start gap-2 text-sm"
            key={`${todo.content}-${index}`}
            layout={reduced ? false : "position"}
            transition={
              reduced
                ? { duration: 0 }
                : { type: "spring", stiffness: 520, damping: 34, mass: 0.45 }
            }
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-2.5 shrink-0 rounded-full border",
                terminal
                  ? "border-primary bg-primary"
                  : todo.status === "in_progress"
                    ? "border-primary motion-safe:animate-pulse"
                    : "border-muted-foreground"
              )}
            />
            <span
              className={cn(
                "min-w-0 wrap-break-word text-foreground",
                terminal && "text-muted-foreground line-through"
              )}
            >
              {todo.content}
            </span>
          </motion.div>
        )
      })}
    </div>
  )
}
