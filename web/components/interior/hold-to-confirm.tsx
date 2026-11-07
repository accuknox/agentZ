"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { LoadingButton } from "@/components/interior/loading-button"
import { cn } from "@/lib/utils"

type HoldPhase = "idle" | "holding" | "releasing" | "committed"

type UseHoldToConfirmOptions = {
  onConfirm: () => void
  duration?: number
  releaseRate?: number
  moveTolerance?: number
  disabled?: boolean
}

function useHoldToConfirm({
  onConfirm,
  duration = 1800,
  releaseRate = 2.5,
  moveTolerance = 10,
  disabled = false,
}: UseHoldToConfirmOptions) {
  const [phase, setPhase] = useState<HoldPhase>("idle")

  const phaseRef = useRef<HoldPhase>("idle")
  const down = useRef(false)
  const elapsed = useRef(0)
  const last = useRef(0)
  const raf = useRef(0)
  const origin = useRef<{ x: number; y: number } | null>(null)

  const blocked = useRef(disabled)
  const confirm = useRef(onConfirm)
  useLayoutEffect(() => {
    blocked.current = disabled
    confirm.current = onConfirm
  }, [disabled, onConfirm])

  const move = useCallback((next: HoldPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const reset = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    down.current = false
    elapsed.current = 0
    origin.current = null
    move("idle")
  }, [move])

  const begin = useCallback(
    (point?: { x: number; y: number }) => {
      if (disabled) return
      if (phaseRef.current === "committed" || phaseRef.current === "holding") {
        return
      }

      origin.current = point ?? null
      down.current = true
      move("holding")
      if (raf.current) return

      last.current = performance.now()

      const loop = (now: number) => {
        if (blocked.current) {
          reset()
          return
        }
        const dt = now - last.current
        last.current = now
        elapsed.current += down.current ? dt : -dt * releaseRate

        if (elapsed.current >= duration) {
          raf.current = 0
          elapsed.current = duration
          down.current = false
          origin.current = null
          move("committed")
          navigator.vibrate?.(14)
          confirm.current()
          return
        }

        if (elapsed.current <= 0) {
          raf.current = 0
          elapsed.current = 0
          origin.current = null
          move("idle")
          return
        }

        raf.current = requestAnimationFrame(loop)
      }

      raf.current = requestAnimationFrame(loop)
    },
    [disabled, duration, releaseRate, move, reset]
  )

  const release = useCallback(() => {
    if (phaseRef.current !== "holding") return
    down.current = false
    origin.current = null
    move("releasing")
  }, [move])

  useEffect(() => {
    const bail = () => release()
    const onVisibility = () => {
      if (document.hidden) release()
    }
    window.addEventListener("blur", bail)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("blur", bail)
      document.removeEventListener("visibilitychange", onVisibility)
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [release])

  const bind = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      e.currentTarget.setPointerCapture?.(e.pointerId)
      begin({ x: e.clientX, y: e.clientY })
    },
    onPointerMove: (e: React.PointerEvent) => {
      const from = origin.current
      if (phaseRef.current !== "holding" || !from) return
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > moveTolerance) {
        release()
      }
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phaseRef.current === "holding" || phaseRef.current === "releasing") {
          e.preventDefault()
          reset()
        }
        return
      }
      if (e.repeat || e.nativeEvent.isComposing) return
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        begin()
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") release()
    },
    onBlur: release,
    onClick: (e: React.MouseEvent) => {
      e.preventDefault()
      if (phaseRef.current === "committed") e.stopPropagation()
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }

  return {
    bind,
    phase,
    reset,
  }
}

export function HoldToConfirm({
  onConfirm,
  duration = 1800,
  pending,
  pendingLabel = "Deleting...",
  disabled,
  children,
  className,
  style,
  type = "button",
  "aria-describedby": describedBy,
  ...props
}: Omit<ComponentProps<typeof LoadingButton>, "onClick" | "ref" | "type"> & {
  duration?: number
} & ({ type: "submit"; onConfirm?: never } | { type?: "button"; onConfirm: () => void })) {
  const button = useRef<HTMLButtonElement>(null)
  const { bind, phase, reset } = useHoldToConfirm({
    duration,
    disabled: disabled || pending,
    onConfirm: () => {
      if (onConfirm) onConfirm()
      else if (type === "submit" && button.current)
        button.current.form?.requestSubmit(button.current)
    },
  })
  const hintId = useId()
  const reduced = useReducedMotion()
  const swept = useMotionValue(0)
  const clipPath = useTransform(swept, (value) => `inset(0 ${(1 - value) * 100}% 0 0)`)

  useEffect(() => {
    if (phase !== "committed") return
    const timer = setTimeout(reset, 1600)
    return () => clearTimeout(timer)
  }, [phase, reset])

  useEffect(() => {
    const filled = phase === "holding" || phase === "committed"
    if (reduced) {
      swept.set(filled ? 1 : 0)
      return
    }
    const from = swept.get()
    const seconds = duration / 1000
    const controls = animate(swept, filled ? 1 : 0, {
      duration:
        phase === "committed" ? 0.12 : filled ? seconds * (1 - from) : (seconds * from) / 2.5,
      ease: "linear",
    })
    return () => controls.stop()
  }, [phase, duration, reduced, swept])

  return (
    <>
      <LoadingButton
        {...props}
        {...bind}
        ref={button}
        type={type}
        pending={pending}
        pendingLabel={pendingLabel}
        disabled={disabled}
        aria-disabled={disabled || pending || phase === "committed" || undefined}
        aria-describedby={[describedBy, hintId].filter(Boolean).join(" ")}
        className={cn("relative isolate overflow-hidden", className)}
        style={{ touchAction: "manipulation", WebkitTouchCallout: "none", ...style }}
      >
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-1 bg-destructive/20"
          style={{ clipPath }}
        />
        {children}
      </LoadingButton>
      <span id={hintId} className="sr-only">
        Press and hold for {duration / 1000} seconds to confirm. Release early to cancel.
      </span>
    </>
  )
}
