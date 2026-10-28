import { memo } from "react"
import { Image, StyleSheet, View } from "react-native"
import Animated, { useReducedMotion, type CSSAnimationKeyframes } from "react-native-reanimated"

export type ZedPose = "idle" | "thinking" | "working" | "waiting" | "done"

// Tint the supplied artwork to a silhouette; independent native eyes can look and blink.
const eyes = [
  [134.5, 59],
  [155, 54],
] as const
const float: CSSAnimationKeyframes = {
  "0%, 100%": { transform: [{ translateY: 2 }] },
  "45%": { transform: [{ translateY: -4 }] },
  "70%": { transform: [{ translateY: 0 }] },
}
const tilt: CSSAnimationKeyframes = {
  "0%, 18%, 65%, 100%": { transform: [{ rotate: "0deg" }] },
  "28%": { transform: [{ rotate: "-5deg" }] },
  "42%": { transform: [{ rotate: "2deg" }] },
  "52%": { transform: [{ rotate: "-1deg" }] },
}
const look: CSSAnimationKeyframes = {
  "0%, 15%, 58%, 100%": { transform: [{ translateX: 0 }] },
  "22%, 30%": { transform: [{ translateX: -7 }] },
  "38%, 46%": { transform: [{ translateX: 5 }] },
  "76%, 84%": { transform: [{ translateX: 3 }] },
}
const blink: CSSAnimationKeyframes = {
  "0%, 23%, 26%, 65%, 68%, 100%": { transform: [{ scaleY: 1 }] },
  "24%, 66%": { transform: [{ scaleY: 0.08 }] },
}
const wink: CSSAnimationKeyframes = {
  "0%, 23%, 26%, 73%, 79%, 100%": { transform: [{ scaleY: 1 }] },
  "24%, 75%, 77%": { transform: [{ scaleY: 0.08 }] },
}
const satisfied: CSSAnimationKeyframes = {
  "0%, 18%, 38%, 100%": { transform: [{ scaleY: 1 }] },
  "23%, 31%": { transform: [{ scaleY: 0.08 }] },
}
const motion: Record<
  ZedPose,
  {
    float: CSSAnimationKeyframes
    tilt: CSSAnimationKeyframes
    look: CSSAnimationKeyframes
    floatDuration: number
    tiltDuration: number
    lookDuration: number
  }
> = {
  idle: { float, tilt, look, floatDuration: 6000, tiltDuration: 6000, lookDuration: 6000 },
  thinking: {
    float,
    tilt: {
      "0%, 100%": { transform: [{ rotate: "-4deg" }] },
      "50%": { transform: [{ rotate: "-9deg" }] },
    },
    look: {
      "0%, 100%": { transform: [{ translateX: -4 }, { translateY: -2 }] },
      "50%": { transform: [{ translateX: 3 }, { translateY: -5 }] },
    },
    floatDuration: 4000,
    tiltDuration: 1800,
    lookDuration: 2100,
  },
  working: {
    float: {
      "0%, 100%": {
        transform: [{ translateX: 0 }, { translateY: 1 }, { scaleX: 1 }, { scaleY: 1 }],
      },
      "50%": {
        transform: [{ translateX: 3 }, { translateY: -3 }, { scaleX: 1.02 }, { scaleY: 0.98 }],
      },
    },
    tilt: {
      "0%, 100%": { transform: [{ rotate: "2deg" }] },
      "50%": { transform: [{ rotate: "5deg" }] },
    },
    look: {
      "0%, 100%": { transform: [{ translateX: 3 }] },
      "50%": { transform: [{ translateX: -1 }] },
    },
    floatDuration: 900,
    tiltDuration: 900,
    lookDuration: 900,
  },
  waiting: {
    float: {
      "0%, 100%": { transform: [{ translateY: 3 }] },
      "50%": { transform: [{ translateY: 6 }] },
    },
    tilt: {
      "0%, 100%": { transform: [{ rotate: "0deg" }] },
      "50%": { transform: [{ rotate: "4deg" }] },
    },
    look: {
      "0%, 24%, 100%": { transform: [{ translateX: -4 }, { translateY: 2 }] },
      "38%, 62%": { transform: [{ translateX: 4 }, { translateY: 3 }] },
    },
    floatDuration: 2500,
    tiltDuration: 2500,
    lookDuration: 4000,
  },
  done: {
    float: {
      "0%, 100%": { transform: [{ translateY: 0 }] },
      "12%": { transform: [{ translateY: -13 }] },
      "28%": { transform: [{ translateY: 3 }] },
      "40%": { transform: [{ translateY: -4 }] },
    },
    tilt: {
      "0%, 100%": { transform: [{ rotate: "0deg" }] },
      "15%": { transform: [{ rotate: "-8deg" }] },
      "30%": { transform: [{ rotate: "4deg" }] },
    },
    look: {},
    floatDuration: 2200,
    tiltDuration: 2200,
    lookDuration: 2200,
  },
}

export const Zed = memo(function Zed({
  color,
  size = 32,
  pose = "idle",
  animate = true,
}: {
  color: string
  size?: number
  pose?: ZedPose
  animate?: boolean
}) {
  const reducedMotion = useReducedMotion()
  const active = animate && !reducedMotion
  const current = motion[pose]
  const iterations = pose === "thinking" || pose === "working" ? "infinite" : 1
  return (
    <View pointerEvents="none" accessible={false} style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          width: 220,
          height: 220,
          left: (size - 220) / 2,
          top: (size - 220) / 2,
          transform: [{ scale: size / 220 }],
        }}
      >
        <Animated.View
          style={[
            styles.canvas,
            active && {
              animationName: current.float,
              animationDuration: current.floatDuration,
              animationIterationCount: iterations,
              animationTimingFunction: "ease-in-out",
              animationFillMode: "forwards",
            },
          ]}
        >
          <Animated.View
            style={[
              styles.canvas,
              active && {
                animationName: current.tilt,
                animationDuration: current.tiltDuration,
                animationIterationCount: iterations,
                animationTimingFunction: "ease-in-out",
                animationFillMode: "forwards",
              },
            ]}
          >
            <Image
              source={require("./assets/zed.png")}
              style={[styles.canvas, { tintColor: color }]}
              fadeDuration={0}
            />
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                active &&
                  pose !== "done" && {
                    animationName: current.look,
                    animationDuration: current.lookDuration,
                    animationIterationCount: iterations,
                    animationTimingFunction: "ease-in-out",
                  },
              ]}
            >
              {eyes.map(([x, y], index) => {
                let expression = blink
                if (index === 1) expression = pose === "done" ? satisfied : wink
                return (
                  <View key={index} style={[styles.eye, { left: x - 3.8, top: y - 8.9 }]}>
                    <Animated.View
                      style={[
                        styles.ink,
                        active &&
                          (pose !== "done" || index === 1) && {
                            animationName: expression,
                            animationDuration: pose === "done" ? 2200 : 6000,
                            animationIterationCount: iterations,
                            animationTimingFunction: "linear",
                            animationFillMode: "forwards",
                          },
                      ]}
                    />
                  </View>
                )
              })}
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  canvas: { width: 220, height: 220 },
  eye: { position: "absolute", width: 7.6, height: 17.8, transform: [{ rotate: "-13deg" }] },
  ink: { width: 7.6, height: 17.8, borderRadius: 3.8, backgroundColor: "#19191a" },
})
