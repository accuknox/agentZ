"use client"

import { useId, type ReactNode } from "react"
import { Calendar, CircleAlert, Clock, ServerCrash } from "lucide-react"
import { SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"

import { formatCompactNumber } from "@/lib/format"
import { cn } from "@/lib/utils"

const CodeBlock = dynamic(() =>
  import("@/components/ai-elements/code-block").then((module) => module.CodeBlock)
)

export function TraceInspectorSheet({
  title,
  description,
  tabs,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  tabs: ReactNode
  children: ReactNode
}) {
  const descriptionId = useId()
  return (
    <SheetContent
      aria-describedby={description ? descriptionId : undefined}
      className="bg-background gap-0 overflow-x-hidden overflow-y-auto border-l p-0 text-sm shadow-2xl data-[side=right]:w-full data-[side=right]:max-w-full sm:max-w-none! md:w-[89vw]! lg:w-[84vw]! lg:overflow-hidden [&_svg]:size-4"
    >
      <SheetHeader>
        <SheetTitle className="text-md truncate">{title}</SheetTitle>
        {description ? <SheetDescription id={descriptionId}>{description}</SheetDescription> : null}
      </SheetHeader>
      <div className="bg-background flex flex-col lg:grid lg:min-h-0 lg:flex-1 lg:grid-rows-[auto_1fr]">
        <div className="bg-muted/50 px-4 py-2">{tabs}</div>
        <div className="lg:min-h-0 lg:overflow-hidden">{children}</div>
      </div>
    </SheetContent>
  )
}

export function TraceInspectorLayout({
  title,
  pagination,
  navigation,
  children,
}: {
  title: ReactNode
  pagination: ReactNode
  navigation: ReactNode
  children: ReactNode
}) {
  return (
    <div className="bg-background lg:h-full lg:overflow-hidden">
      <div className="flex flex-col lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[34%_66%]">
        <aside className="bg-background flex min-h-0 flex-col border-b lg:border-r lg:border-b-0">
          <div className="bg-muted/10 flex h-10 shrink-0 items-center justify-between px-4 lg:px-5">
            <div className="min-w-0 text-sm font-medium">{title}</div>
            {pagination}
          </div>
          <div className="max-h-72 overflow-auto py-2 pb-5 lg:max-h-none lg:min-h-0 lg:flex-1 lg:pb-8">
            {navigation}
          </div>
        </aside>
        <section className="bg-background min-h-0 min-w-0">{children}</section>
      </div>
    </div>
  )
}

export function TraceInspectorSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading trace"
      className="h-full motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      <span className="sr-only">Loading trace</span>
      <TraceInspectorLayout
        title={<Skeleton className="h-4 w-20" />}
        pagination={<Skeleton className="h-4 w-28" />}
        navigation={Array.from({ length: 6 }, (_, index) => (
          <div key={index} aria-hidden className="flex flex-col gap-2 px-7 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4" />
              <Skeleton className={index % 2 === 0 ? "h-4 w-24" : "h-4 w-32"} />
            </div>
            <div className="ml-6 flex gap-3">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className="ml-6 h-0.5" />
          </div>
        ))}
      >
        <div aria-hidden className="flex flex-col lg:h-full">
          <div className="bg-muted/10 flex h-10 shrink-0 items-center gap-3 px-4 lg:px-5">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="overflow-hidden px-4 py-4 lg:px-6">
            <div className="mb-5 flex gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="bg-muted/10 mb-5 flex flex-col gap-3 rounded-md p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-1.5 w-full" />
              <div className="flex flex-wrap gap-6">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-3 w-20" />
                ))}
              </div>
            </div>
            <TraceContentSkeleton />
          </div>
        </div>
      </TraceInspectorLayout>
    </div>
  )
}

