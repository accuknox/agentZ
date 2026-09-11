"use client"

import { useEffect, useRef, useState } from "react"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Tabs as TabsPrimitive } from "radix-ui"
import { useTheme } from "next-themes"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Plus, RefreshCw, TerminalSquare, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL, getGatewayToken } from "@/lib/gateway/browser-runtime"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import "@xterm/xterm/css/xterm.css"

type TerminalProps = {
  agentName: string
  sessionId: string
  directory: string
  workspaceId: string
  visible: boolean
}

export function CodingTerminal({
  agentName,
  sessionId,
  directory,
  workspaceId,
  visible,
}: TerminalProps) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string>()
  const title = `Coding · ${sessionId}`
  const queryKey = ["coding", "terminals", workspaceId, agentName, directory, title]
  const terminals = useQuery(
    queryOptions({
      queryKey,
      queryFn: async ({ signal }) => {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const { data } = await client.pty.list({ directory }, { signal, throwOnError: true })
        return data.filter((pty) => pty.title === title || pty.title.startsWith(`${title} · `))
      },
    })
  )
  const active = terminals.data?.find((pty) => pty.id === selected) ?? terminals.data?.[0]
  const create = useMutation({
    mutationFn: async () => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const sessions = terminals.data ?? []
      let number = sessions.length + 1
      while (sessions.some((pty) => pty.title === `${title} · Terminal ${number}`)) number++
      const { data } = await client.pty.create(
        { directory, cwd: directory, title: `${title} · Terminal ${number}` },
        { throwOnError: true }
      )
      return data
    },
    onSuccess: async (pty) => {
      setSelected(pty.id)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: () => toast.error("Could not start terminal"),
  })
  const remove = useMutation({
    mutationFn: async (ptyID: string) => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      await client.pty.remove({ ptyID, directory }, { throwOnError: true })
    },
    onSuccess: async (_, ptyID) => {
      const sessions = terminals.data ?? []
      const index = sessions.findIndex((pty) => pty.id === ptyID)
      if (active?.id === ptyID) setSelected(sessions[index + 1]?.id ?? sessions[index - 1]?.id)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: () => toast.error("Could not close terminal"),
  })
  return (
    <Tabs value={active?.id ?? ""} onValueChange={setSelected} className="h-full min-h-0 gap-0">
      <div className="bg-muted/20 flex h-9 shrink-0 items-center gap-1 border-b pr-1">
        <TabsPrimitive.List
          aria-label="Terminals"
          className="flex h-full min-w-0 flex-1 scrollbar-none items-stretch overflow-x-auto overflow-y-hidden"
        >
          {terminals.data?.map((pty, index) => {
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
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(pty.id)}
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
          disabled={create.isPending || terminals.isPending || terminals.isError}
          onClick={() => create.mutate()}
        >
          {create.isPending ? <Spinner /> : <Plus />}
        </Button>
      </div>
      {terminals.isPending ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
          <Spinner /> Loading terminals...
        </div>
      ) : null}
      {terminals.error ? (
        <div role="alert" className="text-destructive p-4 text-sm">
          Could not load terminals.{" "}
          <Button size="sm" variant="outline" onClick={() => void terminals.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {!terminals.error && terminals.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TerminalSquare />
            </EmptyMedia>
            <EmptyTitle>Run commands in this worktree</EmptyTitle>
            <EmptyDescription>
              Terminal sessions keep running when you switch tools or close the panel.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            disabled={create.isPending || terminals.isPending || terminals.isError}
            onClick={() => create.mutate()}
          >
            <Plus />
            New terminal
          </Button>
        </Empty>
      ) : null}
      {terminals.data?.map((pty) => (
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
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function TerminalSession({
  agentName,
  directory,
  workspaceId,
  ptyID,
  visible,
}: Omit<TerminalProps, "sessionId"> & { ptyID: string }) {
  const { resolvedTheme } = useTheme()
  const element = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState("Connecting...")
  useEffect(() => {
    // next-themes applies the root class in its parent effect.
    const frame = requestAnimationFrame(() => {
      const container = element.current
      if (!container || !terminalRef.current) return
      const style = getComputedStyle(container)
      terminalRef.current.options.theme = {
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
        selectionBackground: resolvedTheme === "dark" ? "#ffffff30" : "#00000020",
      }
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
    let cancelled = false
    let socket: WebSocket | undefined
    let resize: ResizeObserver | undefined
    const style = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: style.fontFamily,
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
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
      if (cancelled) return
      terminal.open(container)
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const [{ data: ticket }, base, token] = await Promise.all([
        client.pty.connectToken(
          { ptyID, directory },
          { headers: { "x-opencode-ticket": "1" }, throwOnError: true }
        ),
        getGatewayBaseURL(),
        getGatewayToken(workspaceId),
      ])
      if (cancelled) return
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
        if (cancelled) return
        setStatus("Connected")
        if (container.clientWidth > 0 && container.clientHeight > 0) terminal.focus()
      }
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        // Text frames contain output; binary frames carry replay cursor metadata.
        if (typeof event.data === "string") terminal.write(event.data)
      }
      socket.onclose = () => {
        if (!cancelled) setStatus("Disconnected")
      }
      socket.onerror = () => {
        if (!cancelled) setStatus("Connection failed")
      }
      resize = new ResizeObserver(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        fit.fit()
        void client.pty
          .update(
            { ptyID, directory, size: { rows: terminal.rows, cols: terminal.cols } },
            { throwOnError: true }
          )
          .catch(() => {
            if (!cancelled) setStatus("Could not resize terminal")
          })
      })
      resize.observe(container)
    }
    void connect(container).catch(() => {
      if (!cancelled) setStatus("Could not connect terminal")
    })
    return () => {
      cancelled = true
      socket?.close()
      resize?.disconnect()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [agentName, directory, workspaceId, ptyID, attempt])
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground border-border/60 order-last flex h-8 shrink-0 items-center gap-2 border-t px-2 text-[11px]">
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "Connected" ? "bg-emerald-500" : "bg-muted-foreground"
          )}
        />
        <span role="status" className="flex-1">
          {status}
        </span>
        <Button
          aria-label="Clear terminal"
          title="Clear terminal"
          size="icon-xs"
          variant="ghost"
          onClick={() => terminalRef.current?.clear()}
        >
          <Trash2 />
        </Button>
        <Button
          aria-label="Reconnect terminal"
          title="Reconnect terminal"
          disabled={status === "Connecting..."}
          size="icon-xs"
          variant="ghost"
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      <div
        ref={element}
        className="bg-background text-foreground min-h-0 flex-1 overflow-hidden p-2 font-mono [font-stretch:normal]"
      />
    </div>
  )
}
