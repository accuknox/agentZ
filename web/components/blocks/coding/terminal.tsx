"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Event, Pty } from "@opencode-ai/sdk/v2"
import { Tabs as TabsPrimitive } from "radix-ui"
import { useTheme } from "next-themes"
import { Terminal, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Plus, TerminalSquare, X } from "lucide-react"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL, getGatewayToken } from "@/lib/gateway/browser-runtime"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import "@xterm/xterm/css/xterm.css"

type TerminalProps = {
  agentName: string
  sessionId: string
  directory: string
  workspaceId: string
  visible: boolean
  onLastTerminalClosed: () => void
}

export function CodingTerminal({
  agentName,
  sessionId,
  directory,
  workspaceId,
  visible,
  onLastTerminalClosed,
}: TerminalProps) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string>()
  const title = `Coding · ${sessionId}`
  const queryKey = ["coding", "terminals", workspaceId, agentName, directory, title]
  // This cache survives tool switches. Only a successful list or lifecycle
  // event may remove a session; transport failures leave it intact.
  const { data: sessions = [] } = useQuery(
    queryOptions<Pty[]>({ queryKey, queryFn: skipToken, initialData: [] })
  )
  const active = sessions.find((pty) => pty.id === selected) ?? sessions[0]
  const lifetime = useRef<AbortController>(null)
  const opening = useRef(false)
  const refreshing = useRef<Promise<Pty[] | undefined>>(undefined)
  const closing = useRef(new Set<string>())
  const closed = useRef(new Set<string>())
  const revision = useRef(0)
  const dismissed = useRef(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<"load" | "create">()
  const [closeError, setCloseError] = useState<string>()
  const [streamAttempt, setStreamAttempt] = useState(0)
  const [streamError, setStreamError] = useState(false)

  function removeTabs(ids: string[], notify = true) {
    const current = queryClient.getQueryData<Pty[]>(queryKey) ?? []
    const removed = new Set(ids)
    const remaining = current.filter((pty) => !removed.has(pty.id))
    for (const id of ids) closed.current.add(id)
    if (remaining.length === current.length) return
    revision.current++
    queryClient.setQueryData(queryKey, remaining)
    setCloseError((id) => (id && removed.has(id) ? undefined : id))
    setSelected((id) => {
      const index = current.findIndex((pty) => pty.id === (id ?? current[0]?.id))
      const selected = current[index]
      if (!selected || !removed.has(selected.id)) return id
      return (
        current.slice(index + 1).find((pty) => !removed.has(pty.id))?.id ??
        current.slice(0, index).findLast((pty) => !removed.has(pty.id))?.id
      )
    })
    if (notify) {
      dismissed.current++
      if (remaining.length === 0) onLastTerminalClosed()
    }
  }

  function refresh() {
    if (refreshing.current) return refreshing.current
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return Promise.resolve(undefined)
    const request = (async (): Promise<Pty[] | undefined> => {
      try {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        // A membership event during a list request makes that snapshot stale.
        // Read again before committing it so a late response cannot revive a tab.
        while (!signal.aborted) {
          const version = revision.current
          const { data } = await client.pty.list({ directory }, { signal, throwOnError: true })
          if (signal.aborted) return
          if (version !== revision.current) continue
          const running = data.filter(
            (pty) =>
              pty.status === "running" &&
              !closed.current.has(pty.id) &&
              (pty.title === title || pty.title.startsWith(`${title} · `))
          )
          const current = queryClient.getQueryData<Pty[]>(queryKey) ?? []
          // Add discoveries before removing expired tabs, so cleanup can select
          // a live replacement without briefly hiding the panel.
          queryClient.setQueryData(queryKey, [
            ...current,
            ...running.filter((pty) => !current.some((item) => item.id === pty.id)),
          ])
          removeTabs(
            current
              .filter((pty) => !running.some((item) => item.id === pty.id))
              .map((pty) => pty.id),
            !opening.current
          )
          queryClient.setQueryData(queryKey, running)
          setError((value) => (value === "load" ? undefined : value))
          return running
        }
      } catch {
        if (!signal.aborted) setError("load")
      }
      return undefined
    })()
    refreshing.current = request
    void request.finally(() => {
      if (refreshing.current === request) refreshing.current = undefined
    })
    return request
  }

  async function openTerminal(add = false) {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted || opening.current) return
    opening.current = true
    setPending(true)
    setError(undefined)
    const version = dismissed.current
    try {
      const running = await refresh()
      if (!running || signal.aborted) return
      // A close while activation is pending consumes that activation.
      if (version !== dismissed.current) return
      if (!add && running.length > 0) return
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      if (signal.aborted) return
      let number = running.length + 1
      while (running.some((pty) => pty.title === `${title} · Terminal ${number}`)) number++
      const { data: pty } = await client.pty.create(
        {
          directory,
          cwd: directory,
          title: `${title} · Terminal ${number}`,
          env: { COLORTERM: "truecolor" },
        },
        { signal, throwOnError: true }
      )
      if (signal.aborted || closed.current.has(pty.id)) return
      revision.current++
      queryClient.setQueryData<Pty[]>(queryKey, (current = []) =>
        current.some((item) => item.id === pty.id) ? current : [...current, pty]
      )
      setSelected(pty.id)
    } catch {
      if (!signal.aborted) setError("create")
    } finally {
      if (!signal.aborted) {
        opening.current = false
        setPending(false)
      }
    }
  }

  async function closeTerminal(ptyID: string) {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted || closing.current.has(ptyID) || closed.current.has(ptyID)) return
    closing.current.add(ptyID)
    setCloseError(undefined)
    try {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const { error, response } = await client.pty.remove({ ptyID, directory }, { signal })
      if (signal.aborted) return
      if (
        error &&
        !(response.status === 404 && "_tag" in error && error._tag === "PtyNotFoundError")
      ) {
        throw error
      }
      removeTabs([ptyID])
    } catch {
      if (!signal.aborted && !closed.current.has(ptyID)) setCloseError(ptyID)
    } finally {
      closing.current.delete(ptyID)
    }
  }

  const handleEvent = useEffectEvent((event: Event) => {
    if (event.type === "server.connected") {
      setStreamError(false)
      void refresh()
    }
    if (event.type === "pty.exited" || event.type === "pty.deleted") {
      const current = queryClient.getQueryData<Pty[]>(queryKey) ?? []
      if (current.some((pty) => pty.id === event.properties.id)) removeTabs([event.properties.id])
    }
    if (event.type === "pty.created" || event.type === "pty.updated") {
      const pty = event.properties.info
      if (pty.title !== title && !pty.title.startsWith(`${title} · `)) return
      if (pty.status === "exited") {
        removeTabs([pty.id])
        return
      }
      if (closed.current.has(pty.id)) return
      revision.current++
      queryClient.setQueryData<Pty[]>(queryKey, (current = []) =>
        current.some((item) => item.id === pty.id)
          ? current.map((item) => (item.id === pty.id ? pty : item))
          : [...current, pty]
      )
    }
  })
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      opening.current = false
      refreshing.current = undefined
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function subscribe() {
      try {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const { stream } = await client.event.subscribe(
          { directory },
          {
            signal: controller.signal,
            sseMaxRetryAttempts: 1,
          }
        )
        for await (const event of stream) {
          if (controller.signal.aborted) return
          handleEvent(event)
        }
      } finally {
        if (!controller.signal.aborted) {
          setStreamError(true)
          timer = setTimeout(() => setStreamAttempt((value) => value + 1), 1000)
        }
      }
    }
    void subscribe().catch(() => {})
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [agentName, workspaceId, directory, streamAttempt])
  const activate = useEffectEvent(() => {
    void openTerminal()
  })
  useEffect(() => {
    if (visible) activate()
  }, [visible])
  return (
    <Tabs value={active?.id ?? ""} onValueChange={setSelected} className="h-full min-h-0 gap-0">
      <div className="bg-muted/20 flex h-9 shrink-0 items-center gap-1 border-b pr-1">
        <TabsPrimitive.List
          aria-label="Terminals"
          className="flex h-full min-w-0 flex-1 scrollbar-none items-stretch overflow-x-auto overflow-y-hidden"
        >
          {sessions.map((pty, index) => {
            const label =
              pty.title === title ? `Terminal ${index + 1}` : pty.title.slice(title.length + 3)
            return (
              <div
                key={pty.id}
                data-active={active?.id === pty.id}
                className="group/terminal text-muted-foreground hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground after:bg-primary border-border/60 relative flex max-w-48 min-w-32 shrink-0 items-center border-r pr-1 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:opacity-0 data-[active=true]:after:opacity-100"
              >
                <TabsPrimitive.Trigger
                  value={pty.id}
                  className="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  onFocus={(event) =>
                    event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
                  }
                >
                  <TerminalSquare className="size-3.5" />
                  <span className="truncate">{label}</span>
                </TabsPrimitive.Trigger>
                <Button
                  aria-label={`Close ${label}`}
                  title="End terminal session"
                  className="opacity-60 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-focus-within/terminal:opacity-100 sm:group-hover/terminal:opacity-100"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void closeTerminal(pty.id)}
                >
                  <X />
                </Button>
              </div>
            )
          })}
        </TabsPrimitive.List>
        <Button
          aria-label="New terminal"
          title="New terminal"
          size="icon-sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void openTerminal(true)}
        >
          {pending ? <Spinner /> : <Plus />}
        </Button>
      </div>
      {pending && sessions.length === 0 ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2 p-3 text-xs">
          <Spinner /> Opening terminal...
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          {error === "load" ? "Could not load terminals." : "Could not start terminal."}
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void openTerminal(error === "create")}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {closeError ? (
        <div
          role="alert"
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          Could not close terminal.
          <Button size="xs" variant="ghost" onClick={() => void closeTerminal(closeError)}>
            Retry close
          </Button>
        </div>
      ) : null}
      {streamError ? (
        <div
          role="status"
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          Reconnecting session updates...
          <Button size="xs" variant="ghost" onClick={() => setStreamAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {sessions.map((pty) => (
        <TabsContent
          key={pty.id}
          value={pty.id}
          forceMount
          className="min-h-0 data-[state=inactive]:hidden"
        >
          <TerminalSession
            agentName={agentName}
            directory={directory}
            workspaceId={workspaceId}
            ptyID={pty.id}
            visible={visible && active?.id === pty.id}
            onDisconnect={refresh}
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function terminalTheme(container: HTMLElement): ITheme {
  const style = getComputedStyle(container)
  const dark = container.closest(".dark") !== null
  const palette = {
    black: style.getPropertyValue("--muted").trim(),
    red: style.getPropertyValue("--destructive").trim(),
    green: style.getPropertyValue("--success").trim(),
    yellow: style.getPropertyValue("--warning").trim(),
    blue: style.getPropertyValue("--info").trim(),
    magenta: style.getPropertyValue("--primary").trim(),
    cyan: dark ? "#67e8f9" : "#0e7490",
    white: style.color,
  }
  return {
    ...palette,
    background: style.backgroundColor,
    foreground: style.color,
    cursor: style.color,
    cursorAccent: style.backgroundColor,
    selectionBackground: dark ? "#ffffff30" : "#00000020",
    brightBlack: style.getPropertyValue("--muted-foreground").trim(),
    brightRed: palette.red,
    brightGreen: palette.green,
    brightYellow: palette.yellow,
    brightBlue: palette.blue,
    brightMagenta: palette.magenta,
    brightCyan: palette.cyan,
    brightWhite: palette.white,
  }
}

function TerminalSession({
  agentName,
  directory,
  workspaceId,
  ptyID,
  visible,
  onDisconnect,
}: Omit<TerminalProps, "sessionId" | "onLastTerminalClosed"> & {
  ptyID: string
  onDisconnect: () => Promise<Pty[] | undefined>
}) {
  const { resolvedTheme } = useTheme()
  const element = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState("Connecting...")
  const disconnected = useEffectEvent(() => {
    void onDisconnect()
  })
  useEffect(() => {
    // next-themes applies the root class in its parent effect.
    const frame = requestAnimationFrame(() => {
      const container = element.current
      if (!container || !terminalRef.current) return
      terminalRef.current.options.theme = terminalTheme(container)
    })
    return () => cancelAnimationFrame(frame)
  }, [resolvedTheme, attempt])
  useEffect(() => {
    if (!visible) return
    // Let the tab's pointer event finish before handing focus to the shell.
    const frame = requestAnimationFrame(() => {
      if (!document.activeElement?.matches('[role="tab"]:focus-visible')) {
        terminalRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  useEffect(() => {
    const container = element.current
    if (!container) return
    const controller = new AbortController()
    const { signal } = controller
    let socket: WebSocket | undefined
    let resize: ResizeObserver | undefined
    const style = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: style.fontFamily,
      theme: terminalTheme(container),
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data)
    })
    async function connect(container: HTMLDivElement) {
      setStatus("Connecting...")
      // Canvas measurement needs the resolved font and a loaded face.
      await document.fonts.load(`13px ${terminal.options.fontFamily}`)
      if (signal.aborted) return
      terminal.open(container)
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      if (signal.aborted) return
      const [{ data: ticket }, base, token] = await Promise.all([
        client.pty.connectToken(
          { ptyID, directory },
          { signal, headers: { "x-opencode-ticket": "1" }, throwOnError: true }
        ),
        getGatewayBaseURL(),
        getGatewayToken(workspaceId),
      ])
      if (signal.aborted) return
      const url = new URL(
        `${base}/api/opencode/${encodeURIComponent(agentName)}/pty/${encodeURIComponent(ptyID)}/connect`
      )
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("directory", directory)
      url.searchParams.set("ticket", ticket.ticket)
      // Recreating the emulator on reconnect requires replaying the PTY buffer.
      url.searchParams.set("cursor", "0")
      socket = new WebSocket(url, ["agentz.pty", `agentz.bearer.${token}`])
      socket.binaryType = "arraybuffer"
      socket.onopen = () => {
        if (signal.aborted) return
        setStatus("Connected")
        if (container.clientWidth > 0 && container.clientHeight > 0) terminal.focus()
      }
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        // Text frames contain output; binary frames carry replay cursor metadata.
        if (typeof event.data === "string") terminal.write(event.data)
      }
      socket.onclose = () => {
        if (signal.aborted) return
        setStatus("Disconnected")
        disconnected()
      }
      socket.onerror = () => {
        if (!signal.aborted) setStatus("Connection failed")
      }
      resize = new ResizeObserver(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        fit.fit()
        void client.pty
          .update(
            { ptyID, directory, size: { rows: terminal.rows, cols: terminal.cols } },
            { signal, throwOnError: true }
          )
          .catch(() => {
            if (!signal.aborted) setStatus("Could not resize terminal")
          })
      })
      resize.observe(container)
    }
    void connect(container).catch(() => {
      if (signal.aborted) return
      setStatus("Could not connect terminal")
      disconnected()
    })
    return () => {
      controller.abort()
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
      }
      socket?.close()
      resize?.disconnect()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [agentName, directory, workspaceId, ptyID, attempt])
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      {status !== "Connected" ? (
        <div
          role="status"
          className="text-muted-foreground flex shrink-0 items-center gap-2 px-3 py-1 text-xs"
        >
          {status === "Connecting..." ? <Spinner /> : null}
          {status}
          {status !== "Connecting..." ? (
            <Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
              Retry connection
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={element}
        className="bg-background text-foreground min-h-0 flex-1 overflow-hidden p-2 font-mono [font-stretch:normal]"
      />
    </div>
  )
}
