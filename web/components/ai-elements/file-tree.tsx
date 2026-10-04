"use client"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees"
import { ChevronRightIcon } from "lucide-react"
import type { ComponentProps, HTMLAttributes } from "react"
import * as React from "react"

const fileIconResolver = createFileTreeIconResolver("complete")
const fileIconSprite = getBuiltInSpriteSheet("complete")
const fileIconSpriteId = "agentz-file-icon-sprite"

const fileIconColors: Record<string, string> = {
  astro: "text-primary",
  babel: "text-chart-3",
  bash: "text-chart-1",
  biome: "text-info",
  bootstrap: "text-primary",
  browserslist: "text-chart-3",
  c: "text-info",
  claude: "text-warning",
  cpp: "text-info",
  css: "text-primary",
  database: "text-primary",
  docker: "text-info",
  eslint: "text-primary",
  git: "text-destructive",
  go: "text-chart-4",
  graphql: "text-chart-5",
  html: "text-warning",
  image: "text-chart-5",
  javascript: "text-chart-3",
  json: "text-warning",
  markdown: "text-chart-1",
  mcp: "text-chart-4",
  npm: "text-destructive",
  oxc: "text-chart-4",
  postcss: "text-destructive",
  prettier: "text-chart-4",
  python: "text-info",
  react: "text-chart-4",
  ruby: "text-destructive",
  rust: "text-warning",
  sass: "text-chart-5",
  svelte: "text-destructive",
  svg: "text-warning",
  svgo: "text-chart-1",
  swift: "text-warning",
  table: "text-chart-4",
  tailwind: "text-chart-4",
  terraform: "text-primary",
  typescript: "text-info",
  vite: "text-primary",
  vscode: "text-info",
  vue: "text-chart-1",
  wasm: "text-primary",
  webpack: "text-info",
  yml: "text-destructive",
  zig: "text-warning",
  zip: "text-warning",
}

type FileTreeContextValue = {
  expanded: Set<string>
  onSelect?: (path: string) => void
  selectedPath?: string
  toggle: (path: string) => void
}

const FileTreeContext = React.createContext<FileTreeContextValue | null>(null)

export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  onSelect?: (path: string) => void
  selectedPath?: string
}

export function FileTree({ className, children, onSelect, selectedPath, ...props }: FileTreeProps) {
  const [expanded, setExpanded] = React.useState(new Set<string>())
  React.useInsertionEffect(() => {
    if (document.getElementById(fileIconSpriteId)) return

    const container = document.createElement("div")
    container.id = fileIconSpriteId
    container.setAttribute("aria-hidden", "true")
    container.style.position = "absolute"
    container.style.width = "0"
    container.style.height = "0"
    container.style.overflow = "hidden"
    container.style.pointerEvents = "none"
    container.innerHTML = fileIconSprite
    document.body.prepend(container)
  }, [])

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <FileTreeContext value={{ expanded, onSelect, selectedPath, toggle }}>
      <div
        className={cn("rounded-lg border bg-background py-1.5 pr-1.5 pl-3.5 text-sm", className)}
        role="tree"
        {...props}
      >
        {children}
      </div>
    </FileTreeContext>
  )
}

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  name: string
  path: string
}

export function FileTreeFolder({ path, name, className, children, ...props }: FileTreeFolderProps) {
  const tree = React.use(FileTreeContext)
  if (!tree) throw new Error("FileTreeFolder must be used within FileTree")
  const open = tree.expanded.has(path)

  return (
    <Collapsible onOpenChange={() => tree.toggle(path)} open={open}>
      <div
        aria-expanded={open}
        aria-selected={false}
        className={cn("group/tree-item", className)}
        role="treeitem"
        {...props}
      >
        <CollapsibleTrigger asChild>
          <button
            className="flex h-6 w-full items-center gap-1.5 rounded-[5px] px-1.5 text-left font-medium transition-colors duration-150 outline-none group-data-[drop-target=true]/tree-item:bg-accent group-data-[move-target=true]/tree-item:bg-accent group-data-[move-target=true]/tree-item:ring-1 group-data-[move-target=true]/tree-item:ring-ring/40 group-data-[move-target=true]/tree-item:ring-inset hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
            type="button"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90"
              )}
            />
            <span className="truncate">{name}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-5" role="group">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export type FileTreeFileProps = ComponentProps<"button"> & {
  name: string
  path: string
}

export function FileTreeFile({ path, name, className, onClick, ...props }: FileTreeFileProps) {
  const tree = React.use(FileTreeContext)
  if (!tree) throw new Error("FileTreeFile must be used within FileTree")
  const selected = tree.selectedPath === path
  const fileIcon = fileIconResolver.resolveIcon("file-tree-icon-file", path)

  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex h-6 w-full items-center gap-1.5 rounded-[5px] px-1.5 text-left transition-colors duration-150 outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
        selected && "bg-sidebar-accent",
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) tree.onSelect?.(path)
      }}
      role="treeitem"
      type="button"
      {...props}
    >
      <span className="size-3.5 shrink-0" />
      <svg
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          fileIconColors[fileIcon.token ?? ""] ?? "text-muted-foreground"
        )}
        viewBox="0 0 16 16"
      >
        <use href={`#${fileIcon.name}`} />
      </svg>
      <span className="min-w-0 truncate">{name}</span>
    </button>
  )
}
