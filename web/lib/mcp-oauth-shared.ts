import * as z from "zod"

export const oauthWindowMessageSource = "clawarmor:mcp-oauth"
export const oauthBroadcastChannelName = "clawarmor:mcp-oauth"

export const oauthPendingCookieBudget = 3000

export const oauthErrorFieldNames = ["oauth_client_id", "oauth_client_secret"] as const

export type OAuthErrorFieldName = (typeof oauthErrorFieldNames)[number]

const oauthPopupResultMessageSchema = z.object({
  source: z.literal(oauthWindowMessageSource),
  kind: z.literal("result"),
  flowId: z.string().min(1),
  status: z.enum(["success", "error"]),
  message: z.string(),
})

const oauthPopupAckMessageSchema = z.object({
  source: z.literal(oauthWindowMessageSource),
  kind: z.literal("ack"),
  flowId: z.string().min(1),
})

export type OAuthPopupMessage =
  | {
      source: typeof oauthWindowMessageSource
      kind: "result"
      flowId: string
      status: "success" | "error"
      message: string
    }
  | {
      source: typeof oauthWindowMessageSource
      kind: "ack"
      flowId: string
    }

export function parseOAuthPopupMessage(data: unknown) {
  const resultMessage = oauthPopupResultMessageSchema.safeParse(data)
  if (resultMessage.success) {
    return resultMessage.data satisfies Extract<OAuthPopupMessage, { kind: "result" }>
  }

  const ackMessage = oauthPopupAckMessageSchema.safeParse(data)
  if (ackMessage.success) {
    return ackMessage.data satisfies Extract<OAuthPopupMessage, { kind: "ack" }>
  }

  return undefined
}
