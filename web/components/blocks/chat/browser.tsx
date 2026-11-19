"use client"

import { useEffect, useEffectEvent, useRef, useState, type ComponentProps } from "react"
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Link2,
  Unlink2,
  PanelTop,
  Circle,
  Globe,
  Hand,
  MousePointer2,
  MousePointerClick,
  Plus,
  RefreshCw,
  Square,
  X,
  MoreHorizontal,
  ScanLine,
  Download,
  Check,
  CircleUserRound,
  Cookie,
  Eraser,
  ExternalLink,
  Monitor,
  Moon,
  Pencil,
  RotateCcw,
  RotateCw,
  Smartphone,
  SquareDashed,
  Sun,
  Trash2,
  Users,
  VenetianMask,
  ZoomIn,
  ZoomOut,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import {
  runBrowser,
  type BrowserResult,
  type BrowserInput,
  type BrowserRequest,
  type BrowserTab,
  type BrowserArtifact,
} from "@/lib/gateway/client"
import { zBrowserStreamEvent } from "@/lib/gateway/client/zod.gen"
import {
  getGatewayBaseURL,
  getGatewayToken,
  gatewayAuthenticatedFetch,
} from "@/lib/gateway/browser-runtime"
import { useFileWorkspace } from "./file-workspace-store"
import { BrowserWindow } from "./browser-window"

