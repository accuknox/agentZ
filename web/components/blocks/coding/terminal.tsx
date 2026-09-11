"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL, getGatewayToken } from "@/lib/gateway/browser-runtime"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTheme } from "next-themes"
import { Spinner } from "@/components/ui/spinner"
import { Power, RotateCcw } from "lucide-react"
import "@xterm/xterm/css/xterm.css"

export function CodingTerminal({
  agentName,
  sessionId,
  directory,
  workspaceId,
  active,
  branch,
}: {
  agentName: string
  sessionId: string
  directory: string
  workspaceId: string
  active: boolean
  branch: string
}) {
  const { resolvedTheme } = useTheme()
  const view = useRef<Terminal>(null)
  const element = useRef<HTMLDivElement>(null)
  const closeTerminal = useRef<(() => Promise<void>) | undefined>(undefined)
  const [closing, startClosing] = useTransition()
  const [hasTerminal, setHasTerminal] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState("Connecting…")
  useEffect(() => {
    // next-themes applies the root class in its parent effect.
    const frame = requestAnimationFrame(() => {
      const container = element.current
      if (!container || !view.current) return
      const style = getComputedStyle(container)
      view.current.options.theme = {
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
        selectionBackground: resolvedTheme === "dark" ? "#ffffff30" : "#00000020",
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [resolvedTheme, attempt])
  useEffect(() => {
    if (active) view.current?.focus()
  }, [active])
  useEffect(() => {
    const container = element.current
    if (!container) return
    let cancelled = false
    let closed = false
    let socket: WebSocket | undefined
    const style = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: style.fontFamily,
      theme: {
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
      },
    })
    view.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)

    let resize: ResizeObserver | undefined
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data)
    })
    async function connect(container: HTMLDivElement) {
      // Canvas measurement needs a resolved font family and a loaded face.
      await document.fonts.load(`13px ${terminal.options.fontFamily}`)
      if (cancelled) return
      terminal.open(container)
      fit.fit()
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const title = `Coding · ${sessionId}`
      const listed = await client.pty.list({ directory })
      if (listed.error) throw new Error("Could not list terminals")
      if (cancelled) return
      let createdHere = false
      let pty = listed.data.find((item) => item.title === title && item.status === "running")
      if (!pty) {
        const created = await client.pty.create({ directory, cwd: directory, title })
        if (created.error) throw new Error("Could not start terminal")
        pty = created.data
        createdHere = true
      }
      if (cancelled) {
        if (createdHere) await client.pty.remove({ ptyID: pty.id, directory })
        return
      }
      const ptyID = pty.id
      setHasTerminal(true)
      closeTerminal.current = async () => {
        const result = await client.pty.remove({ ptyID, directory })
        if (result.error) {
          setStatus("Could not close terminal")
          return
        }
        closed = true
        socket?.close()
        setHasTerminal(false)
        setStatus("Closed")
      }
      const ticket = await client.pty.connectToken(
        { ptyID, directory },
        { headers: { "x-opencode-ticket": "1" } }
      )
      if (ticket.error) throw new Error("Could not connect terminal")
      const [base, token] = await Promise.all([getGatewayBaseURL(), getGatewayToken(workspaceId)])
      if (cancelled || closed) return
      const url = new URL(
        `${base}/api/opencode/${encodeURIComponent(agentName)}/pty/${encodeURIComponent(ptyID)}/connect`
      )
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("directory", directory)
      url.searchParams.set("ticket", ticket.data.ticket)
      socket = new WebSocket(url, ["agentz.pty", `agentz.bearer.${token}`])
      socket.binaryType = "arraybuffer"
      socket.onopen = () => {
        setStatus("Connected")
        if (container.checkVisibility()) terminal.focus()
      }
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        // OpenCode sends terminal output as text and cursor metadata as binary.
        if (typeof event.data === "string") terminal.write(event.data)
      }
      socket.onclose = () => {
        if (!cancelled && !closed) setStatus("Disconnected")
      }
      socket.onerror = () => {
        if (!cancelled && !closed) setStatus("Connection failed")
      }
      resize = new ResizeObserver(() => {
        if (!container.checkVisibility()) return
        fit.fit()
        void client.pty.update({
          ptyID,
          directory,
          size: { rows: terminal.rows, cols: terminal.cols },
        })
      })
      resize.observe(container)
    }
    void connect(container).catch((error: unknown) => {
      if (!cancelled && !closed)
        setStatus(error instanceof Error ? error.message : "Could not connect terminal")
    })
    return () => {
      cancelled = true
      closeTerminal.current = undefined
      socket?.close()
      resize?.disconnect()
      input.dispose()
      terminal.dispose()
      view.current = null
    }
  }, [agentName, directory, sessionId, workspaceId, attempt])
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={directory}>
          {branch}
        </span>
        <span role="status" className="flex items-center gap-1.5">
          {status === "Connecting…" ? <Spinner className="size-3" /> : null}
          {status === "Connected" ? (
            <span className="bg-primary size-1.5 rounded-full" aria-label="Connected" />
          ) : (
            status
          )}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close terminal"
              disabled={closing || !hasTerminal}
              onClick={() =>
                startClosing(async () => {
                  try {
                    await closeTerminal.current?.()
                  } catch {
                    setStatus("Could not close terminal")
                  }
                })
              }
            >
              <Power />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close terminal</TooltipContent>
        </Tooltip>
        {status !== "Connected" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={closing || status === "Connecting…"}
            onClick={() => {
              setHasTerminal(false)
              setStatus("Connecting…")
              setAttempt((value) => value + 1)
            }}
          >
            <RotateCcw />
            {status === "Closed" ? "New terminal" : "Reconnect"}
          </Button>
        ) : null}
      </div>
      <div className="bg-background min-h-0 flex-1 p-3">
        <div
          ref={element}
          className="bg-background text-foreground h-full min-w-0 overflow-hidden font-mono [font-stretch:normal]"
        />
      </div>
    </div>
  )
}
