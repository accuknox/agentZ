import type { CSSProperties } from "react"
import type { AgentAppearance, MascotBreed, MascotColor } from "@/lib/gateway/client"

// The mascot family shares one contract across storage, controls and SVGs.
export const mascotNames = [
  "mochi",
  "ziglet",
  "slinky",
  "mallow",
  "pip",
  "pi",
] as const satisfies readonly MascotBreed[]
export const mascotColorNames = [
  "cream",
  "lilac",
  "peach",
  "rose",
  "coral",
  "amber",
  "lime",
  "mint",
  "sky",
  "slate",
] as const satisfies readonly MascotColor[]

export const defaultAgentAppearance: AgentAppearance = { breed: "mochi", color: "sky" }

export const mascots: Record<
  MascotBreed,
  {
    name: string
    description: string
    path: string
    stroke: boolean
    eyes: readonly [number, number, number, number]
    period: number
  }
> = {
  mochi: {
    name: "Mochi",
    description: "A little softie",
    path: "M29 17C15 16 10 23 11 35C12 49 23 55 37 53L54 50L31 70C17 81 14 92 23 102C32 113 46 112 61 110L86 109C103 110 112 104 112 93C112 81 103 76 89 78L65 81L100 54C112 44 117 32 108 23C100 14 88 17 74 18Z",
    stroke: false,
    eyes: [73, 33, 91, 33],
    period: 1700,
  },
  ziglet: {
    name: "Ziglet",
    description: "A pocket-sized spark",
    path: "M29 18C16 16 10 24 12 36L14 47Q15 56 25 53L47 48L34 63Q28 70 36 71L48 70L35 88C30 96 34 101 42 96L99 66C109 60 107 56 98 57L78 58L101 36C110 27 108 20 97 18C79 15 52 20 29 18Z",
    stroke: false,
    eyes: [69, 33, 85, 32],
    period: 1450,
  },
  slinky: {
    name: "Slinky",
    description: "A soft little accordion",
    path: "M27 23L96 23L33 62L91 62L28 105L91 105",
    stroke: true,
    eyes: [73, 23, 91, 23],
    period: 1850,
  },
  mallow: {
    name: "Mallow",
    description: "A soft, curious squiggle",
    path: "M27 32C49 18 78 18 99 29C82 44 50 62 29 84C50 82 75 85 96 95",
    stroke: true,
    eyes: [73, 25, 91, 29],
    period: 1950,
  },
  pip: {
    name: "Pip",
    description: "A shy little zig",
    path: "M36 17C20 14 12 23 14 37C16 51 27 56 42 53L56 48L37 68C25 81 27 96 38 103C48 110 60 108 72 107C87 108 96 103 96 93C95 83 86 80 76 84L62 89L92 58C105 45 111 33 103 24C95 14 80 17 66 18Z",
    stroke: false,
    eyes: [70, 34, 87, 34],
    period: 1750,
  },
  pi: {
    name: "Pi",
    description: "A curious little constant",
    path: "M42 44C24 54 18 42 32 34C43 29 49 34 61 34L102 34M50 40L35 105M80 40C69 73 75 92 95 105",
    stroke: true,
    eyes: [46, 17, 78, 17],
    period: 1900,
  },
}

// Dark-theme colors preserve the review palette; light-theme shades retain
// the silhouette against a white transcript without adding outlines.
export const mascotColors: Record<
  MascotColor,
  {
    name: string
    style: CSSProperties & Record<"--mascot-light" | "--mascot-dark", string>
  }
> = {
  cream: { name: "Cream", style: { "--mascot-light": "#b6a184", "--mascot-dark": "#f3ede4" } },
  lilac: { name: "Lilac", style: { "--mascot-light": "#a78bdc", "--mascot-dark": "#bca9f4" } },
  peach: { name: "Peach", style: { "--mascot-light": "#e1a17f", "--mascot-dark": "#f0c8b4" } },
  rose: { name: "Rose", style: { "--mascot-light": "#db8da6", "--mascot-dark": "#f2b5cb" } },
  coral: { name: "Coral", style: { "--mascot-light": "#df887d", "--mascot-dark": "#f4b0a6" } },
  amber: { name: "Amber", style: { "--mascot-light": "#d6a24c", "--mascot-dark": "#f0d08e" } },
  lime: { name: "Lime", style: { "--mascot-light": "#9aaf61", "--mascot-dark": "#d0df9c" } },
  mint: { name: "Mint", style: { "--mascot-light": "#71b49a", "--mascot-dark": "#a9ddc7" } },
  sky: { name: "Sky", style: { "--mascot-light": "#7baad2", "--mascot-dark": "#aed5f2" } },
  slate: { name: "Slate", style: { "--mascot-light": "#94a0b2", "--mascot-dark": "#cbd3df" } },
}