export function Browser({
  agentName,
  sessionId,
  workspaceId,
  visible,
  query,
  floating,
  reveal,
  onFloatingChange: setFloating,
  onClosePreview,
}: {
  agentName: string
  sessionId: string
  workspaceId: string
  visible: boolean
  query: UseQueryResult<BrowserResult>
  floating: boolean
  reveal?: Pick<BrowserTab, "id" | "reveal">
  onFloatingChange: (floating: boolean, tabId?: string) => void
  onClosePreview: () => void
}) {
  const queryClient = useQueryClient()
  const { addBrowserContext } = useFileWorkspace()
  const key = ["browser", workspaceId, agentName, sessionId]
  const [viewer] = useState(() => crypto.randomUUID())
  const [selected, setSelected] = useState<string | undefined>(reveal?.id)
  const [lastReveal, setLastReveal] = useState(reveal)
  if (reveal && reveal !== lastReveal) {
    setLastReveal(reveal)
    setSelected(reveal.id)
  }
  const [viewportDialog, setViewportDialog] = useState(false)
  const viewportWidth = useRef<HTMLInputElement>(null)
  const viewportHeight = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const clicks = useRef(1)
  const [address, setAddress] = useState("")
  const [editingAddress, setEditingAddress] = useState(false)
  const touch = useRef<{ x: number; y: number; moved: boolean }>(null)
  const [connected, setConnected] = useState(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [streamError, setStreamError] = useState<string>()
  const [reconnect, setReconnect] = useState(0)
  const [deviceToolbar, setDeviceToolbar] = useState(false)
  const [aspectLocked, setAspectLocked] = useState(false)
  const [fitPanel, setFitPanel] = useState(false)
  const [picking, setPicking] = useState(false)
  const pickingGesture = useRef(false)
  const forwardedKeys = useRef(new Set<string>())
  const [control, setControl] = useState(false)
  const [profileDialog, setProfileDialog] = useState<"create" | "rename" | null>(null)
  const [profileName, setProfileName] = useState("")
  const [busy, setBusy] = useState(false)
  const pendingActions = useRef(0)
  const socket = useRef<WebSocket>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const profile = query.data?.defaultProfileId ?? "default"
  const tab = query.data?.tabs.find((tab) => tab.id === selected) ?? query.data?.tabs[0]
  const tabId = tab?.id
  let url = tab?.url ?? address
  if (tab?.url === "about:blank") url = ""
  if (editingAddress) url = address
  const canNavigate = !!url.trim() && !busy && (!tabId || control)
  const [downloadShelf, setDownloadShelf] = useState<{
    source: BrowserArtifact[] | undefined
    files: BrowserArtifact[]
  }>({ source: query.data?.downloads, files: [] })
  if (downloadShelf.source !== query.data?.downloads || (!visible && downloadShelf.files.length)) {
    const previous = new Set(downloadShelf.source?.map((file) => file.id))
    const available = new Set(query.data?.downloads?.map((file) => file.id))
    // Status includes old artifacts. Only new arrivals belong in this
    // temporary shelf; reopening the panel starts with no download history.
    const added = downloadShelf.source
      ? (query.data?.downloads?.filter((file) => !previous.has(file.id)) ?? [])
      : []
    setDownloadShelf({
      source: query.data?.downloads,
      files: visible
        ? [...downloadShelf.files.filter((file) => available.has(file.id)), ...added]
        : [],
    })
  }
  const downloads = downloadShelf.files
  const [lastView, setLastView] = useState({ tabId, visible, reconnect })
  if (
    lastView.tabId !== tabId ||
    lastView.visible !== visible ||
    lastView.reconnect !== reconnect
  ) {
    setLastView({ tabId, visible, reconnect })
    setConnected(false)
    setHasFrame(false)
    setControl(false)
    setStreamError(undefined)
    setPicking(false)
    if (lastView.tabId !== tabId) {
      setAddress("")
      setEditingAddress(false)
    }
  }
  useEffect(() => {
    if (control && tab?.url === "about:blank") addressInput.current?.focus()
  }, [tabId, control, tab?.url])
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

  function send(input: BrowserInput) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(input))
  }

  async function action(body: BrowserRequest) {
    pendingActions.current++
    setBusy(true)
    if (body.operation === "resize" && body.mode) setFitPanel(body.mode === "fill")
    try {
      if (body.operation === "open") {
        const bounds = viewport.current?.getBoundingClientRect()
        if (bounds)
          body = {
            width: Math.max(240, Math.min(3840, Math.floor(bounds.width - 16))),
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
      const updated = data.tabs.find((item) => item.id === data.tabId)
      if (updated) setSelected(updated.id)
      if (body.operation === "close") {
        const index = query.data?.tabs.findIndex((item) => item.id === body.tabId) ?? 0
        setSelected(data.tabs[Math.min(Math.max(0, index), data.tabs.length - 1)]?.id)
      }
      if (data.artifact) await download(data.artifact)

      return data
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Browser action failed")
      return undefined
    } finally {
      pendingActions.current--
      setBusy(pendingActions.current > 0)
    }
  }

  const receive = useEffectEvent(
    async (connection: WebSocket, event: MessageEvent<string | ArrayBuffer>) => {
      if (connection !== socket.current) return false
      try {
        if (typeof event.data === "string") {
          const message = zBrowserStreamEvent.parse(JSON.parse(event.data))
          if (message.type === "error") {
            toast.error(message.message)
            return false
          }
          queryClient.setQueryData<BrowserResult>(key, (previous) => {
            if (!previous) return previous
            return {
              ...previous,
              tabs: previous.tabs.map((tab) => (tab.id === message.state.id ? message.state : tab)),
            }
          })
          setControl(message.canOperate)
          return false
        }
        const image = await createImageBitmap(new Blob([event.data], { type: "image/jpeg" }))
        try {
          if (connection !== socket.current) return false
          const target = canvas.current
          if (!target) return false
          if (target.width !== image.width) target.width = image.width
          if (target.height !== image.height) target.height = image.height
          target.getContext("2d")?.drawImage(image, 0, 0)
          setHasFrame(true)
          setStreamError(undefined)
          return true
        } finally {
          image.close()
        }
      } catch {
        // A static page may never send another frame after a failed decode.
        // Reconnecting requests its cached frame instead of waiting forever.
        if (connection === socket.current) connection.close()
      } finally {
        // A failed decode must also release the server's frame backpressure.
        if (typeof event.data !== "string" && connection.readyState === WebSocket.OPEN)
          connection.send(JSON.stringify({ type: "ack" }))
      }
      return false
    }
  )

  useEffect(() => {
    if (!visible || !tabId) return
    const abort = new AbortController()
    let ws: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setInterval> | undefined
    let attempts = 0
    function scheduleRetry() {
      if (abort.signal.aborted) return
      clearTimeout(retry)
      retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempts++, 15000))
    }
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
        const started = Date.now()
        let lastMessage = started
        let rendered = false
        // State heartbeats distinguish a static page from a silent connection.
        // Receiving bytes alone does not mean the first frame was displayed.
        watchdog = setInterval(() => {
          if (Date.now() - (rendered ? lastMessage : started) < 15000) return
          // A broken link may never finish the WebSocket close handshake.
          // Replacing the effect reconnects without waiting for onclose.
          setReconnect((value) => value + 1)
        }, 5000)
        ws.onopen = () => {
          if (connection === socket.current) setConnected(true)
        }
        ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
          lastMessage = Date.now()
          void receive(connection, event).then((displayed) => {
            if (!displayed || connection !== socket.current) return
            rendered = true
            attempts = 0
          })
        }
        ws.onclose = () => {
          if (abort.signal.aborted || connection !== socket.current) return
          clearInterval(watchdog)
          setConnected(false)
          setControl(false)
          setStreamError("Connection lost. Reconnecting…")
          scheduleRetry()
        }
        ws.onerror = () => connection.close()
      } catch (error) {
        if (abort.signal.aborted) return
        setStreamError(error instanceof Error ? error.message : "Browser connection failed")
        scheduleRetry()
      }
    }
    void connect()
    return () => {
      abort.abort()
      clearTimeout(retry)
      clearInterval(watchdog)
      socket.current = null
      ws?.close()
    }
  }, [visible, tabId, viewer, endpoint, workspaceId, reconnect])

  const resizeToPanel = useEffectEvent(() => {
    const rect = viewport.current?.getBoundingClientRect()
    if (rect && control && !busy)
      void action({
        operation: "resize",
        mode: "fill",
        width: Math.max(240, Math.min(3840, Math.floor(rect.width - 16))),
        height: Math.max(240, Math.min(2160, Math.floor(rect.height - 16))),
      })
  })
  useEffect(() => {
    if (!fitPanel || !visible || floating || !control || !tabId || !viewport.current) return
    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => resizeToPanel(), 200)
    })
    observer.observe(viewport.current)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [fitPanel, visible, floating, control, tabId])

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!control || !tab || !canvas.current) return
    event.preventDefault()
    let deltaX = event.deltaX
    let deltaY = event.deltaY
    switch (event.deltaMode) {
      case WheelEvent.DOM_DELTA_LINE:
        deltaX *= 16
        deltaY *= 16
        break
      case WheelEvent.DOM_DELTA_PAGE:
        deltaX *= tab.width
        deltaY *= tab.height
        break
    }
    send({
      type: "wheel",
      ...pageCoordinates(event, canvas.current, tab),
      deltaX,
      deltaY,
    })
  })
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const listener = (event: WheelEvent) => wheel(event)
    node.addEventListener("wheel", listener, { passive: false })
    return () => node.removeEventListener("wheel", listener)
  }, [tabId])

  async function inspectElement(x: number, y: number) {
    const result = await action({
      operation: "evaluate",
      expression: `(() => {
      const element = document.elementFromPoint(${x}, ${y});
      if (!element) return null;
      const parts = []; let node = element;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.tagName === node.tagName) : [];
        parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
      }
      return { tag: element.tagName.toLowerCase(), selector: parts.join(' > '),
        role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
        text: (element.innerText ?? element.textContent ?? '').slice(0, 2000) };
    })()`,
    })
    if (!result?.value) return
    addBrowserContext(
      sessionId,
      `Browser element on ${tab?.url}\n${JSON.stringify(result.value, null, 2)}`,
      hasFrame ? canvas.current?.toDataURL("image/png") : undefined
    )
    setPicking(false)
    toast.success("Element added to chat")
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

  const activeProfile = query.data?.profiles.find((item) => item.id === tab?.profileId)
  let status = "Agent in control"
  if (tab?.owner === "human") status = "Another viewer is in control"
  if (control) status = "You are in control"
  if (!connected) status = "Connecting…"
  if (!tabId) status = "Browser"

  return (
    <BrowserWindow
      floating={floating}
      title={tab?.title || "Browser"}
      width={tab?.width ?? 1280}
      height={tab?.height ?? 800}
      onDock={() => setFloating(false)}
      onClose={onClosePreview}
      onKeyDownCapture={(event) => {
        if (!(event.ctrlKey || event.metaKey)) return
        if (event.key.toLowerCase() === "l" && !floating) {
          event.preventDefault()
          event.stopPropagation()
          send({ type: "resetInput" })
          forwardedKeys.current.clear()
          addressInput.current?.focus()
          addressInput.current?.select()
        }
      }}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 pt-2 pb-1.5",
          floating && "hidden"
        )}
      >
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
              className="min-w-0 flex-1 truncate text-foreground"
              aria-pressed={item.id === tabId}
              title={item.url}
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
              aria-label={`Close ${item.title || "new tab"}`}
              disabled={busy || item.id !== tabId || !control}
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
        className={cn("flex shrink-0 items-center gap-1 border-b p-2", floating && "hidden")}
        onSubmit={(event) => {
          event.preventDefault()
          if (composing.current || !canNavigate) return
          try {
            const value = url.trim()
            let target = `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
            if (
              /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(value) ||
              /^[^/:\s]+:\d+([/?#]|$)/.test(value)
            ) {
              target = `http://${value}`
            } else if (/^https?:\/\//i.test(value)) {
              target = value
            } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
              throw new Error("Only HTTP and HTTPS addresses are supported")
            } else if (!/\s/.test(value) && /^[^/]+\.[^/]+/.test(value)) {
              target = `https://${value}`
            }
            const address = new URL(target).href
            void action({
              operation: tabId ? "navigate" : "open",
              url: address,
              profileId: profile,
            }).then((result) => {
              if (result) {
                setAddress(address)
                setEditingAddress(false)
              }
            })
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Invalid address")
          }
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!tabId || !control || busy || !tab?.canGoBack}
          onClick={() => void action({ operation: "history", delta: -1 })}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!tabId || !control || busy || !tab?.canGoForward}
          onClick={() => void action({ operation: "history", delta: 1 })}
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tab?.loading ? "Stop loading" : "Reload"}
          disabled={!tabId || !control || (busy && !tab?.loading)}
          onClick={() => void action({ operation: tab?.loading ? "stopLoading" : "reload" })}
        >
          {tab?.loading ? <X /> : <RefreshCw />}
        </Button>
        <Input
          ref={addressInput}
          aria-label="Website address"
          disabled={!!tabId && !control}
          className="h-8 rounded-full border-transparent bg-muted/50 text-xs shadow-none focus-visible:bg-background"
          value={url}
          placeholder="Search or enter address"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onFocus={(event) => {
            if (!editingAddress) setAddress(url)
            setEditingAddress(true)
            event.currentTarget.select()
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onChange={(event) => {
            setEditingAddress(true)
            setAddress(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            setEditingAddress(false)
            setAddress(tab?.url === "about:blank" ? "" : (tab?.url ?? ""))
            event.currentTarget.blur()
          }}
        />
        <BrowserAction
          type="button"
          label="Device toolbar"
          variant={deviceToolbar ? "secondary" : "ghost"}
          size="icon-sm"
          disabled={!tabId}
          onClick={() => setDeviceToolbar(!deviceToolbar)}
        >
          <PanelTop />
        </BrowserAction>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Browser profiles"
              title="Browser profiles"
            >
              <Users />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[70vh] min-w-56 overflow-y-auto">
            <DropdownMenuGroup>
              {query.data?.profiles.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() =>
                    void action({ operation: "setDefaultProfile", profileId: item.id })
                  }
                >
                  {item.incognito ? (
                    <VenetianMask className="text-muted-foreground" />
                  ) : (
                    <CircleUserRound className="text-muted-foreground" />
                  )}
                  <span className="flex-1">{item.name}</span>
                  {profile === item.id ? <Check className="text-primary" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => {
                  setProfileName("")
                  setProfileDialog("create")
                }}
              >
                <Plus className="text-muted-foreground" />
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
                <Pencil className="text-muted-foreground" />
                Rename profile
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={profile === "default" || profile === "incognito"}
                onSelect={() => void action({ operation: "deleteProfile", profileId: profile })}
              >
                <Trash2 />
                Delete profile
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => void action({ operation: "clearCookies", profileId: profile })}
              >
                <Cookie className="text-muted-foreground" />
                Clear cookies
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void action({ operation: "clearCache", profileId: profile })}
              >
                <Eraser className="text-muted-foreground" />
                Clear cache
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void action({ operation: "clearProfile", profileId: profile })}
              >
                <RotateCcw className="text-muted-foreground" />
                Reset profile data
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={!tabId || !control || busy}
                onSelect={() => void action({ operation: "reload", ignoreCache: true })}
              >
                <RefreshCw className="text-muted-foreground" />
                Hard reload
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!tabId} onSelect={() => setFloating(true, tabId)}>
                <ExternalLink className="text-muted-foreground" />
                Float browser
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!tabId} onSelect={() => setDeviceToolbar(true)}>
                <Monitor className="text-muted-foreground" />
                Viewport controls
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!tabId || !control || busy}>
                  <Sun className="text-muted-foreground" />
                  Appearance
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44">
                  <DropdownMenuGroup>
                    {(
                      [
                        ["system", Monitor],
                        ["light", Sun],
                        ["dark", Moon],
                      ] as const
                    ).map(([colorScheme, Icon]) => (
                      <DropdownMenuItem
                        key={colorScheme}
                        disabled={!control}
                        onSelect={() => void action({ operation: "setColorScheme", colorScheme })}
                      >
                        <Icon className="text-muted-foreground" />
                        <span className="flex-1 capitalize">{colorScheme}</span>
                        {tab?.colorScheme === colorScheme ? (
                          <Check className="text-primary" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>
      {deviceToolbar && tab && !floating ? (
        <div
          role="toolbar"
          aria-label="Viewport controls"
          className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b bg-muted/30 p-1.5"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={!control || busy}>
                <Smartphone /> Devices
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-auto">
              <DropdownMenuGroup>
                {query.data?.presets?.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    onSelect={() => {
                      void action({ operation: "resize", mode: "preset", preset: preset.id })
                    }}
                  >
                    {preset.label}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {preset.width} × {preset.height}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <BrowserAction
            label="Set viewport dimensions"
            variant="outline"
            size="sm"
            disabled={!control || busy}
            onClick={() => {
              setViewportDialog(true)
            }}
          >
            <span className="tabular-nums">
              {tab.width} × {tab.height}
            </span>
          </BrowserAction>
          <BrowserAction
            label={aspectLocked ? "Unlock aspect ratio" : "Lock aspect ratio"}
            variant={aspectLocked ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={!control || busy}
            onClick={() => setAspectLocked(!aspectLocked)}
          >
            {aspectLocked ? <Link2 /> : <Unlink2 />}
          </BrowserAction>
          <BrowserAction
            label="Rotate viewport"
            variant="ghost"
            size="icon-sm"
            disabled={!control || busy}
            onClick={() => {
              void action({
                operation: "resize",
                mode: "freeform",
                width: tab.height,
                height: tab.width,
              })
            }}
          >
            <RotateCw />
          </BrowserAction>
          <BrowserAction
            label={fitPanel ? "Stop fitting panel" : "Fit panel automatically"}
            variant={fitPanel ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={!control || busy}
            onClick={() => setFitPanel(!fitPanel)}
          >
            <SquareDashed />
          </BrowserAction>
          <BrowserAction
            label="Zoom out"
            variant="ghost"
            size="icon-sm"
            disabled={!control || busy || tab.zoom <= 0.25}
            onClick={() =>
              void action({ operation: "resize", zoom: Math.max(0.25, tab.zoom - 0.25) })
            }
          >
            <ZoomOut />
          </BrowserAction>
          <BrowserAction
            label="Reset zoom"
            variant="ghost"
            size="sm"
            disabled={!control || busy}
            onClick={() => void action({ operation: "resize", zoom: 1 })}
          >
            {Math.round(tab.zoom * 100)}%
          </BrowserAction>
          <BrowserAction
            label="Zoom in"
            variant="ghost"
            size="icon-sm"
            disabled={!control || busy || tab.zoom >= 5}
            onClick={() => void action({ operation: "resize", zoom: Math.min(5, tab.zoom + 0.25) })}
          >
            <ZoomIn />
          </BrowserAction>
        </div>
      ) : null}
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
          {tab.dialog.type === "prompt" ? (
            <Input
              key={tab.dialog.message}
              ref={input}
              aria-label="Dialog answer"
              defaultValue={tab.dialog.defaultValue}
              disabled={!control || busy}
            />
          ) : null}
          <Button
            size="sm"
            disabled={!control || busy}
            onClick={() =>
              void action({ operation: "dialog", accept: true, promptText: input.current?.value })
            }
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!control || busy}
            onClick={() => void action({ operation: "dialog", accept: false })}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <div
        ref={viewport}
        className={
          floating
            ? "[container-type:size] relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20"
            : "relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/20 p-2"
        }
      >
        {!tab ? (
          <div className="m-auto flex max-w-64 flex-col items-center gap-4 py-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border bg-background shadow-xs">
              <Globe className="size-6 text-muted-foreground" />
            </div>
            <div>
              <h3 className="mb-1.5 text-sm font-medium">Browse together</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open a website or ask your agent to browse.
              </p>
            </div>
            {query.isPending ? (
              <Spinner />
            ) : (
              <Button
                disabled={busy || query.isError}
                onClick={() => void action({ operation: "open", profileId: profile })}
              >
                Open browser
              </Button>
            )}
          </div>
        ) : (
          <div className={cn("relative inline-flex max-w-full", !floating && "self-start")}>
            {!hasFrame || !connected || streamError ? (
              <div
                className="absolute inset-0 z-10 flex min-h-40 flex-col items-center justify-center gap-3 bg-background/95 p-4 text-center"
                role="status"
              >
                <Spinner />
                <p className="text-xs text-muted-foreground">
                  {streamError ?? (connected ? "Waiting for the page…" : "Connecting to browser…")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReconnect((value) => value + 1)}
                >
                  Reconnect
                </Button>
              </div>
            ) : null}
            <canvas
              ref={canvas}
              tabIndex={0}
              aria-label="Live browser page"
              aria-busy={!hasFrame}
              width={tab.width}
              height={tab.height}
              style={
                floating
                  ? {
                      width: `min(100cqw, calc(100cqh * ${tab.width / tab.height}))`,
                    }
                  : { width: tab.width }
              }
              className={cn(
                "h-auto max-w-full touch-none bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring",
                floating ? "max-h-full w-auto" : "self-start border shadow-sm",
                picking && control && "cursor-crosshair"
              )}
              onPointerDown={(event) => {
                if (!control) return
                if (picking) {
                  event.preventDefault()
                  pickingGesture.current = true
                  event.currentTarget.setPointerCapture(event.pointerId)
                  return
                }
                textInput.current?.focus({ preventScroll: true })
                event.currentTarget.setPointerCapture(event.pointerId)
                if (event.pointerType === "touch") {
                  event.preventDefault()
                  clicks.current = 1
                  touch.current = { x: event.clientX, y: event.clientY, moved: false }
                  return
                }
              }}
              onMouseDown={(event) => {
                if (!control || pickingGesture.current) return
                // Prevent the canvas's default mouse focus from stealing the
                // textarea. Mouse events carry the browser's click count.
                event.preventDefault()
                clicks.current = Math.max(1, Math.min(3, event.detail))
                send({
                  type: "mouse",
                  action: "down",
                  ...pageCoordinates(event, event.currentTarget, tab),
                  button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
                  clickCount: clicks.current,
                })
              }}
              onPointerMove={(event) => {
                if (!control || pickingGesture.current) return
                if (event.pointerType === "touch" && touch.current) {
                  const previous = touch.current
                  const deltaX = previous.x - event.clientX
                  const deltaY = previous.y - event.clientY
                  if (Math.abs(deltaX) + Math.abs(deltaY) > 3 || previous.moved) {
                    const rect = event.currentTarget.getBoundingClientRect()
                    send({
                      type: "wheel",
                      ...pageCoordinates(event, event.currentTarget, tab),
                      deltaX: (deltaX * tab.width) / rect.width,
                      deltaY: (deltaY * tab.height) / rect.height,
                    })
                    touch.current = { x: event.clientX, y: event.clientY, moved: true }
                  }
                  return
                }
                send({
                  type: "mouse",
                  action: "move",
                  ...pageCoordinates(event, event.currentTarget, tab),
                })
              }}
              onPointerUp={(event) => {
                if (!control) return
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                if (pickingGesture.current) {
                  pickingGesture.current = false
                  const point = pageCoordinates(event, event.currentTarget, tab)
                  void inspectElement(point.x, point.y)
                  return
                }
                if (event.pointerType === "touch") {
                  const gesture = touch.current
                  touch.current = null
                  if (!gesture || gesture.moved) return
                  send({
                    type: "mouse",
                    action: "down",
                    button: "left",
                    ...pageCoordinates(event, event.currentTarget, tab),
                  })
                }
                send({
                  type: "mouse",
                  action: "up",
                  ...pageCoordinates(event, event.currentTarget, tab),
                  button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
                  clickCount: clicks.current,
                })
              }}
              onLostPointerCapture={() => {
                touch.current = null
                pickingGesture.current = false
                if (control) send({ type: "resetInput" })
              }}
              onPointerCancel={() => {
                touch.current = null
                pickingGesture.current = false
                if (control) send({ type: "resetInput" })
              }}
              onContextMenu={(event) => event.preventDefault()}
            />
            {tab.cursor && !control ? (
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
                event.currentTarget.setSelectionRange(1, 1)
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
                forwardedKeys.current.add(event.key)
                send({ type: "key", action: "down", key: event.key })
              }}
              onKeyUp={(event) => {
                if (control && !composing.current && forwardedKeys.current.delete(event.key))
                  send({ type: "key", action: "up", key: event.key })
              }}
              onInput={(event) => {
                if (!control || composing.current) return
                const native = event.nativeEvent
                if (native instanceof InputEvent && native.isComposing) return
                if (
                  native instanceof InputEvent &&
                  ["deleteContentBackward", "deleteContentForward"].includes(native.inputType)
                ) {
                  const key = native.inputType === "deleteContentBackward" ? "Backspace" : "Delete"
                  send({ type: "key", action: "down", key })
                  send({ type: "key", action: "up", key })
                } else {
                  const text = event.currentTarget.value.replace(/^\u200b/, "")
                  if (text) send({ type: "text", text })
                }
                event.currentTarget.value = "​"
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={(event) => {
                composing.current = false
                if (control && event.data) send({ type: "text", text: event.data })
                event.currentTarget.value = "​"
              }}
              onPaste={(event) => {
                if (control) {
                  event.preventDefault()
                  send({
                    type: "text",
                    text: event.clipboardData.getData("text/plain"),
                  })
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
                forwardedKeys.current.clear()
                if (control) send({ type: "resetInput" })
              }}
            />
          </div>
        )}
      </div>
      {tab?.fileChooser && control ? (
        <div className="flex shrink-0 items-center gap-2 border-t p-3">
          <label className="min-w-0 flex-1 text-xs">
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
                // Reset after capturing the files so the same selection can retry.
                event.currentTarget.value = ""
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
                  .catch(() => toast.error("Upload failed"))
              }}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void action({ operation: "upload", paths: [] })}
          >
            Cancel upload
          </Button>
        </div>
      ) : null}
      {downloads.length > 0 && !floating ? (
        <div aria-label="Downloads" className="flex shrink-0 items-center border-t">
          <div className="flex max-h-24 min-w-0 flex-1 flex-wrap gap-1 overflow-auto p-2">
            {downloads.map((file) => (
              <BrowserAction
                key={file.id}
                label={`Download ${file.fileName}`}
                variant="ghost"
                size="sm"
                onClick={() =>
                  void download(file).catch(() => toast.error("Browser download is unavailable"))
                }
              >
                <Download />
                <span className="max-w-48 truncate">{file.fileName}</span>
              </BrowserAction>
            ))}
          </div>
          <BrowserAction
            label="Close downloads"
            variant="ghost"
            size="icon-sm"
            className="m-2"
            onClick={() => setDownloadShelf((current) => ({ ...current, files: [] }))}
          >
            <X />
          </BrowserAction>
        </div>
      ) : null}
      <footer
        className={
          floating
            ? "absolute inset-x-2 bottom-2 z-10 flex items-center gap-1 rounded-lg border bg-background/95 p-1 text-xs text-muted-foreground opacity-0 shadow-sm group-focus-within/browser:opacity-100 group-hover/browser:opacity-100 pointer-coarse:opacity-100"
            : "flex shrink-0 items-center gap-1 border-t p-2 text-xs text-muted-foreground"
        }
      >
        <span className="mr-auto flex min-w-0 items-center gap-1.5" role="status">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              connected ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
          />
          <span className="truncate">
            {picking && control ? "Click an element to add it to chat" : status}
          </span>
          {!floating && activeProfile ? (
            <span className="truncate border-l pl-2" title="Browser profile shared with this agent">
              {activeProfile.name}
            </span>
          ) : null}
          {tab?.recording ? (
            <span className="flex items-center gap-1 text-destructive">
              <Circle className="size-2 fill-current" /> Recording
            </span>
          ) : null}
        </span>
        <div className={floating ? "hidden" : "contents"}>
          <BrowserAction
            label={picking ? "Cancel element selection" : "Select element for chat"}
            size="icon-sm"
            variant={picking ? "secondary" : "ghost"}
            disabled={!control || !hasFrame || busy}
            onClick={() => setPicking(!picking)}
          >
            <MousePointerClick />
          </BrowserAction>
          <BrowserAction
            label="Add screenshot to chat"
            size="icon-sm"
            variant="ghost"
            disabled={!tabId || !connected || !hasFrame}
            onClick={() => {
              const page = canvas.current
              if (page) {
                addBrowserContext(
                  sessionId,
                  `Browser screenshot: ${tab?.url}`,
                  page.toDataURL("image/png")
                )
                toast.success("Screenshot added to chat")
              }
            }}
          >
            <ScanLine />
          </BrowserAction>
          <BrowserAction
            label="Save screenshot"
            size="icon-sm"
            variant="ghost"
            disabled={!tabId || busy || !hasFrame || !connected}
            onClick={() => void action({ operation: "snapshot", save: true })}
          >
            <Camera />
          </BrowserAction>
          <BrowserAction
            label={tab?.recording ? "Stop recording" : "Start recording"}
            size="icon-sm"
            variant="ghost"
            disabled={!tabId || !control || busy}
            onClick={() =>
              void action({ operation: tab?.recording ? "recordingStop" : "recordingStart" })
            }
          >
            {tab?.recording ? <Square className="text-destructive" /> : <Circle />}
          </BrowserAction>
        </div>
        <BrowserAction
          label={control ? "Return control" : "Take control"}
          size="sm"
          variant={control ? "secondary" : "default"}
          disabled={!connected || (!control && tab?.owner === "human")}
          onClick={() => {
            send({ type: control ? "releaseControl" : "takeControl" })
            canvas.current?.focus()
          }}
        >
          <Hand />
          {control ? "Return control" : "Take control"}
        </BrowserAction>
      </footer>
      <Dialog open={viewportDialog} onOpenChange={setViewportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Browser viewport</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!control || busy) return
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
                  onChange={(event) => {
                    if (aspectLocked && tab && viewportHeight.current && event.target.valueAsNumber)
                      viewportHeight.current.valueAsNumber = Math.round(
                        (event.target.valueAsNumber * tab.height) / tab.width
                      )
                  }}
                  disabled={!control || busy}
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
                  onChange={(event) => {
                    if (aspectLocked && tab && viewportWidth.current && event.target.valueAsNumber)
                      viewportWidth.current.valueAsNumber = Math.round(
                        (event.target.valueAsNumber * tab.width) / tab.height
                      )
                  }}
                  disabled={!control || busy}
                  required
                />
              </label>
            </div>
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={!control || busy}>
                Resize
              </Button>
            </DialogFooter>
          </form>
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
    </BrowserWindow>
  )
}

function BrowserAction({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("inline-flex", props.disabled && "cursor-not-allowed")}
          tabIndex={props.disabled ? 0 : undefined}
        >
          <Button {...props} aria-label={label}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function pageCoordinates(
  event: Pick<MouseEvent, "clientX" | "clientY">,
  canvas: HTMLCanvasElement,
  tab: BrowserTab
) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) * tab.width) / rect.width,
    y: ((event.clientY - rect.top) * tab.height) / rect.height,
  }
}
