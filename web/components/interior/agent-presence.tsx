"use client"

import { createContext, useContext, useLayoutEffect, useRef } from "react"
import type { AgentAppearance } from "@/lib/gateway/client"
import { defaultAgentAppearance, mascotNames, mascots, mascotColors } from "@/data/mascots"
import { Skeleton } from "@/components/ui/skeleton"
import styles from "./agent-presence.module.css"

export const AgentAppearanceContext = createContext<AgentAppearance | null>(defaultAgentAppearance)

type PresenceProps = {
  state?: "idle" | "thinking" | "working" | "waiting"
  size: number
  mascot?: AgentAppearance["breed"]
  color?: AgentAppearance["color"]
}

const targets = new Map<Element, boolean>()
let observer: IntersectionObserver | undefined

type Pose = readonly [
  offset: number,
  x?: number,
  y?: number,
  rotation?: number,
  sx?: number,
  sy?: number,
]

function updateVisibility() {
  for (const [target, visible] of targets) {
    const running = visible && !document.hidden
    target.setAttribute("data-running", String(running))
    for (const animation of target.getAnimations({ subtree: true })) {
      if (running) animation.play()
      else animation.pause()
    }
  }
}

// AgentPresence reserves the mascot's space until its shared appearance arrives.
export function AgentPresence({
  state = "idle",
  size,
  mascot: selectedMascot,
  color: selectedColor,
}: PresenceProps) {
  const appearance = useContext(AgentAppearanceContext)
  if (appearance === null && selectedMascot === undefined) {
    return (
      <Skeleton
        aria-hidden="true"
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
      />
    )
  }
  const identity = appearance ?? defaultAgentAppearance
  return (
    <Mascot
      state={state}
      size={size}
      mascot={selectedMascot ?? identity.breed}
      color={selectedColor ?? identity.color}
    />
  )
}

