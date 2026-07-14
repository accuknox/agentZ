"use client"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react"
import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import * as React from "react"

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
  const toggle = React.useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const value = React.useMemo(
    () => ({ expanded, onSelect, selectedPath, toggle }),
    [expanded, onSelect, selectedPath, toggle]
  )

  return (
    <FileTreeContext value={value}>
      <div
        className={cn("bg-background rounded-lg border p-2 font-mono text-sm", className)}
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
        className={className}
        role="treeitem"
        {...props}
      >
        <CollapsibleTrigger asChild>
          <button
            className="hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors"
            type="button"
          >
            <ChevronRightIcon
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-90"
              )}
            />
            {open ? (
              <FolderOpenIcon className="text-primary size-4 shrink-0" />
            ) : (
              <FolderIcon className="text-primary size-4 shrink-0" />
            )}
            <span className="truncate">{name}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-4 border-l pl-2" role="group">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export type FileTreeFileProps = ComponentProps<"button"> & {
  icon?: ReactNode
  name: string
  path: string
}

export function FileTreeFile({
  path,
  name,
  icon,
  className,
  onClick,
  ...props
}: FileTreeFileProps) {
  const tree = React.use(FileTreeContext)
  if (!tree) throw new Error("FileTreeFile must be used within FileTree")
  const selected = tree.selectedPath === path

  return (
    <button
      aria-selected={selected}
      className={cn(
        "hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors",
        selected && "bg-muted",
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
      <span className="size-4 shrink-0" />
      {icon ?? <FileIcon className="text-primary size-4 shrink-0" />}
      <span className="truncate">{name}</span>
    </button>
  )
}
