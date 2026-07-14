"use client"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react"
import type { HTMLAttributes, ReactNode } from "react"
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
        <div className="hover:bg-muted/50 flex w-full items-center gap-1 rounded px-2 py-1 transition-colors">
          <CollapsibleTrigger asChild>
            <button className="flex shrink-0 items-center" type="button">
              <ChevronRightIcon
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform",
                  open && "rotate-90"
                )}
              />
            </button>
          </CollapsibleTrigger>
          <button
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={() => tree.toggle(path)}
            type="button"
          >
            {open ? (
              <FolderOpenIcon className="text-primary size-4 shrink-0" />
            ) : (
              <FolderIcon className="text-primary size-4 shrink-0" />
            )}
            <span className="truncate">{name}</span>
          </button>
        </div>
        <CollapsibleContent>
          <div className="ml-4 border-l pl-2" role="group">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  icon?: ReactNode
  name: string
  path: string
}

export function FileTreeFile({ path, name, icon, className, ...props }: FileTreeFileProps) {
  const tree = React.use(FileTreeContext)
  if (!tree) throw new Error("FileTreeFile must be used within FileTree")
  const selected = tree.selectedPath === path

  return (
    <div
      aria-selected={selected}
      className={cn(
        "hover:bg-muted/50 flex cursor-pointer items-center gap-1 rounded px-2 py-1 transition-colors",
        selected && "bg-muted",
        className
      )}
      onClick={() => tree.onSelect?.(path)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          tree.onSelect?.(path)
        }
      }}
      role="treeitem"
      tabIndex={0}
      {...props}
    >
      <span className="size-4 shrink-0" />
      {icon ?? <FileIcon className="text-primary size-4 shrink-0" />}
      <span className="truncate">{name}</span>
    </div>
  )
}
