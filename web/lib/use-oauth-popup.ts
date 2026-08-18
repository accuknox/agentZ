"use client"

import * as React from "react"
import {
  oauthBroadcastChannelName,
  oauthWindowMessageSource,
  parseOAuthPopupMessage,
  type OAuthPopupMessage,
} from "@/lib/mcp-oauth-shared"

type OAuthPopup = {
  flowId: string
  url: string
}

type OAuthPopupHandlers = {
  onError: (message: string) => void
  onSuccess: () => void
}

type OAuthPopupCleanup = {
  cancelPending?: boolean
  closePopup?: boolean
  resetState?: boolean
}

const popupFeatures = "popup=yes,width=520,height=760,resizable=yes,scrollbars=yes"

export function useOAuthPopup(windowNamePrefix: string) {
  const [flowId, setFlowId] = React.useState<string>()
  const activeFlowIdRef = React.useRef<string | undefined>(undefined)
  const handledFlowIdRef = React.useRef<string | undefined>(undefined)
  const popupRef = React.useRef<Window | null>(null)
  const popupPollRef = React.useRef<number | null>(null)
  const broadcastChannelRef = React.useRef<BroadcastChannel | null>(null)
  const messageHandlerRef = React.useRef<((event: MessageEvent<unknown>) => void) | null>(null)

  const cleanup = React.useCallback((options: OAuthPopupCleanup = {}) => {
    const handler = messageHandlerRef.current
    if (handler) {
      window.removeEventListener("message", handler)
      messageHandlerRef.current = null
    }

    broadcastChannelRef.current?.close()
    broadcastChannelRef.current = null

    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current)
      popupPollRef.current = null
    }

    if (options.closePopup && popupRef.current && !popupRef.current.closed) {
      popupRef.current.close()
    }
    popupRef.current = null
    activeFlowIdRef.current = undefined

    if (options.resetState !== false) {
      setFlowId(undefined)
    }

    if (options.cancelPending) {
      void fetch("/mcps/oauth/pending", {
        method: "POST",
        keepalive: true,
      }).catch(() => {})
    }
  }, [])

  React.useEffect(
    () => () => {
      cleanup({ closePopup: true, resetState: false })
    },
    [cleanup]
  )

  const open = React.useCallback(
    (oauth: OAuthPopup, handlers: OAuthPopupHandlers) => {
      if (handledFlowIdRef.current === oauth.flowId) {
        return
      }

      cleanup({
        cancelPending: activeFlowIdRef.current !== undefined,
        closePopup: true,
      })
      activeFlowIdRef.current = oauth.flowId
      handledFlowIdRef.current = oauth.flowId
      let completed = false

      function handlePopupMessage(data: unknown) {
        const message = parseOAuthPopupMessage(data)
        if (!message || message.kind !== "result" || message.flowId !== oauth.flowId) {
          return
        }

        completed = true
        const acknowledgement: OAuthPopupMessage = {
          source: oauthWindowMessageSource,
          kind: "ack",
          flowId: message.flowId,
        }
        broadcastChannelRef.current?.postMessage(acknowledgement)
        cleanup({ closePopup: true })

        if (message.status === "success") {
          handlers.onSuccess()
          return
        }
        handlers.onError(message.message)
      }

      function onWindowMessage(event: MessageEvent<unknown>) {
        if (event.origin === window.location.origin) {
          handlePopupMessage(event.data)
        }
      }

      messageHandlerRef.current = onWindowMessage
      window.addEventListener("message", onWindowMessage)

      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(oauthBroadcastChannelName)
        channel.onmessage = (event: MessageEvent<OAuthPopupMessage>) => {
          handlePopupMessage(event.data)
        }
        broadcastChannelRef.current = channel
      }

      const popup = window.open(oauth.url, `${windowNamePrefix}-${oauth.flowId}`, popupFeatures)
      if (!popup) {
        cleanup({ cancelPending: true })
        handlers.onError("OAuth popup was blocked by the browser. Allow popups and try again.")
        return
      }

      popupRef.current = popup
      setFlowId(oauth.flowId)
      popupPollRef.current = window.setInterval(() => {
        if (!popupRef.current?.closed || completed) {
          return
        }

        cleanup({ cancelPending: true })
        handlers.onError("OAuth popup was closed before authentication completed.")
      }, 400)
    },
    [cleanup, windowNamePrefix]
  )

  return { cleanup, flowId, open }
}
