"use client"

import * as React from "react"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import dynamic from "next/dynamic"
import {
  Braces,
  Code2,
  Copy,
  Download,
  Eye,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FilePlus2,
  FolderPlus,
  PanelRightClose,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { MessageResponse } from "@/components/ai-elements/message"
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  createAgentDirectoryMutation,
  createAgentFileMutation,
  deleteAgentEntryMutation,
  readAgentFileOptions,
  readAgentFileQueryKey,
  readAgentFileRawOptions,
  renameAgentEntryMutation,
  statAgentFileOptions,
  statAgentFileQueryKey,
  writeAgentFileMutation,
} from "@/lib/gateway/client/@tanstack/react-query.gen"
import { readAgentFileRaw } from "@/lib/gateway/client/sdk.gen"
import { createAgentOpencodeClient } from "@/lib/opencode/client"

const CodeEditor = dynamic(
  () => import("@/components/blocks/chat/code-editor").then((module) => module.CodeEditor),
  { ssr: false }
)

type FilesWorkspaceProps = {
  agentName: string
  sessionId?: string
}

type FileTab = {
  name: string
  path: string
}

type Draft = {
  conflict: boolean
  content: string
  dirty: boolean
  lineEnding: "\n" | "\r\n"
  truncated: boolean
  version: string
}

type EntryAction =
  | { kind: "file"; parent: string }
  | { kind: "directory"; parent: string }
  | { kind: "rename"; entry: FileNode }
  | { kind: "delete"; entry: FileNode }

type Confirmation = {
  description: string
  label: string
  onConfirm: () => void
  title: string
}

type DirectoryTreeProps = {
  agentName: string
  onAction: (action: EntryAction) => void
  path: string
  root: string
}

