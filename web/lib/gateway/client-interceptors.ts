"use client"

import { client } from "@/lib/gateway/client/client.gen"
import { GATEWAY_UNAUTHORIZED } from "@/lib/gateway/errors"
import { clientRedirectToLogin } from "@/lib/login-redirect"

// Client-side counterpart of the server interceptor in server-client.ts.
// instanceof is unreliable across the Server Action boundary, so match
// on the message instead.
client.interceptors.error.use((error) => {
  if (error instanceof Error && error.message === GATEWAY_UNAUTHORIZED) {
    clientRedirectToLogin()
  }
  return error
})
