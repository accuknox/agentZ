"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Circle,
  Globe,
  Hand,
  MousePointer2,
  Plus,
  RefreshCw,
  Square,
  X,
  MoreHorizontal,
  ScanLine,
  PenLine,
  Download,
  Minimize2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import {
  runBrowser,
  type BrowserRequest,
  type BrowserTab,
  type BrowserArtifact,
  type BrowserDiagnostic,
} from "@/lib/gateway/client"
import { zBrowserStreamEvent } from "@/lib/gateway/client/zod.gen"
import {
  getGatewayBaseURL,
  getGatewayToken,
  gatewayAuthenticatedFetch,
} from "@/lib/gateway/browser-runtime"
import { useFileWorkspace } from "./file-workspace-store"

export function Browser({
  agentName,
  sessionId,
  workspaceId,
  visible,
  floating,
  onFloatingChange: setFloating,
}: {
  agentName: string
  sessionId: string
  workspaceId: string
  visible: boolean
  floating: boolean
  onFloatingChange: (floating: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { addBrowserContext } = useFileWorkspace()
  const key = ["browser", workspaceId, agentName, sessionId]
  const [viewer] = useState(() => crypto.randomUUID())
  const [selected, setSelected] = useState<string>()
  const [profileOverride, setProfile] = useState<string>()
  const [viewportDialog, setViewportDialog] = useState(false)
  const viewportWidth = useRef<HTMLInputElement>(null)
  const viewportHeight = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const sentKey = useRef(false)
  const [address, setAddress] = useState("")
  const [editingAddress, setEditingAddress] = useState(false)
  const touch = useRef<{ x: number; y: number; moved: boolean }>(null)
  const [connected, setConnected] = useState(false)
  const [control, setControl] = useState(false)
  const [pick, setPick] = useState(false)
  const [annotating, setAnnotating] = useState(false)
  const [annotationText, setAnnotationText] = useState("")
  const [profileDialog, setProfileDialog] = useState<"create" | "rename" | null>(null)
  const [profileName, setProfileName] = useState("")
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostic[] | null>(null)
  const annotation = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<BrowserTab>()
  const socket = useRef<WebSocket>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const query = useQuery(
    queryOptions({
      queryKey: key,
      queryFn: async ({ signal }) => {
        const { data } = await runBrowser({
          path: { agentName, sessionId },
          body: { operation: "status" },
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
          throwOnError: true,
        })
        return data
      },
      enabled: visible,
      refetchInterval: visible ? 3000 : false,
      retry: false,
    })
  )
  const profile = profileOverride ?? query.data?.defaultProfileId ?? "default"
  const current = query.data?.tabs.find((tab) => tab.id === selected) ?? query.data?.tabs[0]
  const tab = live?.id === current?.id ? live : current
  const tabId = tab?.id
  const [lastTab, setLastTab] = useState(tabId)
  if (lastTab !== tabId) {
    setLastTab(tabId)
    setLive(undefined)
    setControl(false)
    setAddress("")
    setEditingAddress(false)
    setAnnotationText("")
  }
  useEffect(() => {
    drawing.current = false
    const layer = annotation.current
    layer?.getContext("2d")?.clearRect(0, 0, layer.width, layer.height)
  }, [tabId])
  const endpoint = `/api/agent/${encodeURIComponent(agentName)}/browser/${encodeURIComponent(sessionId)}`

  async function download(file: BrowserArtifact) {
    const base = await getGatewayBaseURL()
    const response = await gatewayAuthenticatedFetch(`${base}${endpoint}?artifact=${file.id}`, {
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
    })
    if (!response.ok) throw new Error("Browser download is unavailable")
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement("a")
    link.href = url
    link.download = file.fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  async function action(body: BrowserRequest) {
    setBusy(true)
    try {
      if (body.operation === "open") {
        const bounds = viewport.current?.getBoundingClientRect()
        if (bounds)
          body = {
            width: Math.max(240, Math.floor(bounds.width - 16)),
            height: Math.max(240, Math.min(2160, Math.floor(bounds.height - 16))),
            ...body,
          }
      }
      const { data, error } = await runBrowser({
        path: { agentName, sessionId },
        query: { viewer },
        body: { tabId, ...body },
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
      })
      if (error) throw new Error(error.message)
      queryClient.setQueryData(key, data)
      if (data.tabId) setSelected(data.tabId)
      if (data.artifact) await download(data.artifact)

      return data
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Browser action failed")
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const receive = useEffectEvent(
    (connection: WebSocket, event: MessageEvent<string | ArrayBuffer>) => {
      if (connection !== socket.current) return
      if (typeof event.data === "string") {
        const message = zBrowserStreamEvent.parse(JSON.parse(event.data))
        if (message.type === "error") {
          toast.error(message.message)
          return
        }
        setLive(message.state)
        setControl(message.canOperate)
        return
      }
      void createImageBitmap(new Blob([event.data], { type: "image/jpeg" })).then((image) => {
        const target = canvas.current
        if (connection !== socket.current) {
          image.close()
          return
        }
        if (target) {
          if (
            annotation.current &&
            (annotation.current.width !== image.width || annotation.current.height !== image.height)
          ) {
            annotation.current.width = image.width
            annotation.current.height = image.height
          }
          target.width = image.width
          target.height = image.height
          target.getContext("2d")?.drawImage(image, 0, 0)
        }
        image.close()
        if (connection.readyState === WebSocket.OPEN)
          connection.send(JSON.stringify({ type: "ack" }))
      })
    }
  )

  useEffect(() => {
    if (!visible || !tabId) return
    const abort = new AbortController()
    let ws: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    async function connect() {
      try {
        const [base, token] = await Promise.all([getGatewayBaseURL(), getGatewayToken(workspaceId)])
        if (abort.signal.aborted) return
        const url = new URL(endpoint, base)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        url.search = new URLSearchParams({ tabId: tabId ?? "", viewer }).toString()
        const connection = new WebSocket(url, ["agentz.pty", `agentz.bearer.${token}`])
        ws = connection
        ws.binaryType = "arraybuffer"
        socket.current = ws
        ws.onopen = () => setConnected(true)
        ws.onmessage = (event) => receive(connection, event)
        ws.onclose = () => {
          setConnected(false)
          setControl(false)
          if (!abort.signal.aborted) retry = setTimeout(() => void connect(), 2000)
        }
      } catch (error) {
        if (!abort.signal.aborted)
          toast.error(error instanceof Error ? error.message : "Browser connection failed")
      }
    }
    void connect()
    return () => {
      abort.abort()
      clearTimeout(retry)
      ws?.close()
      socket.current = null
    }
  }, [visible, tabId, viewer, endpoint, workspaceId])

  function take() {
    socket.current?.send(JSON.stringify({ type: control ? "releaseControl" : "takeControl" }))
    canvas.current?.focus()
  }

  async function clipboard(cut: boolean) {
    const data = await action({
      operation: "evaluate",
      expression: `(() => {
        const element = document.activeElement;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const start = element.selectionStart ?? 0, end = element.selectionEnd ?? 0;
          return element.value.slice(start, end);
        }
        return window.getSelection()?.toString() ?? "";
      })()`,
    })
    if (typeof data?.value === "string") {
      try {
        await navigator.clipboard.writeText(data.value)
        if (cut && data.value) await action({ operation: "press", key: "ControlOrMeta+X" })
      } catch {
        toast.error("Clipboard access was denied")
      }
    }
  }

  return (
    <section
      aria-label="Browser"
      className={
        floating
          ? "fixed right-5 bottom-5 z-40 flex h-[min(65vh,650px)] w-[min(90vw,780px)] resize flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "flex h-full min-h-0 flex-col bg-background"
      }
    >
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 pt-2 pb-1.5">
        {query.data?.tabs.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex max-w-48 min-w-24 items-center rounded-md transition-colors",
              item.id === tabId
                ? "bg-background shadow-xs ring-1 ring-border/70"
                : "text-muted-foreground hover:bg-muted/60"
            )}
          >
            <Button
              variant={item.id === tabId ? "secondary" : "ghost"}
              size="sm"
              className="min-w-0 flex-1 truncate"
              onClick={() => {
                setSelected(item.id)
                setAddress(item.url)
              }}
            >
              {item.loading ? (
                <Spinner className="size-3 shrink-0" />
              ) : (
                <Globe className="size-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{item.title || "New tab"}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close tab"
              disabled={item.id !== tabId || !control}
              onClick={() => void action({ operation: "close", tabId: item.id })}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          title="New tab"
          disabled={busy}
          onClick={() =>
            void action({ operation: "open", reuseExistingTab: false, profileId: profile })
          }
        >
          <Plus />
        </Button>
      </div>
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault()
          setEditingAddress(false)
          void action({ operation: tabId ? "navigate" : "open", url: address, profileId: profile })
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!tabId || !control}
          onClick={() => void action({ operation: "history", delta: -1 })}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!tabId || !control}
          onClick={() => void action({ operation: "history", delta: 1 })}
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tab?.loading ? "Stop loading" : "Reload"}
          disabled={!tabId || !control}
          onClick={() => void action({ operation: tab?.loading ? "stopLoading" : "reload" })}
        >
          {tab?.loading ? <X /> : <RefreshCw />}
        </Button>
        <Input
          aria-label="Website address"
          className="h-8 border-transparent bg-muted/50 text-xs shadow-none focus-visible:bg-background"
          value={editingAddress ? address : tab?.url === "about:blank" ? "" : (tab?.url ?? address)}
          placeholder="Enter a website address"
          onFocus={() => {
            setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? address))
            setEditingAddress(true)
          }}
          onBlur={() => setEditingAddress(false)}
          onChange={(event) => {
            setEditingAddress(true)
            setAddress(event.target.value)
          }}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Navigate"
          disabled={busy || (!!tabId && !control)}
        >
          <Globe />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Browser settings"
              title="Browser settings"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!tabId || !control}
              onSelect={() => void action({ operation: "reload", ignoreCache: true })}
            >
              Hard reload
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFloating(!floating)}>
              {floating ? "Dock browser" : "Float browser"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!tabId || busy}
              onSelect={() =>
                void action({ operation: "snapshot" }).then((result) => {
                  if (result) setDiagnostics(result.diagnostics ?? [])
                })
              }
            >
              Page diagnostics
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Shared profiles</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[70vh] overflow-y-auto">
                {query.data?.profiles.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={() => {
                      setProfile(item.id)
                      void action({ operation: "setDefaultProfile", profileId: item.id })
                    }}
                  >
                    {profile === item.id ? "✓ " : ""}
                    {item.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onSelect={() => {
                    setProfileName("")
                    setProfileDialog("create")
                  }}
                >
                  Create profile
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={profile === "default" || profile === "incognito"}
                  onSelect={() => {
                    setProfileName(
                      query.data?.profiles.find((item) => item.id === profile)?.name ?? ""
                    )
                    setProfileDialog("rename")
                  }}
                >
                  Rename profile
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={profile === "default" || profile === "incognito"}
                  onSelect={() =>
                    void action({ operation: "deleteProfile", profileId: profile }).then(() =>
                      setProfile("default")
                    )
                  }
                >
                  Delete profile
                </DropdownMenuItem>

                <DropdownMenuItem
                  onSelect={() => void action({ operation: "clearCookies", profileId: profile })}
                >
                  Clear cookies
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void action({ operation: "clearCache", profileId: profile })}
                >
                  Clear cache
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void action({ operation: "clearProfile", profileId: profile })}
                >
                  Reset profile data
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!control}>Viewport</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[70vh] overflow-y-auto">
                <DropdownMenuItem
                  disabled={!tabId}
                  onSelect={() => {
                    const rect = viewport.current?.getBoundingClientRect()
                    if (rect)
                      void action({
                        operation: "resize",
                        mode: "fill",
                        width: Math.max(240, Math.min(3840, Math.floor(rect.width - 16))),
                        height: Math.max(240, Math.min(2160, Math.floor(rect.height - 16))),
                      })
                  }}
                >
                  Fit panel
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!tabId} onSelect={() => setViewportDialog(true)}>
                  Custom viewport
                </DropdownMenuItem>
                {query.data?.presets?.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    onSelect={() =>
                      void action({ operation: "resize", mode: "preset", preset: preset.id })
                    }
                  >
                    {preset.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onSelect={() =>
                    void action({
                      operation: "resize",
                      mode: "freeform",
                      width: tab?.height ?? 800,
                      height: tab?.width ?? 1280,
                    })
                  }
                >
                  Rotate viewport
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!control}>Appearance</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {(["system", "light", "dark"] as const).map((colorScheme) => (
                  <DropdownMenuItem
                    key={colorScheme}
                    onSelect={() => void action({ operation: "setColorScheme", colorScheme })}
                  >
                    {colorScheme} appearance
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              disabled={!control}
              onSelect={() =>
                void action({ operation: "resize", zoom: Math.min(5, (tab?.zoom ?? 1) + 0.25) })
              }
            >
              Zoom in
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!control}
              onSelect={() =>
                void action({ operation: "resize", zoom: Math.max(0.25, (tab?.zoom ?? 1) - 0.25) })
              }
            >
              Zoom out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>
      {query.isError ? (
        <Alert variant="destructive" className="m-3 w-auto">
          <AlertDescription>
            Browser unavailable. Check agent readiness and try again.
          </AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {tab?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{tab.error}</AlertDescription>
        </Alert>
      ) : null}
      {tab?.dialog ? (
        <div className="space-y-2 border-b p-3">
          <p className="text-sm">{tab.dialog.message}</p>
          <Input ref={input} aria-label="Dialog answer" defaultValue={tab.dialog.defaultValue} />
          <Button
            size="sm"
            onClick={() =>
              void action({ operation: "dialog", accept: true, promptText: input.current?.value })
            }
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void action({ operation: "dialog", accept: false })}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <div
        ref={viewport}
        className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/20 p-2"
      >
        {!tabId ? (
          <div className="m-auto flex max-w-64 flex-col items-center gap-4 py-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border bg-background shadow-xs">
              <Globe className="size-6 text-muted-foreground" />
            </div>
            <div>
              <h3 className="mb-1.5 text-sm font-medium">Browse together</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open a website or ask your agent to browse. Website logins are shared across this
                agent.
              </p>
            </div>
            {query.isPending ? (
              <Spinner />
            ) : (
              <Button onClick={() => void action({ operation: "open", profileId: profile })}>
                Open browser
              </Button>
            )}
          </div>
        ) : (
          <div className="relative inline-flex max-w-full self-start">
            <canvas
              ref={canvas}
              tabIndex={0}
              aria-label="Live browser page"
              className="h-auto max-w-full touch-none self-start border bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const x = ((event.clientX - rect.left) * (tab?.width ?? 1280)) / rect.width
                const y = ((event.clientY - rect.top) * (tab?.height ?? 800)) / rect.height
                if (annotating) {
                  drawing.current = true
                  event.currentTarget.setPointerCapture(event.pointerId)
                  const brush = annotation.current?.getContext("2d")
                  if (brush) {
                    brush.beginPath()
                    brush.moveTo(
                      ((event.clientX - rect.left) * event.currentTarget.width) / rect.width,
                      ((event.clientY - rect.top) * event.currentTarget.height) / rect.height
                    )
                    brush.strokeStyle = "#ef4444"
                    brush.lineWidth = 5
                    brush.lineCap = "round"
                  }
                  return
                }
                if (pick) {
                  void action({ operation: "pick", x, y }).then((data) => {
                    if (data)
                      addBrowserContext(
                        sessionId,
                        `Element from ${tab?.url}\n${JSON.stringify(data.value)}`
                      )
                  })
                  setPick(false)
                  return
                }
                if (!control) return
                textInput.current?.focus({ preventScroll: true })
                event.currentTarget.setPointerCapture(event.pointerId)
                if (event.pointerType === "touch") {
                  touch.current = { x: event.clientX, y: event.clientY, moved: false }
                  return
                }
                socket.current?.send(
                  JSON.stringify({
                    type: "mouse",
                    action: "down",
                    x,
                    y,
                    button: event.button === 2 ? "right" : "left",
                  })
                )
              }}
              onPointerMove={(event) => {
                if (annotating) {
                  if (!drawing.current) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  const brush = annotation.current?.getContext("2d")
                  brush?.lineTo(
                    ((event.clientX - rect.left) * event.currentTarget.width) / rect.width,
                    ((event.clientY - rect.top) * event.currentTarget.height) / rect.height
                  )
                  brush?.stroke()
                  return
                }
                if (!control) return
                if (event.pointerType === "touch" && touch.current) {
                  const previous = touch.current
                  const deltaX = previous.x - event.clientX
                  const deltaY = previous.y - event.clientY
                  if (Math.abs(deltaX) + Math.abs(deltaY) > 3 || previous.moved) {
                    socket.current?.send(JSON.stringify({ type: "wheel", deltaX, deltaY }))
                    touch.current = { x: event.clientX, y: event.clientY, moved: true }
                  }
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                socket.current?.send(
                  JSON.stringify({
                    type: "mouse",
                    action: "move",
                    x: ((event.clientX - rect.left) * (tab?.width ?? 1280)) / rect.width,
                    y: ((event.clientY - rect.top) * (tab?.height ?? 800)) / rect.height,
                  })
                )
              }}
              onPointerUp={(event) => {
                if (annotating) {
                  drawing.current = false
                  return
                }
                if (!control) return
                if (event.pointerType === "touch") {
                  const gesture = touch.current
                  touch.current = null
                  if (gesture?.moved) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  const point = {
                    type: "mouse",
                    x: ((event.clientX - rect.left) * (tab?.width ?? 1280)) / rect.width,
                    y: ((event.clientY - rect.top) * (tab?.height ?? 800)) / rect.height,
                  }
                  socket.current?.send(JSON.stringify({ ...point, action: "down", button: "left" }))
                }
                const rect = event.currentTarget.getBoundingClientRect()
                socket.current?.send(
                  JSON.stringify({
                    type: "mouse",
                    action: "up",
                    x: ((event.clientX - rect.left) * (tab?.width ?? 1280)) / rect.width,
                    y: ((event.clientY - rect.top) * (tab?.height ?? 800)) / rect.height,
                    button: event.button === 2 ? "right" : "left",
                  })
                )
              }}
              onPointerCancel={() => {
                touch.current = null
                drawing.current = false
                if (control) socket.current?.send(JSON.stringify({ type: "resetInput" }))
              }}
              onContextMenu={(event) => event.preventDefault()}
              onWheel={(event) => {
                if (control)
                  socket.current?.send(
                    JSON.stringify({ type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY })
                  )
              }}
            />
            <canvas
              ref={annotation}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            {tab?.cursor && !control ? (
              <MousePointer2
                aria-hidden
                className="pointer-events-none absolute size-5 text-primary drop-shadow"
                style={{
                  left: `${(100 * tab.cursor.x) / tab.width}%`,
                  top: `${(100 * tab.cursor.y) / tab.height}%`,
                }}
              />
            ) : null}
            <textarea
              ref={textInput}
              aria-label="Browser keyboard input"
              title="Press Shift+Escape to leave the browser page."
              defaultValue="​"
              onFocus={(event) => {
                event.currentTarget.value = "​"
              }}
              className="absolute top-0 left-0 size-px text-base opacity-0"
              disabled={!control}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (!control || composing.current || event.nativeEvent.isComposing) return
                if (event.key === "Escape" && event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.blur()
                  canvas.current?.focus()
                  return
                }
                if (
                  (event.ctrlKey || event.metaKey) &&
                  ["c", "v", "x"].includes(event.key.toLowerCase())
                )
                  return
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
                  return
                event.preventDefault()
                sentKey.current = event.key === "Backspace" || event.key === "Delete"
                socket.current?.send(
                  JSON.stringify({ type: "key", action: "down", key: event.key })
                )
              }}
              onKeyUp={(event) => {
                if (control && !composing.current)
                  socket.current?.send(
                    JSON.stringify({ type: "key", action: "up", key: event.key })
                  )
              }}
              onInput={(event) => {
                if (!control || composing.current) return
                const native = event.nativeEvent
                if (native instanceof InputEvent && native.isComposing) return
                if (sentKey.current) sentKey.current = false
                else if (
                  native instanceof InputEvent &&
                  ["deleteContentBackward", "deleteContentForward"].includes(native.inputType)
                ) {
                  const key = native.inputType === "deleteContentBackward" ? "Backspace" : "Delete"
                  socket.current?.send(JSON.stringify({ type: "key", action: "down", key }))
                  socket.current?.send(JSON.stringify({ type: "key", action: "up", key }))
                } else {
                  const text = event.currentTarget.value.replace(/^\u200b/, "")
                  if (text) socket.current?.send(JSON.stringify({ type: "text", text }))
                }
                event.currentTarget.value = "​"
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={(event) => {
                composing.current = false
                if (control && event.data)
                  socket.current?.send(JSON.stringify({ type: "text", text: event.data }))
                event.currentTarget.value = "​"
              }}
              onPaste={(event) => {
                if (control) {
                  event.preventDefault()
                  socket.current?.send(
                    JSON.stringify({
                      type: "text",
                      text: event.clipboardData.getData("text/plain"),
                    })
                  )
                }
              }}
              onCopy={(event) => {
                if (!control) return
                event.preventDefault()
                void clipboard(false)
              }}
              onCut={(event) => {
                if (!control) return
                event.preventDefault()
                void clipboard(true)
              }}
              onBlur={() => {
                if (control && socket.current?.readyState === WebSocket.OPEN)
                  socket.current.send(JSON.stringify({ type: "resetInput" }))
              }}
            />
          </div>
        )}
      </div>
      {tab?.fileChooser && control ? (
        <label className="border-t p-3 text-xs">
          Choose a file
          <input
            type="file"
            multiple
            onChange={(event) => {
              const files = event.target.files
              if (!files?.length) return
              if (
                files.length > 20 ||
                Array.from(files).reduce((bytes, file) => bytes + file.size, 0) > 50 * 1024 * 1024
              ) {
                toast.error("Choose at most 20 files totalling 50 MiB")
                return
              }
              const form = new FormData()
              for (const file of files) form.append("files", file, file.name)
              void getGatewayBaseURL()
                .then((base) =>
                  gatewayAuthenticatedFetch(
                    `${base}${endpoint}?${new URLSearchParams({ viewer, tabId: tabId ?? "" })}`,
                    {
                      method: "PUT",
                      headers: {
                        "X-AgentZ-Workspace-ID": workspaceId,
                      },
                      body: form,
                    }
                  )
                )
                .then((response) => {
                  if (!response.ok) toast.error("Upload failed")
                })
            }}
          />
        </label>
      ) : null}
      {query.data?.downloads?.length ? (
        <div className="flex max-h-24 shrink-0 flex-wrap gap-1 overflow-auto border-t p-2">
          {query.data.downloads.map((file) => (
            <Button
              key={file.id}
              variant="ghost"
              size="sm"
              onClick={() =>
                void download(file).catch(() => toast.error("Browser download is unavailable"))
              }
            >
              <Download />
              {file.fileName}
            </Button>
          ))}
        </div>
      ) : null}
      {annotating ? (
        <div className="flex items-center gap-2 border-t p-2">
          <Input
            aria-label="Annotation note"
            placeholder="Add a note, then attach the screenshot"
            value={annotationText}
            onChange={(event) => setAnnotationText(event.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const layer = annotation.current
              layer?.getContext("2d")?.clearRect(0, 0, layer.width, layer.height)
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <footer className="flex shrink-0 items-center gap-1 border-t p-2 text-xs text-muted-foreground">
        {floating ? (
          <Button
            aria-label="Dock browser"
            variant="ghost"
            size="icon-sm"
            onClick={() => setFloating(false)}
          >
            <Minimize2 />
          </Button>
        ) : null}
        <span className="mr-auto flex min-w-0 items-center gap-1.5" role="status">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              connected ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
          />
          {!tabId
            ? "Browser"
            : connected
              ? control
                ? "You are in control"
                : tab?.owner === "human"
                  ? "Another viewer is in control"
                  : "Agent in control"
              : "Connecting…"}
        </span>
        <Button
          size="icon-sm"
          variant={pick ? "secondary" : "ghost"}
          aria-label="Pick element"
          title="Pick element"
          disabled={!tabId}
          onClick={() => setPick(!pick)}
        >
          <MousePointer2 />
        </Button>
        <Button
          size="icon-sm"
          variant={annotating ? "secondary" : "ghost"}
          aria-label="Annotate screenshot"
          title="Annotate screenshot"
          disabled={!tabId}
          onClick={() => {
            setAnnotating(!annotating)
            setPick(false)
          }}
        >
          <PenLine />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Add screenshot to chat"
          title="Add screenshot to chat"
          disabled={!tabId}
          onClick={() => {
            const page = canvas.current
            if (!page) return
            const capture = document.createElement("canvas")
            capture.width = page.width
            capture.height = page.height
            const brush = capture.getContext("2d")
            brush?.drawImage(page, 0, 0)
            if (annotation.current) brush?.drawImage(annotation.current, 0, 0)
            addBrowserContext(
              sessionId,
              [`Browser screenshot: ${tab?.url}`, annotationText].filter(Boolean).join("\n"),
              capture.toDataURL("image/png")
            )
          }}
        >
          <ScanLine />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Save screenshot"
          title="Save screenshot"
          disabled={!tabId}
          onClick={() => void action({ operation: "snapshot", save: true })}
        >
          <Camera />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={tab?.recording ? "Stop recording" : "Start recording"}
          disabled={!tabId || !control}
          onClick={() =>
            void action({ operation: tab?.recording ? "recordingStop" : "recordingStart" })
          }
        >
          {tab?.recording ? <Square className="text-destructive" /> : <Circle />}
        </Button>
        <Button
          size="sm"
          variant={control ? "secondary" : "default"}
          disabled={!connected}
          onClick={take}
        >
          <Hand />
          {control ? "Return control" : "Take control"}
        </Button>
      </footer>
      <Dialog open={viewportDialog} onOpenChange={setViewportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Browser viewport</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void action({
                operation: "resize",
                mode: "freeform",
                width: viewportWidth.current?.valueAsNumber,
                height: viewportHeight.current?.valueAsNumber,
              }).then((result) => {
                if (result) setViewportDialog(false)
              })
            }}
          >
            <div className="flex gap-3">
              <label className="text-sm">
                Width
                <Input
                  ref={viewportWidth}
                  type="number"
                  min={240}
                  max={3840}
                  defaultValue={tab?.width ?? 1280}
                  required
                />
              </label>
              <label className="text-sm">
                Height
                <Input
                  ref={viewportHeight}
                  type="number"
                  min={240}
                  max={3840}
                  defaultValue={tab?.height ?? 800}
                  required
                />
              </label>
            </div>
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy}>
                Resize
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={diagnostics !== null} onOpenChange={() => setDiagnostics(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Page diagnostics</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-auto">
            {diagnostics?.length ? (
              diagnostics.map((entry, index) => (
                <div key={index} className="space-y-1 rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">
                    {entry.kind} · {new Date(entry.timestamp).toLocaleTimeString()}
                  </p>
                  <pre className="text-xs break-all whitespace-pre-wrap">{entry.text}</pre>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No console or network activity recorded.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={profileDialog !== null}
        onOpenChange={(open) => {
          if (!open) setProfileDialog(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {profileDialog === "rename" ? "Rename browser profile" : "New browser profile"}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void action({
                operation: profileDialog === "rename" ? "renameProfile" : "createProfile",
                profileId: profile,
                name: profileName,
              }).then((result) => {
                if (result) setProfileDialog(null)
              })
            }}
          >
            <Input
              aria-label="Profile name"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              maxLength={48}
              autoFocus
            />
            <p className="my-3 text-sm text-muted-foreground">
              This profile and its website logins are shared with everyone using the agent.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setProfileDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !profileName.trim()}>
                Save profile
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