function agentFilesQueryOptions(agentName: string, root: string, path: string) {
  return queryOptions({
    queryFn: async ({ signal }) => {
      const client = await createAgentOpencodeClient(agentName)
      const { data } = await client.file.list(
        { directory: root, path },
        { signal, throwOnError: true }
      )
      return data.toSorted((a, b) => {
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
    },
    queryKey: ["opencode-files", agentName, root, path],
    staleTime: 60_000,
  })
}

export function FilesWorkspace({ agentName, sessionId }: FilesWorkspaceProps) {
  const { openAgent } = useFileWorkspace()
  const filesOpen = openAgent === agentName

  return filesOpen ? <OpenFilesWorkspace agentName={agentName} sessionId={sessionId} /> : null
}

function OpenFilesWorkspace({ agentName, sessionId }: FilesWorkspaceProps) {
  const [explorerWidth, setExplorerWidth] = React.useState(288)
  const [workspaceWidth, setWorkspaceWidth] = React.useState(760)
  const reducedMotion = useReducedMotion()
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [resizing, setResizing] = React.useState(false)
  const resize = React.useRef<{ pointerId: number; startWidth: number; startX: number }>(null)
  const width = editorOpen ? workspaceWidth : explorerWidth

  const rootQuery = useQuery(
    queryOptions({
      queryFn: async ({ signal }) => {
        const client = await createAgentOpencodeClient(agentName)
        if (sessionId) {
          const { data } = await client.session.get(
            { sessionID: sessionId },
            { signal, throwOnError: true }
          )
          return data.directory
        }

        const { data } = await client.path.get({}, { signal, throwOnError: true })
        return data.directory
      },
      queryKey: ["agent-workspace-root", agentName, sessionId ?? "new"],
      retry: 2,
      staleTime: 60_000,
    })
  )

  return (
    <aside className="relative hidden h-full min-h-0 shrink-0 overflow-hidden border-l shadow-sm lg:block">
      <div
        aria-label="Resize files workspace"
        aria-orientation="vertical"
        aria-valuemax={editorOpen ? 1200 : 520}
        aria-valuemin={editorOpen ? explorerWidth + 240 : 220}
        aria-valuenow={width}
        className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize touch-none transition-colors"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const nextWidth = width + (event.key === "ArrowLeft" ? 16 : -16)
          if (editorOpen) {
            setWorkspaceWidth(Math.min(1200, Math.max(explorerWidth + 240, nextWidth)))
            return
          }
          setExplorerWidth(Math.min(520, Math.max(220, nextWidth)))
        }}
        onPointerDown={(event) => {
          setResizing(true)
          event.currentTarget.setPointerCapture(event.pointerId)
          resize.current = {
            pointerId: event.pointerId,
            startWidth: width,
            startX: event.clientX,
          }
        }}
        onPointerMove={(event) => {
          if (!resize.current) return
          const nextWidth = resize.current.startWidth + resize.current.startX - event.clientX
          if (editorOpen) {
            setWorkspaceWidth(Math.min(1200, Math.max(explorerWidth + 240, nextWidth)))
            return
          }
          setExplorerWidth(Math.min(520, Math.max(220, nextWidth)))
        }}
        onPointerUp={(event) => {
          resize.current = null
          setResizing(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => {
          resize.current = null
          setResizing(false)
        }}
        role="separator"
        tabIndex={0}
      />
      <div className="bg-background h-full min-h-0">
        {rootQuery.isPending ? (
          <div
            aria-live="polite"
            className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
            role="status"
            style={{ width: explorerWidth }}
          >
            <Spinner /> Loading workspace...
          </div>
        ) : rootQuery.isError ? (
          <div
            className="flex h-full items-center justify-center p-6"
            style={{ width: explorerWidth }}
          >
            <Alert variant="destructive">
              <AlertTitle>Files unavailable</AlertTitle>
              <AlertDescription className="mt-1">
                The agent workspace could not be reached.
              </AlertDescription>
              <Button className="mt-3" onClick={() => void rootQuery.refetch()} size="sm">
                <RefreshCw /> Retry
              </Button>
            </Alert>
          </div>
        ) : (
          <WorkspaceBody
            agentName={agentName}
            editorOpen={editorOpen}
            explorerWidth={explorerWidth}
            onEditorOpenChange={setEditorOpen}
            reducedMotion={reducedMotion || resizing}
            root={rootQuery.data}
            setExplorerWidth={setExplorerWidth}
            workspaceWidth={workspaceWidth}
          />
        )}
      </div>
    </aside>
  )
}

function WorkspaceBody({
  agentName,
  editorOpen,
  explorerWidth,
  onEditorOpenChange,
  reducedMotion,
  root,
  setExplorerWidth,
  workspaceWidth,
}: {
  agentName: string
  editorOpen: boolean
  explorerWidth: number
  onEditorOpenChange: (open: boolean) => void
  reducedMotion: boolean
  root: string
  setExplorerWidth: React.Dispatch<React.SetStateAction<number>>
  workspaceWidth: number
}) {
  const queryClient = useQueryClient()
  const workspaceKey = `${agentName}:${root}`
  const {
    closeRoot,
    closeTab,
    deleteEntry,
    moveEntry,
    openTab,
    roots,
    setAgentDirty,
    setSelected,
  } = useFileWorkspace()
  const rootState = roots[workspaceKey]
  const [action, setAction] = React.useState<EntryAction | null>(null)
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({})
  const resize = React.useRef<{ startWidth: number; startX: number }>(null)
  const dirty = Object.values(drafts).some((draft) => draft.dirty)
  const selected = rootState?.selected ?? null
  const tabs = rootState?.tabs ?? []
  const openFile = React.useCallback(
    (tab: FileTab) => {
      openTab(workspaceKey, tab)
      onEditorOpenChange(true)
    },
    [onEditorOpenChange, openTab, workspaceKey]
  )
  const setSelectedDraft = React.useCallback(
    (draft: Draft) => {
      if (!selected) {
        return
      }
      setDrafts((current) => ({ ...current, [selected]: draft }))
    },
    [selected]
  )

  React.useEffect(() => {
    setAgentDirty(agentName, dirty)
  }, [agentName, dirty, setAgentDirty])

  React.useEffect(
    () => () => {
      setAgentDirty(agentName, false)
      closeRoot(workspaceKey)
    },
    [agentName, closeRoot, setAgentDirty, workspaceKey]
  )

  React.useEffect(() => {
    if (!dirty) {
      return
    }

    const guardLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      if (!(event.target instanceof Element)) {
        return
      }
      const link = event.target.closest("a")
      if (
        !link ||
        link.download ||
        link.target === "_blank" ||
        link.href === window.location.href
      ) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      const href = link.href
      setConfirmation({
        description: "Your unsaved file changes will be discarded.",
        label: "Leave page",
        onConfirm: () => window.location.assign(href),
        title: "Leave this page?",
      })
    }
    document.addEventListener("click", guardLink, true)
    const guardUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", guardUnload)

    return () => {
      document.removeEventListener("click", guardLink, true)
      window.removeEventListener("beforeunload", guardUnload)
    }
  }, [dirty])

  return (
    <div className="flex h-full min-h-0">
      <AnimatePresence initial={false}>
        {editorOpen ? (
          <motion.div
            animate={{ width: workspaceWidth - explorerWidth }}
            className="min-h-0 shrink-0 overflow-hidden"
            exit={{ width: 0 }}
            initial={{ width: 0 }}
            transition={{
              duration: reducedMotion ? 0 : 0.3,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <section
              className="bg-background flex h-full min-w-0 flex-col"
              style={{ width: workspaceWidth - explorerWidth }}
            >
              <div className="bg-muted/20 flex h-10 shrink-0 items-center overflow-hidden px-1.5">
                <div
                  aria-label="Open files"
                  className="flex min-w-0 flex-1 scrollbar-none gap-1 self-stretch overflow-x-auto py-1.5"
                  role="tablist"
                >
                  {tabs.map((tab) => (
                    <div
                      className="hover:bg-muted/50 data-[active=true]:bg-background group relative flex max-w-56 min-w-32 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors data-[active=true]:shadow-sm"
                      data-active={selected === tab.path}
                      key={tab.path}
                    >
                      <button
                        aria-selected={selected === tab.path}
                        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
                        onClick={() => setSelected(workspaceKey, tab.path)}
                        role="tab"
                        type="button"
                      >
                        <FileTypeIcon name={tab.name} />
                        <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                      </button>
                      {drafts[tab.path]?.dirty ? (
                        <span
                          aria-hidden="true"
                          className="bg-primary size-1.5 shrink-0 rounded-full"
                        />
                      ) : null}
                      <Button
                        aria-label={`Close ${tab.name}`}
                        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => {
                          const close = () => {
                            setDrafts((current) => {
                              const next = { ...current }
                              delete next[tab.path]
                              return next
                            })
                            closeTab(workspaceKey, tab.path)
                            if (tabs.length === 1) {
                              onEditorOpenChange(false)
                            }
                          }
                          if (drafts[tab.path]?.dirty) {
                            setConfirmation({
                              description: `Your unsaved changes to ${tab.name} will be discarded.`,
                              label: "Discard changes",
                              onConfirm: close,
                              title: `Close ${tab.name}?`,
                            })
                            return
                          }
                          close()
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Close editor"
                      className="shrink-0"
                      onClick={() => onEditorOpenChange(false)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <PanelRightClose />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Close editor</TooltipContent>
                </Tooltip>
              </div>
              <Separator />
              <div className="min-h-0 flex-1" role="tabpanel">
                {selected ? (
                  <EditorPane
                    agentName={agentName}
                    draft={drafts[selected]}
                    path={selected}
                    setDraft={setSelectedDraft}
                  />
                ) : (
                  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
                    <div className="bg-muted flex size-12 items-center justify-center rounded-2xl">
                      <Code2 className="size-5" />
                    </div>
                    Select a file to start editing
                  </div>
                )}
              </div>
            </section>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {editorOpen ? (
        <div
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          aria-valuemax={Math.min(520, workspaceWidth - 240)}
          aria-valuemin={220}
          aria-valuenow={explorerWidth}
          className="hover:bg-border focus-visible:bg-ring relative z-20 w-1 shrink-0 cursor-col-resize touch-none border-l transition-colors"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            const nextWidth = explorerWidth + (event.key === "ArrowLeft" ? 16 : -16)
            setExplorerWidth(
              Math.min(520, Math.max(220, Math.min(workspaceWidth - 240, nextWidth)))
            )
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            resize.current = {
              startWidth: explorerWidth,
              startX: event.clientX,
            }
          }}
          onPointerMove={(event) => {
            if (!resize.current) return
            const nextWidth = resize.current.startWidth + resize.current.startX - event.clientX
            setExplorerWidth(
              Math.min(520, Math.max(220, Math.min(workspaceWidth - 240, nextWidth)))
            )
          }}
          onPointerUp={(event) => {
            resize.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => {
            resize.current = null
          }}
          role="separator"
          tabIndex={0}
        />
      ) : null}

      <section className="flex min-h-0 shrink-0 flex-col" style={{ width: explorerWidth }}>
        <div className="flex h-10 shrink-0 items-center gap-1 px-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Explorer</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="New file"
                onClick={() => setAction({ kind: "file", parent: "." })}
                size="icon-sm"
                variant="ghost"
              >
                <FilePlus2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="New folder"
                onClick={() => setAction({ kind: "directory", parent: "." })}
                size="icon-sm"
                variant="ghost"
              >
                <FolderPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
          <Button
            aria-label="Refresh files"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: agentFilesQueryOptions(agentName, root, ".").queryKey.slice(0, 3),
              })
            }
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
        </div>
        <Separator />
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          <FileTree
            className="rounded-none border-0 bg-transparent font-sans"
            onSelect={(path) => openFile({ name: path.slice(path.lastIndexOf("/") + 1), path })}
            selectedPath={selected ?? undefined}
          >
            <DirectoryTree agentName={agentName} onAction={setAction} path="." root={root} />
          </FileTree>
        </div>
      </section>

      {action ? (
        <EntryDialog
          action={action}
          agentName={agentName}
          key={
            "entry" in action
              ? `${action.kind}:${action.entry.path}`
              : `${action.kind}:${action.parent}`
          }
          onClose={() => setAction(null)}
          onDelete={(path) => {
            setDrafts((current) => {
              const next = { ...current }
              const prefix = `${path}/`
              for (const draftPath of Object.keys(next)) {
                if (draftPath === path || draftPath.startsWith(prefix)) {
                  delete next[draftPath]
                }
              }
              return next
            })
            deleteEntry(workspaceKey, path)
          }}
          onRename={(path, target) => {
            setDrafts((current) => {
              const next = { ...current }
              const prefix = `${path}/`
              for (const [draftPath, draft] of Object.entries(current)) {
                if (draftPath === path) {
                  delete next[draftPath]
                  next[target] = draft
                } else if (draftPath.startsWith(prefix)) {
                  delete next[draftPath]
                  next[`${target}/${draftPath.slice(prefix.length)}`] = draft
                }
              }
              return next
            })
            moveEntry(workspaceKey, path, target)
          }}
          onOpen={(path) => openFile({ name: path.slice(path.lastIndexOf("/") + 1), path })}
          root={root}
        />
      ) : null}
      <Dialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmation(null)} variant="outline">
              Cancel
            </Button>
            <Button
              data-dialog-submit
              onClick={() => {
                confirmation?.onConfirm()
                setConfirmation(null)
              }}
              variant="destructive"
            >
              {confirmation?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DirectoryTree({ agentName, onAction, path, root }: DirectoryTreeProps) {
  const directoryQuery = useQuery(agentFilesQueryOptions(agentName, root, path))

  if (directoryQuery.isPending) {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm"
        role="status"
      >
        <Spinner className="size-3" /> Loading...
      </div>
    )
  }

  if (directoryQuery.isError) {
    return (
      <button
        className="text-destructive flex items-center gap-2 px-3 py-2 text-sm"
        onClick={() => void directoryQuery.refetch()}
        type="button"
      >
        <RefreshCw className="size-3" /> Retry directory
      </button>
    )
  }

  return directoryQuery.data
    .filter((entry) => !entry.ignored)
    .map((entry) => {
      const directory = entry.type === "directory"
      const entryPath = directory ? entry.path.slice(0, -1) : entry.path
      const menu = (
        <ContextMenuContent className="min-w-44">
          <ContextMenuGroup>
            <ContextMenuItem
              onSelect={() => {
                void navigator.clipboard
                  .writeText(entryPath)
                  .then(() => toast.success("Path copied"))
                  .catch(() => toast.error("Could not copy path"))
              }}
            >
              <Copy /> Copy path
            </ContextMenuItem>
            {directory ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onAction({ kind: "file", parent: entryPath })}>
                  <FilePlus2 /> New file
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => onAction({ kind: "directory", parent: entryPath })}
                >
                  <FolderPlus /> New folder
                </ContextMenuItem>
              </>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onAction({ kind: "rename", entry: { ...entry, path: entryPath } })}
            >
              <Pencil /> Rename
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onAction({ kind: "delete", entry: { ...entry, path: entryPath } })}
              variant="destructive"
            >
              <Trash2 /> Delete
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      )

      if (directory) {
        return (
          <ContextMenu key={entry.path}>
            <ContextMenuTrigger asChild>
              <FileTreeFolder
                name={entry.name}
                onContextMenu={(event) => event.stopPropagation()}
                path={entry.path}
              >
                <DirectoryTree
                  agentName={agentName}
                  onAction={onAction}
                  path={entry.path}
                  root={root}
                />
              </FileTreeFolder>
            </ContextMenuTrigger>
            {menu}
          </ContextMenu>
        )
      }

      return (
        <ContextMenu key={entry.path}>
          <ContextMenuTrigger asChild>
            <FileTreeFile
              icon={<FileTypeIcon name={entry.name} />}
              name={entry.name}
              onContextMenu={(event) => event.stopPropagation()}
              path={entry.path}
            />
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
      )
    })
}

function FileTypeIcon({ name }: { name: string }) {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()

  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension)) {
    return <FileImage className="text-primary size-4" />
  }
  if (["zip", "gz", "tgz", "rar", "7z"].includes(extension)) {
    return <FileArchive className="text-primary size-4" />
  }
  if (
    ["c", "cpp", "css", "go", "html", "java", "js", "jsx", "py", "rs", "tsx", "ts"].includes(
      extension
    )
  ) {
    return <FileCode2 className="text-primary size-4" />
  }
  if (["json", "jsonc", "toml", "yaml", "yml"].includes(extension)) {
    return <Braces className="text-primary size-4" />
  }

  return <File className="text-primary size-4" />
}

function EditorPane({
  agentName,
  draft,
  path,
  setDraft,
}: {
  agentName: string
  draft?: Draft
  path: string
  setDraft: (draft: Draft) => void
}) {
  const queryClient = useQueryClient()
  const draftRef = React.useRef(draft)
  const reducedMotion = useReducedMotion()
  const [preview, setPreview] = React.useState(false)
  const statQuery = useQuery({
    ...statAgentFileOptions({ path: { agentName }, query: { path } }),
    refetchInterval: 2_000,
  })
  const mediaType = statQuery.data?.media_type
  const image = mediaType?.startsWith("image/") === true && mediaType !== "image/svg+xml"
  const pdf = mediaType === "application/pdf"
  const readText = mediaType !== undefined && !image && !pdf
  const fileQuery = useQuery({
    ...readAgentFileOptions({ path: { agentName }, query: { path } }),
    enabled: readText,
    retry: (failures, error) => error.code !== "unsupported_media_type" && failures < 3,
  })
  const unsupportedText = fileQuery.isError && fileQuery.error.code === "unsupported_media_type"
  const text = readText && !unsupportedText
  const refetchFile = fileQuery.refetch
  const save = useMutation({
    ...writeAgentFileMutation(),
    onError: (error) => {
      const current = draftRef.current
      if (!current) {
        return
      }
      if (error.code === "file_version_conflict") {
        setDraft({ ...current, conflict: true })
        return
      }
      toast.error("Could not save file", { description: error.message })
    },
    onSuccess: (metadata, variables) => {
      const current = draftRef.current
      if (!current) {
        return
      }
      const saved = variables.body.content.replaceAll("\r\n", "\n")
      setDraft({
        ...current,
        conflict: false,
        dirty: current.content !== saved,
        version: metadata.version,
      })
      queryClient.setQueryData(
        readAgentFileQueryKey({ path: { agentName }, query: { path } }),
        (current) =>
          current
            ? {
                ...current,
                content: variables.body.content,
                modified_at: metadata.modified_at,
                version: metadata.version,
              }
            : current
      )
      queryClient.setQueryData(
        statAgentFileQueryKey({ path: { agentName }, query: { path } }),
        metadata
      )
      toast.success("File saved")
    },
  })

  React.useEffect(() => {
    draftRef.current = draft
  }, [draft])

  React.useEffect(() => {
    const file = fileQuery.data
    if (!file) {
      return
    }
    if (!draft || !draft.dirty) {
      if (
        draft?.content === file.content.replaceAll("\r\n", "\n") &&
        draft.truncated === file.truncated &&
        draft.version === file.version
      ) {
        return
      }
      setDraft({
        conflict: false,
        content: file.content.replaceAll("\r\n", "\n"),
        dirty: false,
        lineEnding: file.content.includes("\r\n") ? "\r\n" : "\n",
        truncated: file.truncated,
        version: file.version,
      })
      return
    }
    if (draft.version !== file.version && !draft.conflict) {
      setDraft({ ...draft, conflict: true })
    }
  }, [draft, fileQuery.data, setDraft])

  React.useEffect(() => {
    const version = statQuery.data?.version
    if (!version || !draft || version === draft.version) {
      return
    }
    if (draft.dirty) {
      if (!draft.conflict) {
        setDraft({ ...draft, conflict: true })
      }
      return
    }
    void refetchFile()
  }, [draft, refetchFile, setDraft, statQuery.data?.version])

  const filename = path.slice(path.lastIndexOf("/") + 1)
  const markdown = mediaType === "text/markdown" || /\.mdx?$/.test(filename)
  const json = mediaType === "application/json" || /\.jsonc?$/.test(filename)
  const html = mediaType === "text/html" || /\.html?$/.test(filename)
  const canPreview = markdown || json || html
  const saveDraft = (overwrite = false, version = draft?.version) => {
    if (!draft || !version || draft.truncated || save.isPending) {
      return
    }
    save.mutate({
      body: {
        content:
          draft.lineEnding === "\r\n" ? draft.content.replaceAll("\n", "\r\n") : draft.content,
        expected_version: version,
        overwrite,
        path,
      },
      path: { agentName },
    })
  }

  if (statQuery.isPending || (readText && fileQuery.isPending) || (text && !draft)) {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
        role="status"
      >
        <Spinner /> Loading {filename}...
      </div>
    )
  }

  if (statQuery.isError || (fileQuery.isError && !unsupportedText)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not open {filename}</AlertTitle>
          <AlertDescription className="mt-1">
            The file may have moved or become unavailable.
          </AlertDescription>
          <Button
            className="mt-3"
            onClick={() => {
              void statQuery.refetch()
              if (readText) void fileQuery.refetch()
            }}
            size="sm"
          >
            <RefreshCw /> Retry
          </Button>
        </Alert>
      </div>
    )
  }

  if (!text) {
    return (
      <BinaryPane
        agentName={agentName}
        filename={filename}
        image={image}
        previewable={image || pdf}
        path={path}
      />
    )
  }

  if (!draft) {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
        role="status"
      >
        <Spinner /> Loading {filename}...
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate px-1 font-mono text-xs">
          {path}
        </span>
        {canPreview ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={preview ? "Show source" : "Preview file"}
                onClick={() => setPreview((current) => !current)}
                size="icon-sm"
                variant={preview ? "secondary" : "ghost"}
              >
                {preview ? <Code2 /> : <Eye />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{preview ? "Show source" : "Preview"}</TooltipContent>
          </Tooltip>
        ) : null}
        <Button
          disabled={!draft.dirty || save.isPending || draft.truncated}
          onClick={() => saveDraft()}
          size="sm"
        >
          {save.isPending ? <Spinner /> : <Save />}
          Save
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Download file"
              onClick={() => {
                void readAgentFileRaw({
                  parseAs: "blob",
                  path: { agentName },
                  query: { path },
                  throwOnError: true,
                })
                  .then(({ data }) => {
                    const url = URL.createObjectURL(data)
                    const anchor = document.createElement("a")
                    anchor.href = url
                    anchor.download = filename
                    anchor.click()
                    URL.revokeObjectURL(url)
                  })
                  .catch(() => toast.error("Could not download file"))
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Download />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Copy file contents"
              onClick={() => void navigator.clipboard.writeText(draft.content)}
              size="icon-sm"
              variant="ghost"
            >
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
      </div>

      {draft.truncated ? (
        <Alert className="m-2 w-auto" variant="warning">
          <AlertTitle>Large file opened read-only</AlertTitle>
          <AlertDescription>
            The editor shows a truncated preview. Download the file to view it in full.
          </AlertDescription>
        </Alert>
      ) : null}

      {draft.conflict ? (
        <Alert className="m-2 w-auto" variant="warning">
          <AlertTitle>This file changed on disk</AlertTitle>
          <AlertDescription className="mt-1">
            Reload the agent version or explicitly overwrite it with your draft.
          </AlertDescription>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() =>
                void fileQuery.refetch().then((result) => {
                  if (result.data) {
                    setDraft({
                      conflict: false,
                      content: result.data.content.replaceAll("\r\n", "\n"),
                      dirty: false,
                      lineEnding: result.data.content.includes("\r\n") ? "\r\n" : "\n",
                      truncated: result.data.truncated,
                      version: result.data.version,
                    })
                  }
                })
              }
              size="sm"
              variant="outline"
            >
              Reload
            </Button>
            <Button
              onClick={() =>
                void statQuery.refetch().then((result) => {
                  if (result.data) {
                    saveDraft(true, result.data.version)
                  }
                })
              }
              size="sm"
            >
              Overwrite
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {preview && canPreview ? (
            <motion.div
              animate={{ opacity: 1 }}
              className="h-full overflow-auto"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="preview"
              transition={{ duration: reducedMotion ? 0 : 0.12 }}
            >
              {markdown ? (
                <MessageResponse className="mx-auto max-w-3xl px-8 py-6">
                  {draft.content}
                </MessageResponse>
              ) : json ? (
                <JSONPreview content={draft.content} />
              ) : html ? (
                <iframe
                  className="h-full w-full bg-white"
                  sandbox=""
                  srcDoc={draft.content}
                  title={`Preview of ${filename}`}
                />
              ) : null}
            </motion.div>
          ) : (
            <motion.div
              animate={{ opacity: 1 }}
              className="h-full"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="editor"
              transition={{ duration: reducedMotion ? 0 : 0.12 }}
            >
              <CodeEditor
                filename={filename}
                key={path}
                onChange={(content) => setDraft({ ...draft, content, dirty: true })}
                onSave={() => {
                  if (draft.dirty) {
                    saveDraft()
                  }
                }}
                readOnly={draft.truncated}
                value={draft.content}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function BinaryPane({
  agentName,
  filename,
  image,
  path,
  previewable,
}: {
  agentName: string
  filename: string
  image: boolean
  path: string
  previewable: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate px-1 font-mono text-xs">
          {path}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Download file"
              onClick={() => {
                void readAgentFileRaw({
                  parseAs: "blob",
                  path: { agentName },
                  query: { path },
                  throwOnError: true,
                })
                  .then(({ data }) => {
                    const url = URL.createObjectURL(data)
                    const anchor = document.createElement("a")
                    anchor.href = url
                    anchor.download = filename
                    anchor.click()
                    URL.revokeObjectURL(url)
                  })
                  .catch(() => toast.error("Could not download file"))
              }}
              size="icon-sm"
              variant="ghost"
            >
              <Download />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1">
        {previewable ? (
          <RawPreview agentName={agentName} filename={filename} image={image} path={path} />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <FileImage className="size-8" />
            Download {filename} to view it
          </div>
        )}
      </div>
    </div>
  )
}

function JSONPreview({ content }: { content: string }) {
  const formatted = React.useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }, [content])

  return (
    <pre className="min-h-full overflow-auto p-6 font-mono text-xs leading-5">
      <Braces className="text-muted-foreground mb-4 size-5" />
      {formatted}
    </pre>
  )
}

function RawPreview({
  agentName,
  filename,
  image,
  path,
}: {
  agentName: string
  filename: string
  image: boolean
  path: string
}) {
  const rawQuery = useQuery({
    ...readAgentFileRawOptions({ parseAs: "blob", path: { agentName }, query: { path } }),
    gcTime: 0,
  })
  const url = React.useMemo(
    () => (rawQuery.data ? URL.createObjectURL(rawQuery.data) : undefined),
    [rawQuery.data]
  )

  React.useEffect(() => {
    return () => {
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }, [url])

  if (rawQuery.isError) {
    return <p className="text-destructive p-6 text-sm">Could not load preview.</p>
  }

  if (rawQuery.isPending || !url) {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
        role="status"
      >
        <Spinner /> Loading preview...
      </div>
    )
  }

  return image ? (
    // eslint-disable-next-line @next/next/no-img-element -- object URLs are not supported by next/image.
    <img
      alt={`Preview of ${filename}`}
      className="h-full w-full object-contain p-6"
      height={1}
      src={url}
      width={1}
    />
  ) : (
    <iframe className="h-full w-full" src={url} title={`Preview of ${filename}`} />
  )
}

function EntryDialog({
  action,
  agentName,
  onClose,
  onDelete,
  onOpen,
  onRename,
  root,
}: {
  action: EntryAction
  agentName: string
  onClose: () => void
  onDelete: (path: string) => void
  onOpen: (path: string) => void
  onRename: (path: string, target: string) => void
  root: string
}) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState("entry" in action ? action.entry.name : "")
  const createFile = useMutation(createAgentFileMutation())
  const createDirectory = useMutation(createAgentDirectoryMutation())
  const rename = useMutation(renameAgentEntryMutation())
  const remove = useMutation(deleteAgentEntryMutation())
  const pending =
    createFile.isPending || createDirectory.isPending || rename.isPending || remove.isPending

  const label =
    action.kind === "file"
      ? "New file"
      : action.kind === "directory"
        ? "New folder"
        : action.kind === "rename"
          ? `Rename ${action.entry.name}`
          : `Delete ${action.entry.name}`

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {action.kind === "delete"
              ? "This permanently removes the entry and everything inside it."
              : "Paths are relative to the selected folder."}
          </DialogDescription>
        </DialogHeader>
        {action.kind !== "delete" ? (
          <Input
            aria-label={
              action.kind === "directory" ||
              (action.kind === "rename" && action.entry.type === "directory")
                ? "Folder name"
                : "File name"
            }
            autoFocus
            autoComplete="off"
            name="entry-name"
            onChange={(event) => setName(event.target.value)}
            placeholder={action.kind === "directory" ? "folder-name..." : "filename.ts…"}
            spellCheck={false}
            value={name}
          />
        ) : null}
        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            data-dialog-submit
            disabled={pending || (action.kind !== "delete" && !name.trim())}
            onClick={() => {
              if (action.kind === "file" || action.kind === "directory") {
                const path = action.parent === "." ? name.trim() : `${action.parent}/${name.trim()}`
                const directoryPath = action.parent === "." ? "." : `${action.parent}/`
                const mutation = action.kind === "file" ? createFile : createDirectory
                mutation.mutate(
                  { body: { path }, path: { agentName } },
                  {
                    onError: (error) => toast.error(label, { description: error.message }),
                    onSuccess: () => {
                      void queryClient.invalidateQueries({
                        queryKey: agentFilesQueryOptions(agentName, root, directoryPath).queryKey,
                      })
                      if (action.kind === "file") {
                        onOpen(path)
                      }
                      onClose()
                    },
                  }
                )
                return
              }

              if (action.kind === "rename") {
                const slash = action.entry.path.lastIndexOf("/")
                const target =
                  slash === -1 ? name.trim() : `${action.entry.path.slice(0, slash)}/${name.trim()}`
                rename.mutate(
                  {
                    body: { path: action.entry.path, target },
                    path: { agentName },
                  },
                  {
                    onError: (error) => toast.error(label, { description: error.message }),
                    onSuccess: () => {
                      void queryClient.invalidateQueries({
                        queryKey: agentFilesQueryOptions(
                          agentName,
                          root,
                          slash === -1 ? "." : `${action.entry.path.slice(0, slash)}/`
                        ).queryKey,
                      })
                      onRename(action.entry.path, target)
                      onClose()
                    },
                  }
                )
                return
              }

              const slash = action.entry.path.lastIndexOf("/")
              remove.mutate(
                { path: { agentName }, query: { path: action.entry.path } },
                {
                  onError: (error) => toast.error(label, { description: error.message }),
                  onSuccess: () => {
                    void queryClient.invalidateQueries({
                      queryKey: agentFilesQueryOptions(
                        agentName,
                        root,
                        slash === -1 ? "." : `${action.entry.path.slice(0, slash)}/`
                      ).queryKey,
                    })
                    onDelete(action.entry.path)
                    onClose()
                  },
                }
              )
            }}
            variant={action.kind === "delete" ? "destructive" : "default"}
          >
            {pending ? <Spinner /> : action.kind === "delete" ? <Trash2 /> : null}
            {action.kind === "delete" ? "Delete" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
