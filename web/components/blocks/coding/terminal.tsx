"use client"

import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL, getGatewayToken } from "@/lib/gateway/browser-runtime"
import { Button } from "@/components/ui/button"
import "@xterm/xterm/css/xterm.css"

export function CodingTerminal({
  agentName,
  sessionId,
  directory,
  workspaceId,
}: {
  agentName: string
  sessionId: string
  directory: string
  workspaceId: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const closeTerminal = useRef<(() => Promise<void>) | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState("Connecting…")
  useEffect(() => {
    const container = element.current
    if (!container) return
    let cancelled = false
    let socket: WebSocket | undefined
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "var(--font-geist-mono), monospace",
      theme: { background: "#111113" },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    fit.fit()
    let resize: ResizeObserver | undefined
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data)
    })
    async function connect(container: HTMLDivElement) {
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
      closeTerminal.current = async () => {
        const result = await client.pty.remove({ ptyID, directory })
        if (result.error) {
          setStatus("Could not close terminal")
          return
        }
        socket?.close()
        setStatus("Closed")
      }
      const ticket = await client.pty.connectToken(
        { ptyID, directory },
        { headers: { "x-opencode-ticket": "1" } }
      )
      if (ticket.error) throw new Error("Could not connect terminal")
      const [base, token] = await Promise.all([getGatewayBaseURL(), getGatewayToken(workspaceId)])
      if (cancelled) return
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
        terminal.focus()
      }
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        // OpenCode sends terminal output as text and cursor metadata as binary.
        if (typeof event.data === "string") terminal.write(event.data)
      }
      socket.onclose = () => {
        if (!cancelled) setStatus("Disconnected")
      }
      socket.onerror = () => {
        if (!cancelled) setStatus("Connection failed")
      }
      resize = new ResizeObserver(() => {
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
      if (!cancelled)
        setStatus(error instanceof Error ? error.message : "Could not connect terminal")
    })
    return () => {
      cancelled = true
      closeTerminal.current = undefined
      socket?.close()
      resize?.disconnect()
      input.dispose()
      terminal.dispose()
    }
  }, [agentName, directory, sessionId, workspaceId, attempt])
  return (
    <div className="flex h-full min-h-72 flex-col bg-[#111113]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-zinc-400">
        <span>{status}</span>
        <Button size="sm" variant="ghost" onClick={() => void closeTerminal.current?.()}>
          Close terminal
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
          Reconnect
        </Button>
      </div>
      <div ref={element} className="min-h-0 flex-1 px-2 pb-2" />
    </div>
  )
}