export function TraceContentSkeleton() {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-5 motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      {[4, 3].map((lines) => (
        <div key={lines} className="flex flex-col gap-3">
          <Skeleton className="my-2 h-4 w-20" />
          <div className="bg-muted/20 flex flex-col gap-3 rounded-md p-4">
            {Array.from({ length: lines }, (_, index) => (
              <Skeleton key={index} className={index === lines - 1 ? "h-3 w-2/3" : "h-3 w-full"} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function TraceInspectorRow({
  label,
  icon,
  selected,
  onClick,
  depth,
  duration,
  tokens = 0,
  id,
  hasError,
  timelineClass,
  durationPercent,
  offsetPercent,
}: {
  label: string
  icon: ReactNode
  selected: boolean
  onClick: () => void
  depth: number
  duration: string
  tokens?: number
  id: string
  hasError?: boolean
  timelineClass: string
  durationPercent: number
  offsetPercent: number
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "hover:bg-muted/35 relative flex w-full flex-col border-l-4 border-transparent py-2 pr-4 text-left lg:pr-5",
        selected && "border-primary/55 bg-muted/55"
      )}
      style={{ paddingLeft: depth * 22 + 28 }}
      onClick={onClick}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="truncate text-sm font-medium">{label}</span>
        {hasError ? <CircleAlert className="text-destructive" /> : null}
      </div>
      <div className="text-muted-foreground mt-0.5 ml-6 flex flex-wrap items-center gap-2 text-xs lg:gap-3 [&_svg]:size-3.5">
        <span className="inline-flex items-center gap-1">
          <Clock />
          {duration}
        </span>
        {tokens > 0 ? <span>{formatCompactNumber(tokens)} tokens</span> : null}
        <span className="font-mono">{id.slice(0, 8)}</span>
      </div>
      <div className="bg-border mt-1.5 ml-6 h-0.5 rounded-full">
        <div
          className={cn("h-full rounded-full", timelineClass)}
          style={{ width: `${durationPercent}%`, marginLeft: `${offsetPercent}%` }}
        />
      </div>
    </button>
  )
}

export function TraceInspectorDetail({
  title,
  started,
  duration,
  tokens,
  children,
}: {
  title: string
  started?: string
  duration?: string
  tokens?: number
  children: ReactNode
}) {
  return (
    <div className="flex flex-col lg:h-full">
      <div className="bg-muted/10 flex h-10 shrink-0 items-center justify-between px-4 lg:px-5 [&_svg]:size-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-muted-foreground text-sm">Inspect:</span>
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      </div>
      <div className="overflow-auto px-4 py-4 lg:min-h-0 lg:flex-1 lg:px-6">
        <div className="text-muted-foreground mb-5 flex flex-wrap items-center gap-3 text-sm lg:gap-4 [&_svg]:size-4">
          {started ? (
            <span className="inline-flex items-center gap-1">
              <Calendar />
              {started}
            </span>
          ) : null}
          {duration ? (
            <span className="inline-flex items-center gap-1">
              <Clock />
              {duration}
            </span>
          ) : null}
          {tokens !== undefined ? <span>{formatCompactNumber(tokens)} tokens</span> : null}
        </div>
        {children}
      </div>
    </div>
  )
}

export function TraceTokenMeter({
  segments,
}: {
  segments: { label: string; value: number; colorClass: string; displayValue?: number }[]
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  if (total === 0) return null
  return (
    <section className="bg-muted/10 mb-5 rounded-md p-4">
      <div className="mb-3 flex items-center justify-between gap-3 text-xs">
        <span className="text-foreground font-medium">{formatCompactNumber(total)} total</span>
      </div>
      <div className="bg-muted flex h-1.5 overflow-hidden rounded-full">
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={segment.colorClass}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
        {segments.map((segment) => (
          <span key={segment.label} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", segment.colorClass)} />
            <span>
              {segment.label} {formatCompactNumber(segment.displayValue ?? segment.value)}
            </span>
          </span>
        ))}
      </div>
    </section>
  )
}

export function TraceContentPanel({
  title,
  code,
  text,
}: {
  title: string
} & ({ code: string; text?: never } | { text: string; code?: never })) {
  return (
    <section>
      <div className="my-2 flex items-center justify-between">
        {title === "Error" ? (
          <div className="text-destructive text-sm font-medium">
            <ServerCrash className="mr-1.5 inline-block" />
            <span>{title}</span>
          </div>
        ) : (
          <div className="text-sm font-medium">{title}</div>
        )}
      </div>
      <div className="max-h-100 overflow-auto rounded-md">
        {code !== undefined ? (
          <CodeBlock code={code} language="json" showLineNumbers className="bg-muted/20 border-0" />
        ) : (
          <pre className="bg-muted/20 p-4 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            {text}
          </pre>
        )}
      </div>
    </section>
  )
}
