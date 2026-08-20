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
        className={cn("bg-background rounded-lg border py-1.5 pr-1.5 pl-3.5 text-sm", className)}
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
            className="hover:bg-sidebar-row-hover focus-visible:ring-ring group-data-[drop-target=true]/tree-item:bg-accent group-data-[move-target=true]/tree-item:bg-accent group-data-[move-target=true]/tree-item:ring-ring/40 flex h-6 w-full items-center gap-1.5 rounded-[5px] px-1.5 text-left font-medium transition-colors duration-150 outline-none group-data-[move-target=true]/tree-item:ring-1 group-data-[move-target=true]/tree-item:ring-inset focus-visible:ring-1 focus-visible:ring-inset motion-reduce:transition-none"
            type="button"
          >
            <ChevronRightIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
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
        "hover:bg-sidebar-row-hover focus-visible:ring-ring flex h-6 w-full items-center gap-1.5 rounded-[5px] px-1.5 text-left transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-inset motion-reduce:transition-none",
        selected && "bg-sidebar-row-active",
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
        className="size-4 shrink-0"
        data-file-type-icon
        data-icon-token={fileIcon.token}
        viewBox="0 0 16 16"
      >
        <use href={`#${fileIcon.name}`} />
      </svg>
      <span className="min-w-0 truncate">{name}</span>
    </button>
  )
}
