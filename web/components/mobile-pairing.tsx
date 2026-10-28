"use client"

import { useEffect, useState } from "react"
import QRCode from "react-qr-code"
import { Check, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { zMobilePairing } from "@/lib/gateway/client/zod.gen"
import type { MobilePairing as Pairing } from "@/lib/gateway/client"

export function MobilePairing({
  agentName,
  workspaceId,
}: {
  agentName: string
  workspaceId: string
}) {
  const [open, setOpen] = useState(false)
  const [pairing, setPairing] = useState<Pairing>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function create(resume = false) {
    setBusy(true)
    setError("")
    try {
      if (resume) {
        const query = new URLSearchParams({ workspace_id: workspaceId, agent_name: agentName })
        const saved = await fetch(`/api/mobile/pairing?${query}`)
        if (saved.status === 200) {
          setPairing(zMobilePairing.parse(await saved.json()))
          return
        }
        if (saved.status !== 204) throw new Error("Could not load this phone connection.")
      }
      const response = await fetch("/api/mobile/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, agent_name: agentName }),
      })
      if (!response.ok)
        throw new Error("Could not create the connection. Check that your agent is ready.")
      setPairing(zMobilePairing.parse(await response.json()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !pairing || pairing.status === "approved" || pairing.status === "revoked") return
    const controller = new AbortController()
    const interval = setInterval(() => {
      void fetch(`/api/mobile/pairing/${pairing.id}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Connection unavailable. Generate a new QR.")
          setPairing(zMobilePairing.parse(await response.json()))
        })
        .catch((cause: Error) => {
          if (!controller.signal.aborted) setError(cause.message)
        })
    }, 1500)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [open, pairing])

  async function approve() {
    if (!pairing) return
    setBusy(true)
    try {
      const response = await fetch(`/api/mobile/pairing/${pairing.id}`, { method: "PUT" })
      if (!response.ok) throw new Error("This request expired. Generate a new QR.")
      setPairing(zMobilePairing.parse(await response.json()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this phone.")
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    if (!pairing) return
    setBusy(true)
    try {
      const response = await fetch(`/api/mobile/pairing/${pairing.id}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Could not disconnect this phone. Try again.")
      setPairing(undefined)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect this phone.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!pairing) void create(true)
          }}
        >
          <Smartphone />
          Connect phone
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {pairing?.status === "approved" ? "Phone connected" : "Take your agent with you"}
          </DialogTitle>
          <DialogDescription>
            One conversation with {agentName}, on the web and your phone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!pairing && (
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? "Preparing your agent…" : "Generate QR code"}
          </Button>
        )}
        {pairing?.status === "pending" && (
          <>
            <div className="mx-auto rounded-xl bg-white p-5">
              <QRCode value={pairing.link} size={208} />
            </div>
            <p className="text-center text-sm text-muted-foreground">
              Open AgentZ on your phone and scan this QR.
              <br />
              This code expires in two minutes.
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Connect without a camera
              </summary>
              <p className="mt-2 break-all select-all">{pairing.link}</p>
            </details>
          </>
        )}
        {pairing?.status === "waiting" && (
          <>
            <p className="text-center text-sm">Check that your phone shows this exact code.</p>
            <p className="py-5 text-center font-mono text-4xl tracking-[0.25em]">{pairing.code}</p>
            <Button disabled={busy} onClick={() => void approve()}>
              The codes match. Connect phone.
            </Button>
            <Button variant="ghost" onClick={() => void revoke()}>
              Deny request
            </Button>
          </>
        )}
        {pairing?.status === "approved" && (
          <>
            <Check className="mx-auto my-6 size-12 text-primary" />
            <p className="text-center text-sm text-muted-foreground">
              Your phone can now talk to {agentName}.
            </p>
            <Button variant="outline" onClick={() => void revoke()}>
              Disconnect phone
            </Button>
          </>
        )}
        {(pairing?.status === "expired" || pairing?.status === "revoked") && (
          <Button disabled={busy} onClick={() => void create()}>
            Generate a new QR code
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
