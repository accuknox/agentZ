"use client"

import { useEffect, useRef, useState } from "react"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Plus, RefreshCw, TerminalSquare, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL, getGatewayToken } from "@/lib/gateway/browser-runtime"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import "@xterm/xterm/css/xterm.css"

type TerminalProps = {
  agentName: string
  sessionId: string
  directory: string
  workspaceId: string
}

export function CodingTerminal({ agentName, sessionId, directory, workspaceId }: TerminalProps) {
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
      const { data } = await client.pty.create(
        { directory, cwd: directory, title },
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error("Could not close terminal"),
  })
  return (
    <Tabs value={active?.id ?? ""} onValueChange={setSelected} className="h-full min-h-0 gap-0">
      <div className="flex shrink-0 items-center border-b px-2">
        <TabsList
          aria-label="Terminals"
          variant="line"
          className="h-auto! min-w-0 flex-1 justify-start overflow-x-auto"
        >
          {terminals.data?.map((pty, index) => (
            <div
              key={pty.id}
              className={cn(
                "flex shrink-0 items-center border-b-2",
                active?.id === pty.id ? "border-primary" : "border-transparent"
              )}
            >
              <TabsTrigger value={pty.id} className="h-10 px-2 text-xs">
                <TerminalSquare className="size-3.5" />
                Terminal {index + 1}
              </TabsTrigger>
              <Button
                aria-label={`Close terminal ${index + 1}`}
                title="End terminal session"
                size="icon-xs"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(pty.id)}
              >
                <X />
              </Button>
            </div>
          ))}
        </TabsList>
        <Button
          aria-label="New terminal"
          title="New terminal"
          size="icon-sm"
          variant="ghost"
          disabled={create.isPending}
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
      {terminals.data?.length === 0 ? (
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
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
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
}: Omit<TerminalProps, "sessionId"> & { ptyID: string }) {
  const element = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState("Connecting...")
  useEffect(() => {
    const container = element.current
    if (!container) return
    let cancelled = false
    let socket: WebSocket | undefined
    let resize: ResizeObserver | undefined
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "Geist Mono, monospace",
      theme: { background: "#111113", foreground: "#e4e4e7", cursor: "#e4e4e7" },
      scrollback: 10_000,
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data)
    })
    async function connect(container: HTMLDivElement) {
      setStatus("Connecting...")
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
    <div className="flex h-full min-h-0 flex-col bg-[#111113]">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-zinc-400">
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "Connected" ? "bg-emerald-400" : "bg-zinc-500"
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
          size="icon-xs"
          variant="ghost"
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      <div ref={element} className="min-h-0 flex-1 px-2 pb-2" />
    </div>
  )
}