// Mascot uses native animation; one observer pauses hidden instances.
function Mascot({ state, size, mascot, color }: Required<PresenceProps>) {
  const character = mascots[mascot]
  const palette = mascotColors[color]
  const [x, y, x2, y2] = character.eyes
  const ref = useRef<HTMLSpanElement>(null)
  const motionAllowed = useRef(false)

  // Cancel animations before detachment, when getAnimations still finds them.
  useLayoutEffect(() => {
    const target = ref.current
    if (!target) return
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (targets.has(entry.target)) targets.set(entry.target, entry.isIntersecting)
        }
        updateVisibility()
      })
      document.addEventListener("visibilitychange", updateVisibility)
    }
    targets.set(target, false)
    observer.observe(target)
    return () => {
      for (const animation of target.getAnimations({ subtree: true })) animation.cancel()
      observer?.unobserve(target)
      targets.delete(target)
      if (targets.size !== 0) return
      observer?.disconnect()
      observer = undefined
      document.removeEventListener("visibilitychange", updateVisibility)
    }
  }, [])

  useLayoutEffect(() => {
    const target = ref.current
    if (!target) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const body = target.querySelector("[data-part=body]")
    const face = target.querySelector("[data-part=face]")
    const seed = mascotNames.indexOf(mascot)
    const k = size < 48 ? 0.7 : 1
    const lag = -seed * 110

    const start = () => {
      const previous = target.getAnimations({ subtree: true })
      const from = previous.length
        ? [body && getComputedStyle(body).transform, face && getComputedStyle(face).transform]
        : undefined
      for (const animation of previous) animation.cancel()
      motionAllowed.current = !media.matches
      if (!motionAllowed.current) return

      const animate = (
        element: Element | null,
        frames: Keyframe[],
        duration: number,
        delay = lag
      ) => {
        if (!element) return
        const animation = element.animate(frames, {
          duration,
          delay,
          iterations: Infinity,
          easing: "linear",
          fill: "both",
        })
        animation.pause()
      }
      const track = (
        element: Element | null,
        poses: readonly Pose[],
        duration = character.period
      ) => {
        const frames = poses.map(([offset, dx = 0, dy = 0, rotation = 0, sx = 1, sy = 1]) => ({
          offset,
          transform: `translate(${dx * k}px,${dy * k}px) rotate(${rotation * k}deg) scale(${1 + (sx - 1) * k},${1 + (sy - 1) * k})`,
          easing: "cubic-bezier(.22,.75,.22,1)",
        }))
        animate(element, frames, duration)
      }
      animate(
        target.querySelector("[data-part=eyelid]"),
        [
          { transform: "scaleY(1)", offset: 0 },
          { transform: "scaleY(1)", offset: 0.55 },
          { transform: "scaleY(.1)", offset: 0.565 },
          { transform: "scaleY(1)", offset: 0.585 },
          { transform: "scaleY(1)", offset: 1 },
        ],
        3900 + seed * 270,
        -seed * 320
      )

      if (state === "thinking") {
        const period = 2350 + seed * 90
        track(
          face,
          [
            [0],
            [0.055, 1.5, -1.5],
            [0.26, 1.5, -1.5],
            [0.32, -0.8, -1],
            [0.53, -0.8, -1],
            [0.6],
            [1],
          ],
          period
        )
        track(
          body,
          [
            [0],
            [0.035],
            [0.12, 0, -0.4, -5, 1.01, 0.99],
            [0.3, 0, -0.4, -5, 1.01, 0.99],
            [0.38, 0, 0, 2],
            [0.55, 0, 0, 2],
            [0.64],
            [1],
          ],
          period
        )
        animate(
          target.querySelector("[data-part=near]"),
          [
            { transform: "scaleY(1)", offset: 0 },
            { transform: "scaleY(.84)", offset: 0.06 },
            { transform: "scaleY(.84)", offset: 0.26 },
            { transform: "scaleY(1)", offset: 0.34 },
            { transform: "scaleY(1)", offset: 1 },
          ],
          period
        )
      }
      if (state === "working") {
        switch (mascot) {
          case "mochi":
            track(body, [
              [0],
              [0.07, 0, 1, -1, 1.045, 0.94],
              [0.2, 0, -1.7, 2, 0.975, 1.04],
              [0.3, 0, 0.3, -0.6, 1.01, 0.99],
              [0.38],
              [1],
            ])
            track(face, [[0], [0.08, 0.5, -0.7], [0.2, 0.7, -1.2], [0.36], [1]])
            break
          case "ziglet":
            track(body, [
              [0],
              [0.07, -0.4, 0.8, -3, 1.02, 0.97],
              [0.22, 1.8, -0.8, 5, 0.99, 1.02],
              [0.33, -0.3, 0, -1],
              [0.43],
              [1],
            ])
            track(face, [[0], [0.07, 1.5], [0.22, 1.5, -0.5], [0.4], [1]])
            break
          case "slinky":
            track(body, [
              [0],
              [0.086, 0, 0, 0, 1.035, 0.9],
              [0.194, 0, 0, 0, 0.98, 1.045],
              [0.313, 0, 0, 0, 1.007, 0.987],
              [0.39],
              [1],
            ])
            track(face, [[0], [0.1, 0, -0.4], [0.21, 0.4, -1], [0.35], [1]])
            break
          case "pip":
            track(face, [
              [0],
              [0.06, -1.6, -0.5],
              [0.18, -1.6, -0.5],
              [0.29, 0.3, 0.7],
              [0.39],
              [1],
            ])
            track(body, [
              [0],
              [0.07, 0, 0.8, 1.5, 1.025, 0.97],
              [0.17, -0.8, -0.6, -4, 0.99, 1.02],
              [0.26, 0, 0.6, 2, 1.015, 0.98],
              [0.35, 0, -0.2, -0.7],
              [0.43],
              [1],
            ])
            break
          case "pi":
            track(body, [
              [0],
              [0.065, 0, 0.9, -1.5, 1.025, 0.97],
              [0.18, 0.5, -0.9, 3, 0.985, 1.025],
              [0.29, -0.2, 0.2, -1, 1.01, 0.99],
              [0.39],
              [1],
            ])
            track(face, [[0], [0.06, 0.8, -0.5], [0.18, 1.3, -0.7], [0.36], [1]])
            break
          case "mallow":
            track(face, [[0], [0.07, 1.6, -0.6], [0.2, 1.6, -0.6], [0.36], [1]])
            track(body, [[0], [0.05], [0.16, 0.6, -0.3, -3], [0.29, 0, 0, 1], [0.4], [1]])
            animate(
              target.querySelector("[data-part=shape]"),
              [
                { d: `path("${character.path}")`, offset: 0 },
                { d: `path("${character.path}")`, offset: 0.05 },
                {
                  d: 'path("M27 31C49 17 78 17 99 28C82 43 50 60 29 83C50 83 75 87 96 96")',
                  offset: 0.16,
                },
                {
                  d: 'path("M27 32C49 19 78 19 99 30C82 45 50 63 29 85C50 82 75 84 96 94")',
                  offset: 0.29,
                },
                { d: `path("${character.path}")`, offset: 0.4 },
                { d: `path("${character.path}")`, offset: 1 },
              ],
              character.period
            )
            break
        }
        animate(
          target.querySelector("[data-part=near]"),
          [
            { transform: "scaleY(1)", offset: 0 },
            { transform: "scaleY(.88)", offset: 0.1 },
            { transform: "scaleY(1.04)", offset: 0.2 },
            { transform: "scaleY(1)", offset: 0.34 },
            { transform: "scaleY(1)", offset: 1 },
          ],
          character.period
        )
      }
      // Blend from the in-flight pose, preserving the reference's 160ms state
      // changes instead of snapping a moving character back to its origin.
      if (from) {
        for (const [index, element] of [body, face].entries()) {
          if (!element || !from[index]) continue
          const to = getComputedStyle(element).transform
          if (from[index] === to) continue
          const animation = element.animate([{ transform: from[index] }, { transform: to }], {
            duration: 160,
            easing: "cubic-bezier(.16,1,.3,1)",
          })
          animation.pause()
        }
      }
      updateVisibility()
    }
    start()
    media.addEventListener("change", start)
    return () => media.removeEventListener("change", start)
  }, [character, mascot, size, state])

  return (
    <span
      ref={ref}
      style={{ ...palette.style, width: size, height: size }}
      className={styles.bot}
      data-mascot={mascot}
      data-state={state}
      data-color={color}
      data-running="false"
      aria-hidden="true"
      onPointerEnter={() => {
        const target = ref.current
        if (!target || !motionAllowed.current || document.hidden || !targets.get(target)) return
        const gestures: [string, Keyframe[]][] = [
          [
            "gesture",
            [
              { transform: "none", offset: 0 },
              { transform: "translateY(1.3px) rotate(5deg) scale(1.025,.96)", offset: 0.2 },
              { transform: "translateY(-1.4px) rotate(-3deg) scale(.98,1.025)", offset: 0.52 },
              { transform: "translateY(.3px) rotate(.5deg)", offset: 0.8 },
              { transform: "none", offset: 1 },
            ],
          ],
          [
            "eyelid",
            [
              { opacity: 1, offset: 0 },
              { opacity: 0, offset: 0.18 },
              { opacity: 0, offset: 0.65 },
              { opacity: 1, offset: 0.82 },
              { opacity: 1, offset: 1 },
            ],
          ],
          [
            "happy",
            [
              { opacity: 0, offset: 0 },
              { opacity: 1, offset: 0.18 },
              { opacity: 1, offset: 0.65 },
              { opacity: 0, offset: 0.82 },
              { opacity: 0, offset: 1 },
            ],
          ],
        ]
        for (const [part, frames] of gestures) {
          const element = target.querySelector(`[data-part=${part}]`)
          if (!element) continue
          for (const animation of element.getAnimations()) {
            if (animation.effect?.getTiming().iterations === 1) animation.cancel()
          }
          const animation = element.animate(frames, {
            duration: 490,
            easing: "linear",
            fill: "both",
          })
          animation.onfinish = () => animation.cancel()
        }
      }}
    >
      <svg viewBox="0 0 124 128" focusable="false">
        <g data-part="gesture">
          <g data-part="body">
            <path
              data-part="shape"
              d={character.path}
              fill={character.stroke ? "none" : "currentColor"}
              stroke={character.stroke ? "currentColor" : "none"}
              strokeWidth={28}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <g data-part="face" fill="#26242b">
              {mascot === "pi" && (
                <path
                  d="M45 37Q56 47 67 37"
                  fill="none"
                  stroke="#26242b"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                />
              )}
              {mascot === "pi" && (
                <g fill="#fff">
                  <ellipse cx={x} cy={y} rx="11.5" ry="12" />
                  <ellipse cx={x2} cy={y2} rx="11.5" ry="12" />
                </g>
              )}
              {/* Fixed SVG pivots keep nested eye scaling independent of animated bounds. */}
              <g
                data-part="eyelid"
                style={{
                  transformBox: "view-box",
                  transformOrigin: `${(x + x2) / 2}px ${(y + y2) / 2}px`,
                }}
              >
                <ellipse
                  data-part="near"
                  cx={x}
                  cy={y}
                  rx="6.6"
                  ry="9.4"
                  style={{ transformBox: "view-box", transformOrigin: `${x}px ${y}px` }}
                />
                <ellipse cx={x2} cy={y2} rx="5.7" ry="8.8" />
                {mascot === "pi" && (
                  <g fill="#fff">
                    <circle cx={x - 2} cy={y - 4} r="1.8" />
                    <circle cx={x2 - 2} cy={y2 - 4} r="1.8" />
                  </g>
                )}
              </g>
              <g
                data-part="happy"
                opacity="0"
                fill="none"
                stroke="#26242b"
                strokeWidth="4.5"
                strokeLinecap="round"
              >
                <path d={`M${x - 4} ${y + 1}Q${x} ${y - 3} ${x + 4} ${y + 1}`} />
                <path d={`M${x2 - 3.5} ${y2 + 1}Q${x2} ${y2 - 3} ${x2 + 3.5} ${y2 + 1}`} />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  )
}
