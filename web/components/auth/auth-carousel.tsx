"use client"

import { useEffect, useRef, useState } from "react"
import Autoplay from "embla-carousel-autoplay"
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CircleCheck,
  CircleX,
  Database,
  KeyRound,
  LockKeyhole,
  Megaphone,
  Pause,
  Play,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
} from "lucide-react"
import { ProviderIcon } from "@/app/(app)/inference/providers/provider-shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/components/ui/carousel"
import { cn } from "@/lib/utils"

const slides = [
  {
    title: "Configure an agent",
    description: "Choose models, tools, and skills in a reusable sandbox.",
    alt: "Connect a model provider, set up your agent's sandbox with tools and apps, then ask questions, create dashboards, and schedule workflows.",
    artwork: (
      <>
        <Card className="absolute top-[12%] left-[9%] w-[65%] -rotate-6 shadow-lg">
          <CardHeader>
            <div className="mb-3 flex h-24 items-center justify-center rounded-lg bg-chart-3/20 text-warning">
              <Bot className="size-12 stroke-1" />
              <Sparkles className="absolute top-8 right-12 size-5" />
            </div>
            <CardTitle>Agent configuration</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {["Model connected", "Tools selected", "Sandbox ready"].map((label) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <CircleCheck className="size-4 text-success" />
                {label}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card size="sm" className="absolute right-[3%] bottom-[5%] w-[58%] rotate-5 shadow-lg">
          <CardHeader>
            <CardTitle>Start a session</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              Summarize this week’s activity
            </p>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">
                <Sparkles data-icon="inline-start" /> Tools available
              </Badge>
              <Button asChild size="icon-sm">
                <span>
                  <ArrowUp />
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    ),
  },
  {
    title: "Connect model providers",
    description: "Use API keys, supported subscriptions, or custom endpoints.",
    alt: "Example OpenAI, Anthropic, and Google provider connections with an ordered fallback chain. Custom OpenAI- and Anthropic-compatible endpoints are also supported.",
    artwork: (
      <>
        <Card className="absolute top-[16%] left-[12%] w-[68%] -rotate-4 shadow-lg">
          <CardHeader>
            <CardTitle>Provider connections</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {[
              { provider: "openai", name: "OpenAI", label: "Primary" },
              { provider: "anthropic", name: "Anthropic", label: "Fallback 1" },
              { provider: "google", name: "Google Gemini", label: "Fallback 2" },
            ].map(({ provider, name, label }) => (
              <div key={provider} className="flex items-center gap-3 rounded-lg bg-muted/60 p-3">
                <ProviderIcon provider={provider} className="size-6" />
                <span className="flex-1 text-xs">{name}</span>
                <Badge variant="secondary">{label}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card size="sm" className="absolute right-[2%] bottom-[8%] w-[49%] rotate-6 shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-warning" /> Custom endpoints
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">OpenAI / Anthropic compatible</p>
          </CardContent>
        </Card>
      </>
    ),
  },
  {
    title: "Workspace access",
    description: "Scope member roles to organizations and workspaces.",
    alt: "Example Marketing, Operations, and Data workspaces. Member roles control access at organization and workspace scope.",
    artwork: (
      <>
        <Card className="absolute top-[13%] left-[10%] w-[65%] -rotate-5 shadow-lg">
          <CardHeader>
            <div className="mb-3 flex h-20 items-center justify-center rounded-lg bg-chart-1/15 text-success">
              <Users className="size-10 stroke-1" />
            </div>
            <CardTitle>Workspaces by team</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {[
              {
                icon: Megaphone,
                team: "Marketing",
                task: "Reports workspace",
                color: "bg-chart-3/20 text-warning",
              },
              {
                icon: Terminal,
                team: "Operations",
                task: "Infrastructure workspace",
                color: "bg-primary/10 text-primary",
              },
              {
                icon: Database,
                team: "Data",
                task: "Analytics workspace",
                color: "bg-chart-1/15 text-success",
              },
            ].map(({ icon: Icon, team, task, color }) => (
              <div key={team} className="flex items-center gap-3">
                <span className={cn("flex size-8 items-center justify-center rounded-lg", color)}>
                  <Icon className="size-4" />
                </span>
                <div className="flex-1">
                  <p className="text-xs">{team}</p>
                  <p className="text-xs text-muted-foreground">{task}</p>
                </div>
                <Check className="size-4 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card size="sm" className="absolute right-[2%] bottom-[5%] w-[47%] rotate-6 shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" /> Role assignments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary">Workspace-scoped roles</Badge>
          </CardContent>
        </Card>
      </>
    ),
  },
  {
    title: "Secret injection proxy",
    description: "Agents receive placeholders. The proxy injects credentials for matching hosts.",
    alt: "Example HTTP/1.1 request: the agent sends agentz:resolve:env:GITHUB_TOKEN. The proxy reads the credential from Vault and replaces the placeholder only if api.github.com matches the secret's allowed hosts. Other destinations keep the placeholder.",
    artwork: (
      <div className="absolute inset-x-[9%] top-[12%] flex flex-col items-center gap-3">
        <div className="w-full -rotate-3 overflow-hidden rounded-xl bg-card shadow-lg ring-1 ring-foreground/10">
          <div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs">
            <span className="flex items-center gap-2">
              <Terminal className="size-4" /> Agent request
            </span>
            <Badge variant="secondary">HTTP/1.1</Badge>
          </div>
          <div className="flex flex-col gap-2 p-4 font-mono text-xs">
            <span className="text-muted-foreground">Authorization: Bearer</span>
            <span className="text-primary">agentz:resolve:env:GITHUB_TOKEN</span>
          </div>
        </div>
        <ArrowDown className="size-5 text-muted-foreground" />
        <div className="flex w-full items-center justify-center gap-3">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
            <ShieldCheck className="size-8 stroke-1" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Injection proxy</p>
            <p className="text-xs text-muted-foreground">Match host, resolve key</p>
          </div>
          <span className="w-6 border-t-2 border-dashed border-muted-foreground/50" />
          <div className="flex flex-col items-center gap-1 text-xs">
            <LockKeyhole className="size-6 text-warning" /> Vault
          </div>
        </div>
        <ArrowDown className="size-5 text-muted-foreground" />
        <div className="flex w-4/5 rotate-3 items-center gap-3 rounded-xl bg-card p-4 shadow-lg ring-1 ring-foreground/10">
          <CircleCheck className="size-6 shrink-0 text-success" />
          <div className="flex flex-col gap-1">
            <p className="font-mono text-xs">api.github.com</p>
            <p className="text-xs text-muted-foreground">Receives the real credential</p>
          </div>
        </div>
        <Badge variant="outline">Example request</Badge>
      </div>
    ),
  },
  {
    title: "Default-deny networking",
    description: "Sandbox policies limit sandbox egress to permitted destinations.",
    alt: "Example egress policy: an agent pod can reach a configured host and the inference gateway. Traffic to an unlisted external host is denied. Platform services also receive explicit network rules.",
    artwork: (
      <div className="absolute inset-x-[6%] top-[12%] bottom-[6%]">
        <div className="flex items-center justify-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="text-sm font-medium">Sandbox egress</span>
        </div>
        <div className="absolute top-[22%] bottom-[10%] left-0 flex w-[37%] flex-col items-center justify-center gap-3 rounded-[2rem] border-2 border-dashed border-primary/60 bg-primary/5">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-card text-primary shadow-sm ring-1 ring-foreground/10">
            <Bot className="size-9 stroke-1" />
          </span>
          <p className="text-sm font-medium">Agent pod</p>
          <Badge variant="secondary">Default deny</Badge>
        </div>
        <div className="absolute top-[24%] right-0 bottom-[12%] flex w-[63%] flex-col justify-between">
          {[
            {
              label: "Configured host",
              detail: "docs.example.com",
              icon: CircleCheck,
              color: "text-success",
              line: "border-success/40",
            },
            {
              label: "Platform service",
              detail: "Inference gateway",
              icon: CircleCheck,
              color: "text-primary",
              line: "border-primary/40",
            },
            {
              label: "Unlisted host",
              detail: "Denied",
              icon: CircleX,
              color: "text-destructive",
              line: "border-destructive/60 border-t-2 border-dashed",
            },
          ].map(({ label, detail, icon: Icon, color, line }) => (
            <div key={label} className="flex items-center gap-3">
              <span className={cn("w-10 shrink-0 border-t", line)} />
              <Icon className={cn("size-6 shrink-0", color)} />
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    title: "Inspect execution traces",
    description: "Inspect model and tool spans, durations, and token usage in Lens.",
    alt: "Illustrative trace waterfall, not measured performance: a four-second agent span contains a 1.5-second model call, a one-second tool call, and a final 1.5-second model call. Lens exposes span timing and token usage.",
    artwork: (
      <div className="absolute inset-x-[7%] top-[14%] flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium">Execution timeline</p>
            <p className="text-xs text-muted-foreground">Agent → model → tool</p>
          </div>
        </div>
        <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-5">
          <span className="text-xs text-muted-foreground">Span</span>
          <div className="flex justify-between font-mono text-xs text-muted-foreground">
            <span>0s</span>
            <span>2s</span>
            <span>4s</span>
          </div>
          {[
            {
              label: "Agent",
              start: 0,
              width: 100,
              duration: "4.0s",
              color: "bg-primary/20 text-primary",
            },
            {
              label: "Model",
              start: 0,
              width: 37.5,
              duration: "1.5s",
              color: "bg-chart-1/25 text-success",
            },
            {
              label: "Tool",
              start: 37.5,
              width: 25,
              duration: "1.0s",
              color: "bg-chart-4/25 text-foreground",
            },
            {
              label: "Model",
              start: 62.5,
              width: 37.5,
              duration: "1.5s",
              color: "bg-chart-1/25 text-success",
            },
          ].map(({ label, start, width, duration, color }, index) => (
            <div key={index} className="col-span-2 grid grid-cols-subgrid items-center">
              <span className="text-xs">{label}</span>
              <div className="relative border-x border-border">
                <span className="absolute inset-y-0 left-1/2 border-l-2 border-dashed border-muted-foreground/50" />
                <div
                  className={cn(
                    "relative rounded-md px-2 py-2 text-center font-mono text-xs",
                    color
                  )}
                  style={{ marginLeft: `${start}%`, width: `${width}%` }}
                >
                  {duration}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border pt-4 text-xs">
          <span className="text-muted-foreground">Per-span detail</span>
          <span className="flex items-center gap-2">
            Timing · Tokens · Errors <ArrowRight className="size-4 text-primary" />
          </span>
        </div>
      </div>
    ),
  },
]

export function AuthCarousel() {
  const [api, setApi] = useState<CarouselApi>()
  const [current, setCurrent] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const playButton = useRef<HTMLButtonElement>(null)
  const [autoplay] = useState(() => Autoplay({ delay: 4000, playOnInit: false }))

  useEffect(() => {
    if (!api) return

    const select = () => setCurrent(api.selectedScrollSnap())
    const stop = () => setPaused(true)
    api.on("select", select).on("reInit", select).on("pointerDown", stop)
    return () => {
      api.off("select", select).off("reInit", select).off("pointerDown", stop)
    }
  }, [api])

  useEffect(() => {
    if (!api) return

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const desktop = window.matchMedia("(min-width: 1024px)")
    function syncPlayback() {
      if (paused || hovered || reducedMotion.matches || !desktop.matches || document.hidden) {
        autoplay.stop()
        return
      }
      autoplay.play()
    }
    syncPlayback()
    api.on("reInit", syncPlayback)
    reducedMotion.addEventListener("change", syncPlayback)
    desktop.addEventListener("change", syncPlayback)
    document.addEventListener("visibilitychange", syncPlayback)
    return () => {
      autoplay.stop()
      api.off("reInit", syncPlayback)
      reducedMotion.removeEventListener("change", syncPlayback)
      desktop.removeEventListener("change", syncPlayback)
      document.removeEventListener("visibilitychange", syncPlayback)
    }
  }, [api, autoplay, hovered, paused])

  return (
    <Carousel
      setApi={setApi}
      plugins={[autoplay]}
      opts={{ loop: true, breakpoints: { "(prefers-reduced-motion: reduce)": { duration: 0 } } }}
      aria-label="What you can do with AgentZ"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (event.nativeEvent.target !== playButton.current) setPaused(true)
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") setPaused(true)
      }}
    >
      <CarouselContent className="ml-0">
        {slides.map((slide, index) => (
          <CarouselItem
            key={slide.title}
            className="pl-0"
            aria-hidden={current !== index}
            aria-label={`${index + 1} of ${slides.length}: ${slide.title}`}
          >
            <div role="img" aria-label={slide.alt} className="relative aspect-[6/5]">
              <div aria-hidden="true" inert className="absolute inset-0 select-none">
                <span className="absolute top-[7%] right-[18%] h-5 w-3 -rotate-30 rounded-full bg-chart-3/40" />
                <span className="absolute top-[43%] right-[4%] size-3 rounded-full bg-chart-1/35" />
                <span className="absolute bottom-[9%] left-[8%] h-2 w-5 rotate-35 rounded-full bg-chart-5/30" />
                {slide.artwork}
              </div>
            </div>
            <div className="mx-auto mt-8 flex max-w-sm flex-col gap-3 px-4 text-center">
              <h2 className="text-xl font-medium tracking-tight">{slide.title}</h2>
              <p className="min-h-10 text-sm text-pretty text-muted-foreground">
                {slide.description}
              </p>
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <div className="mt-7 flex items-center justify-center gap-3">
        <div className="flex items-center" aria-label="Choose a slide">
          {slides.map((slide, index) => (
            <Button
              key={slide.title}
              variant="plain"
              size="icon"
              aria-label={`Show slide ${index + 1}: ${slide.title}`}
              aria-current={current === index ? "true" : undefined}
              onClick={() => {
                setPaused(true)
                api?.scrollTo(index)
              }}
            >
              <span
                className={cn(
                  "h-1.5 rounded-full bg-current transition-[width,opacity] motion-reduce:transition-none",
                  current === index ? "w-6" : "w-1.5 opacity-40"
                )}
              />
            </Button>
          ))}
        </div>
        <Button
          ref={playButton}
          variant="plain"
          size="icon"
          className="motion-reduce:hidden"
          aria-label={paused ? "Play slideshow" : "Pause slideshow"}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
      </div>
    </Carousel>
  )
}
