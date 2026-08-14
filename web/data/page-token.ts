import "server-only"

import type { z } from "zod"

export function encodePageToken<T>(cursor: T) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

export function decodePageToken<T extends z.ZodType>(
  schema: T,
  token?: string
): z.output<T> | undefined {
  if (!token) return
  return schema.parse(JSON.parse(Buffer.from(token, "base64url").toString()))
}
