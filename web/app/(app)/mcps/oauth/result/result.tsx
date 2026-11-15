"use client"

import { useEffect } from "react"
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import {
  oauthBroadcastChannelName,
  oauthWindowMessageSource,
  parseOAuthPopupMessage,
  type OAuthPopupMessage,
} from "@/lib/mcp-oauth-shared"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type OAuthResultProps = Omit<
  Extract<OAuthPopupMessage, { kind: "result" }>,
  "source" | "kind" | "flowId"
> & {
  flowId?: string
}

export function OAuthResult({ status, flowId, message, warning }: OAuthResultProps) {
  useEffect(() => {
    if (!flowId) return
    const payload = {
      source: oauthWindowMessageSource,
      kind: "result",
      flowId,
      status,
      message,
      warning,
    } satisfies OAuthPopupMessage
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(oauthBroadcastChannelName)
        : null
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const data = parseOAuthPopupMessage(event.data)
        if (data?.kind !== "ack" || data.flowId !== flowId) return
        channel.close()
        window.close()
      }
      channel.postMessage(payload)
    }
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin)
      if (!channel) window.close()
    }
    return () => channel?.close()
  }, [flowId, status, message, warning])

  const success = status === "success"
  const Icon = success ? CircleCheck : CircleAlert
  return (
    <div className="flex w-full max-w-md flex-col gap-5">
      <Alert variant={success ? "info" : "destructive"}>
        <Icon aria-hidden="true" />
        <AlertTitle>{success ? "Connection complete" : "Connection failed"}</AlertTitle>
        <AlertDescription>
          {message ||
            (success ? "You can close this window." : "Start the connection again to retry.")}
        </AlertDescription>
      </Alert>
      {warning ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
