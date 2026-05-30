export const oauthMaskedPlaceholder = "***"
export const oauthWindowMessageSource = "clawarmor:mcp-oauth"
export const oauthBroadcastChannelName = "clawarmor:mcp-oauth"

export type OAuthPopupMessage =
  | {
      source: typeof oauthWindowMessageSource
      kind: "result"
      success: boolean
      flowId?: string
      message: string
    }
  | {
      source: typeof oauthWindowMessageSource
      kind: "ack"
      flowId: string
    }
